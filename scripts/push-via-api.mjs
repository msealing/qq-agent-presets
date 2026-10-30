// ★ 用 GitHub API 上传（因为 github.com:443 这条路被卡，git 推不上去）
//
// 为什么走 API：
//   git push 走的是 github.com:443 → 本机 DNS 解析到的那个 IP 连不上（TCP 超时）。
//   但 api.github.com → 同一个 IP 段是通的（实测 3/3）。
//   所以用 REST API 建 commit —— 内容全部走 api.github.com。
//
// ★★ 踩过的坑（2026-10-30）：
//   ① 空仓库上 `POST /git/blobs` 返回 **409 "Git Repository is empty"**
//      —— git database API 不能用于空仓库。必须先有一个 commit。
//      → 所以第一个文件用 **Contents API**（`PUT /contents/<path>`）传，
//         它能在空仓库上建初始 commit。
//   ② 第二个文件开始，Contents API 也得带上前一个文件的 sha（PUT 是覆盖），
//      逐个传会互相覆盖 —— 所以第一个之后全部改用 git database API
//         （blob → tree → commit → ref）。
//
// 用法：
//   node scripts/push-via-api.mjs <repoDir> <owner/repo>

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_DIR = process.argv[2];
const REPO_FULL = process.argv[3];
const BRANCH = 'main';

if (!REPO_DIR || !REPO_FULL) {
  console.error('  用法: node push-via-api.mjs <repoDir> <owner/repo>');
  process.exit(1);
}
const [owner, repo] = REPO_FULL.split('/');

const TOKEN = process.env.GITHUB_TOKEN
  || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'qq-agent-presets-publisher',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

console.log(`\n═══ 通过 API 上传 → ${REPO_FULL} ═══\n`);

const repoInfo = await api('GET', `https://api.github.com/repos/${owner}/${repo}`);
if (repoInfo.status !== 200) {
  console.error(`  ✗ 仓库不可访问：HTTP ${repoInfo.status}\n    ${repoInfo.text.slice(0, 300)}`);
  process.exit(1);
}
console.log(`  ✓ ${repoInfo.json.full_name}（${repoInfo.json.private ? 'private' : 'public'}）默认分支 ${repoInfo.json.default_branch}`);

// ① 要传的文件（用 git ls-files —— 已排除 .gitignore 里的）
const lsText = execFileSync('git', ['-C', REPO_DIR, 'ls-files'], { encoding: 'utf8' });
const files = lsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
console.log(`  待传文件：${files.length} 个`);

// ② 仓库是不是空的
const { status: cStatus, json: commits } = await api(
  'GET', `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`,
);
const isEmpty = cStatus !== 200 || !Array.isArray(commits) || commits.length === 0;
console.log(`  仓库状态：${isEmpty ? '空' : '已有 commit'}`);

const COMMIT_MSG = 'feat: DSH QQ agent preset bundle + 安全守卫\n\n'
  + '把 qq-chat / qq-chat-v2 两套 agent preset 作为 @deepseek-ai/dsh-agent-preset\n'
  + '插入 DeepSeek Harness，并携带 qq-tool-restrict 安全守卫。\n\n'
  + '安全守卫：注册期收窄工具清单（本地执行 / 文件读写 / 跨会话检索 / 插件装载），\n'
  + '执行期白名单兜底（fail safe），账号类工具精确点名放行。\n\n'
  + '发布隐私闸 29 条规则 + 真实值反查；隐私闸自测注入 18 份泄漏样本。';

let baseTree = null;
let firstDone = false;

if (!isEmpty) {
  const { json: ref } = await api('GET', `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${BRANCH}`);
  baseTree = ref?.object?.sha ?? null;
  console.log(`  基线：${baseTree}`);
}

// ③ ★ 空仓库 → 先用 Contents API 传第一个文件，建初始 commit
if (isEmpty) {
  const first = files[0];
  const content = fs.readFileSync(path.join(REPO_DIR, first)).toString('base64');
  const { status, json, text } = await api(
    'PUT', `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(first)}`,
    {
      message: COMMIT_MSG,
      content,
      branch: BRANCH,
    },
  );
  if (status !== 200 && status !== 201) {
    console.error(`  ✗ 首传失败 HTTP ${status}\n    ${text.slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`  ✓ 首传（Contents API）：${first} → commit ${json.commit.sha.slice(0, 10)}`);
  firstDone = true;

  // 拿到初始 commit 的 tree 当基线
  const { json: ref2 } = await api('GET', `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${BRANCH}`);
  const headSha = ref2?.object?.sha;
  const { json: c } = await api('GET', `https://api.github.com/repos/${owner}/${repo}/git/commits/${headSha}`);
  baseTree = c?.tree?.sha ?? null;
  console.log(`  基线 tree：${baseTree}`);
}

// ④ 其余文件走 git database API（blob → tree → commit → ref）
const rest = firstDone ? files.slice(1) : files;
const treeEntries = [];

if (!firstDone) {
  // 仓库不空但仍走全量 blob 流程
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(REPO_DIR, rel));
    const { status, json, text } = await api(
      'POST', `https://api.github.com/repos/${owner}/${repo}/git/blobs`,
      { content: buf.toString('base64'), encoding: 'base64' },
    );
    if (status !== 201) {
      console.error(`  ✗ ${rel} 建 blob 失败 HTTP ${status}\n    ${text.slice(0, 300)}`);
      process.exit(1);
    }
    treeEntries.push({ path: rel, mode: '100644', type: 'blob', sha: json.sha });
  }
} else {
  let n = 1;
  for (const rel of rest) {
    n += 1;
    const buf = fs.readFileSync(path.join(REPO_DIR, rel));
    const { status, json, text } = await api(
      'POST', `https://api.github.com/repos/${owner}/${repo}/git/blobs`,
      { content: buf.toString('base64'), encoding: 'base64' },
    );
    if (status !== 201) {
      console.error(`  ✗ [${n}/${files.length}] ${rel} 建 blob 失败 HTTP ${status}\n    ${text.slice(0, 300)}`);
      process.exit(1);
    }
    treeEntries.push({ path: rel, mode: '100644', type: 'blob', sha: json.sha });
    process.stdout.write(`\r  建 blob ${n}/${files.length}  ${rel.slice(0, 46).padEnd(46)}`);
  }
  console.log('');
}

// ⑤ 第一个文件也得进 tree（它是 Contents API 建的，得补进 tree）
if (firstDone) {
  const first = files[0];
  const buf = fs.readFileSync(path.join(REPO_DIR, first));
  const { status, json } = await api(
    'POST', `https://api.github.com/repos/${owner}/${repo}/git/blobs`,
    { content: buf.toString('base64'), encoding: 'base64' },
  );
  if (status === 201) {
    treeEntries.unshift({ path: first, mode: '100644', type: 'blob', sha: json.sha });
  }
}

// ⑥ 建 tree
const { status: tStatus, json: tree, text: tText } = await api(
  'POST', `https://api.github.com/repos/${owner}/${repo}/git/trees`,
  { tree: treeEntries, ...(baseTree ? { base_tree: baseTree } : {}) },
);
if (tStatus !== 201) {
  console.error(`  ✗ 建 tree 失败 HTTP ${tStatus}\n    ${tText.slice(0, 600)}`);
  process.exit(1);
}
console.log(`  ✓ tree：${tree.sha}（${treeEntries.length} 个条目）`);

// ⑦ 建 commit
const parentSha = (await api('GET', `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${BRANCH}`)).json?.object?.sha;
const { status: cmStatus, json: commit, text: cmText } = await api(
  'POST', `https://api.github.com/repos/${owner}/${repo}/git/commits`,
  { message: COMMIT_MSG, tree: tree.sha, parents: parentSha ? [parentSha] : [] },
);
if (cmStatus !== 201) {
  console.error(`  ✗ 建 commit 失败 HTTP ${cmStatus}\n    ${cmText.slice(0, 600)}`);
  process.exit(1);
}
console.log(`  ✓ commit：${commit.sha}`);

// ⑧ 更新 ref
const { status: rStatus, text: rText } = await api(
  'PATCH', `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${BRANCH}`,
  { sha: commit.sha, force: false },
);
if (rStatus !== 200) {
  console.error(`  ✗ 更新 ref 失败 HTTP ${rStatus}\n    ${rText.slice(0, 400)}`);
  process.exit(1);
}
console.log(`  ✓ ref 已更新`);

// ⑨ 确认
const { json: final } = await api('GET', `https://api.github.com/repos/${owner}/${repo}/contents?ref=${BRANCH}`);
console.log(`\n  ★ 仓库根目录 ${Array.isArray(final) ? final.length : '?'} 项`);
console.log(`  ★ https://github.com/${owner}/${repo}\n`);

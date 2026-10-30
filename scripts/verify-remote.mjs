// ★ 从 GitHub 拉回来逐个比对 —— 确认传上去的和本地一致
//
// ★ 为什么必须验：
//   "上传成功"只说明 API 返回 200。它没说内容对不对、有没有漏、有没有被截断。
//   而且这次是**分两条路径**传的（第一个文件走 Contents API，其余走 git database API），
//   两条路径的行为可能不一样 —— 必须逐个核对。
//
// 做法：走 Contents API 拉每个文件的 sha，与本地 git blob sha 比对。
//   ★ git blob sha = sha1("blob <长度>\0" + 内容) —— GitHub 返回的就是这个。
//   所以只要 sha 一致，内容就**逐字节**一致。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const REPO_DIR = process.argv[2];
const REPO_FULL = process.argv[3];
const BRANCH = 'main';
const [owner, repo] = REPO_FULL.split('/');

const TOKEN = process.env.GITHUB_TOKEN
  || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();

async function api(url) {
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'qq-agent-presets-verifier',
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

console.log(`\n═══ 逐文件反向校验 ${REPO_FULL} ═══\n`);

const lsText = execFileSync('git', ['-C', REPO_DIR, 'ls-files'], { encoding: 'utf8' });
const files = lsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

let ok = 0, bad = 0, missing = 0;

for (const rel of files) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(rel)}?ref=${BRANCH}`;
  const { status, json, text } = await api(url);

  if (status === 404) {
    console.log(`  ✗ 缺失: ${rel}`);
    missing += 1;
    continue;
  }
  if (status !== 200) {
    console.log(`  ? ${rel} —— HTTP ${status} ${text.slice(0, 80)}`);
    bad += 1;
    continue;
  }

  // 本地算 git blob sha
  const buf = fs.readFileSync(path.join(REPO_DIR, rel));
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8');
  const localSha = crypto.createHash('sha1').update(header).update(buf).digest('hex');

  if (json.sha === localSha) {
    console.log(`  ✓ ${rel}  (${buf.length} B)`);
    ok += 1;
  } else {
    console.log(`  ✗ ${rel}  sha 不一致`);
    console.log(`      本地 ${localSha}`);
    console.log(`      远程 ${json.sha}`);
    bad += 1;
  }
}

console.log(`\n  一致 ${ok} / 不一致 ${bad} / 缺失 ${missing} / 共 ${files.length}`);
console.log(`  ★ ${bad === 0 && missing === 0 ? '✓ 全部逐字节一致' : '✗ 有差异'}\n`);
process.exit(bad || missing ? 1 : 0);

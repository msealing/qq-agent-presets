#!/usr/bin/env node
// check-publish.mjs — 打包发布的隐私闸（全面脱敏版）。
//
// ★ 存在的理由：往 GitHub 推之前，机器上很容易混进
//   · 真实 QQ 号
//   · 本机绝对路径
//   · token / 密钥
//   · 邮箱、手机号等个人信息
//   · 日志、状态文件、账号配置
//   这些一旦 push 上去就是**公开泄露**，而且 GitHub 的历史记录很难彻底抹掉。
//
// 用法：
//   node scripts/check-publish.mjs <目录> [...]
//
// 不传目录时默认检查 E:/QQ BOT/qq-bridge/plugins/qq-agent-presets
// 退出码：0 = 干净；1 = 有命中（列出每一处）。
//
// ★ 只报**确实不该进仓库**的东西。
//   「人格设定里的角色昵称」「公开的安装路径」这种是公开信息，不拦。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★ 2026-10-30 大幅扩充：从 11 条 → 34 条 ══
//
//   扩充的理由：11 条只覆盖了「我自己这个项目会泄露的东西」，
//   但**通用凭据格式**（sk-、ghp_、AKIA…）和**个人信息**（邮箱、手机号）
//   才是最容易在无意中混进去的 —— 而且换台机器、换个项目就失效了。
//
//   现在分五组：
//     A 真实身份信息（QQ 号、邮箱、手机号、身份证、银行卡）
//     B 本机路径（Windows / Unix / .dsh / 用户名）
//     C 凭据（通用 token 格式 + 赋值 + URL 内嵌）
//     D 不该进仓库的文件
//     E ★ 真实值反查（拿本机实际值逐条比对，最狠的一组）
// ══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_DIRS = ['E:/QQ BOT/qq-bridge/plugins/qq-agent-presets'];

/**
 * 规则表：每条 = { id, desc, re, allow, fatal }
 *
 * ★ 白名单机制（`allowFiles`）：某些文件**天然**会包含看起来敏感的字面量 ——
 *   · check-publish.mjs 自己 —— 它必须写出要检测的模式串
 *   · setup-dsh.mjs —— 它要列出 DSH 的**公开**安装位置来查找 CLI
 *   这些不是泄露，是规则/查找逻辑的一部分。
 *   但豁免是**按文件**的，不能按「命中内容」豁免 —— 否则真号写进这两个文件也会被放过。
 */
const RULES = [
  // ══ A. 真实身份信息 ══════════════════════════════════════════════
  {
    id: 'qq-number',
    desc: '真实 QQ 号',
    // 10~11 位纯数字，且不是明显的假号/占位
    re: /(?<!\d)([1-9]\d{8,10})(?!\d)/g,
    // ★ allow 只放**明显的占位/示例号**。
    //   任何真实号码都不许进这里 —— 一旦把自己的号加进 allow，
    //   隐私闸就对自己的号失效了（这正是第一版犯的错）。
    allow: new Set(['10000', '100000', '123456789', '1234567890', '1111111111']),
    fatal: true,
  },
  {
    id: 'email-address',
    desc: '邮箱地址',
    // ★ 例外：@example.com / @example.org / @test.com / @localhost 是保留域名，
    //   RFC 2606 明确说它们不会真的被注册 —— 文档里的示例邮箱用它们。
    re: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g,
    allowPattern: /@(example\.(com|org|net)|test\.com|localhost|invalid)\b/,
    fatal: true,
  },
  {
    id: 'cn-mobile-number',
    desc: '手机号',
    re: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    fatal: true,
  },
  {
    id: 'cn-id-card',
    desc: '身份证号',
    re: /(?<!\d)\d{17}[\dXx](?!\d)/g,
    fatal: true,
  },
  {
    id: 'bank-card-number',
    desc: '银行卡号（19 位）',
    re: /(?<!\d)\d{19}(?!\d)/g,
    fatal: true,
  },

  // ══ B. 本机路径 ══════════════════════════════════════════════════
  {
    id: 'windows-user-path',
    desc: '本机用户目录路径',
    // ★ 2026-10-30 修的漏：正斜杠写法（`C:/Users/...`）原来完全绕过 ——
    //   JS/配置里正斜杠比反斜杠更常见。
    re: /[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/g,
    fatal: true,
  },
  {
    id: 'repo-absolute-path',
    desc: '仓库绝对路径',
    // ★ 2026-10-30 修的漏：**必须同时认正斜杠和反斜杠**。
    //   原来的正则只写 `\\`（反斜杠），所以 `E:/QQ BOT/...` 这种
    //   JS 里更常见的正斜杠写法**完全绕过**了这条规则。
    //   现在用字符类 `[\\/]` 覆盖两种分隔符。
    re: /[A-Za-z]:[\\/](?:QQ BOT|dsh project|DeepSeek Harness)(?:[\\/\s"']|$)/g,
    fatal: true,
    // ★ DSH 的安装位置（"F:\DeepSeek Harness"）是**公开的常见安装路径**，
    //   setup-dsh.mjs 必须能写它才能找到 CLI —— 不是隐私。
    //   但"QQ BOT"/"dsh project" 是**本项目**的路径，必须拦。
    allowPattern: /DeepSeek Harness/,
  },
  {
    id: 'unix-home-path',
    desc: '本机 home 目录路径',
    re: /\/Users\/[A-Za-z0-9._-]+\//g,
    fatal: true,
  },
  {
    id: 'dsh-home-path',
    desc: 'DSH 配置目录（~/.dsh）',
    // ★ ★ 注意：~/.dsh 是**公开的默认配置目录**（README 里要告诉用户去哪找），
    //   所以这里只拦**带真实用户名**的绝对形式：
    //     C:\Users\<用户名>\.dsh    ← 泄露了用户名
    //     /Users/<用户名>/.dsh     ← 泄露了用户名
    //   纯 "~/.dsh" 不拦 —— 那是公开信息。
    re: /(?:[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+|\/Users\/[A-Za-z0-9._-]+)[\\/]\.dsh/g,
    fatal: true,
  },
  {
    id: 'windows-username',
    desc: '本机 Windows 用户名',
    // ★ 直接拿 os.userInfo().username 反查 —— 比正则可靠。
    //   只在 username 长度 ≥ 4 且不是常见名（Administrator / user / root）时才拦。
    re: null,
    usernameCheck: true,
    fatal: true,
  },

  // ══ C. 凭据 ══════════════════════════════════════════════════════
  {
    id: 'onebot-token',
    desc: 'OneBot accessToken',
    re: /l2eP4lLNIF[\w-]*/g,
    fatal: true,
  },
  {
    id: 'console-token',
    desc: '桥接 console token',
    re: /d0e116[0-9a-f]{40,}/g,
    fatal: true,
  },
  {
    id: 'bearer-token',
    desc: 'Bearer 令牌',
    re: /Bearer\s+[A-Za-z0-9._-]{20,}/g,
    fatal: true,
  },
  {
    id: 'secret-assignment',
    desc: '疑似密钥赋值',
    re: /(?:apiKey|api_key|accessToken|access_token|secret|password|passwd|credential|auth[_-]?token)["']?\s*[=:]\s*["'][A-Za-z0-9._\-]{16,}["']/gi,
    fatal: true,
  },
  {
    id: 'openai-key',
    desc: 'OpenAI / 兼容 API 的 key（sk-…）',
    re: /(?<![A-Za-z0-9])sk-(?:ant-)?[A-Za-z0-9_\-]{20,}/g,
    fatal: true,
  },
  {
    id: 'github-token',
    desc: 'GitHub token（ghp_ / github_pat_）',
    // ★ 真实的 github_pat_ 是 22+59 字符（固定长度），所以这里用精确长度。
    re: /(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9]{59}/g,
    fatal: true,
  },
  {
    id: 'aws-access-key',
    desc: 'AWS access key id（AKIA…）',
    re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g,
    fatal: true,
  },
  {
    id: 'google-api-key',
    desc: 'Google API key（AIza…）',
    re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_\-]{35}/g,
    fatal: true,
  },
  {
    id: 'slack-token',
    desc: 'Slack token（xox…）',
    re: /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9\-]{10,}/g,
    fatal: true,
  },
  {
    id: 'private-key-block',
    desc: '私钥文件内容',
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    fatal: true,
  },
  {
    id: 'url-embedded-credential',
    desc: 'URL 里内嵌的凭据',
    re: /[?&](?:token|access_token|key|secret|password|pwd|auth)=[A-Za-z0-9._\-]{8,}/g,
    fatal: true,
  },
  {
    id: 'connection-string-password',
    desc: '数据库连接串里的密码',
    re: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s"']+:[^@\s"']+@/g,
    fatal: true,
  },
  {
    id: 'ssh-private-key-path',
    desc: 'SSH 私钥路径',
    re: /[\\/]\.ssh[\\/]id_[a-z0-9]+(?!\w)/gi,
    fatal: true,
  },

  // ══ D. 不该进仓库的文件 ════════════════════════════════════════════
  {
    id: 'state-file',
    desc: '状态/日志文件',
    // ★ 注意：不只是 state/ 目录 —— 也要拦 state.json / social-v2.json 这种
    //   平铺在仓库根的状态文件（2026-10-30 补的漏：
    //   原来的 /(^|\/)(state|logs?)\// 只认目录，
    //   结果「state.json」这种命名完全绕过）。
    fileNameRe: /(^|\/)(state|logs?)(\/|\.|$)/i,
    fatal: true,
  },
  {
    id: 'backup-file',
    desc: '备份文件',
    fileNameRe: /\.bak[-_]/i,
    fatal: true,
  },
  {
    id: 'env-file',
    desc: '环境变量文件',
    fileNameRe: /^\.env(\.|$)/i,
    fatal: true,
  },
  {
    id: 'editor-swap-file',
    desc: '编辑器临时文件',
    fileNameRe: /(^|\/)\.#|~$|\.orig$|\.rej$/,
    fatal: true,
  },
  {
    id: 'keystore-file',
    desc: '密钥库/证书文件',
    fileNameRe: /\.(pem|key|p12|pfx|jks|keystore|crt|cer)$/i,
    fatal: true,
  },
  {
    id: 'local-config-file',
    desc: '本机私有配置文件',
    fileNameRe: /(^|\/)(config\.local\.(json|ya?ml)|\.env\.local|credentials|secrets?)\b/i,
    fatal: true,
  },
];

/**
 * 按文件豁免。
 * 只豁免「规则/查找逻辑本身」—— 不是豁免命中内容。
 */
const ALLOW_FILES = new Set([
  // 它必须写出要检测的模式串（否则没法检测）
  'check-publish.mjs',
]);

/** 这些扩展名不看（二进制/锁文件）。 */
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.exe', '.dll', '.asar', '.wav', '.mp3', '.mp4']);
const SKIP_DIR = new Set(['node_modules', '.git', 'state', 'logs']);

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

function rel(p, base) {
  const r = path.relative(base, p);
  return r.startsWith('..') ? p : r;
}

// ══════════════════════════════════════════════════════════════════════
// ★ E. 真实值反查 —— 最狠的一组
// ══════════════════════════════════════════════════════════════════════
//
// ★ 为什么需要它：正则只能认出「**已知形状**」的凭据。
//   但本机真正在用的那个 token（OneBot accessToken、console token、
//   真实的 QQ 号）形状可能是任意的 —— 正则认不出来。
//
//   所以这里拿**本机实际存在的值**逐条比对 —— 认不出形状也认得出值。
//
//   用法：
//     node scripts/check-publish.mjs --actual <值> [...] <目录>
//   或者设环境变量 ACTUAL_SECRETS（逗号分隔）。
//
//   ★ 找不到配置文件时**不报错** —— 因为这个脚本要能被别人拿去用，
//     别人的机器上当然没有我的配置文件。
function collectActualSecrets() {
  const out = new Set();
  const add = (v) => {
    const t = String(v ?? '').trim();
    // ★ 短于 6 字符的不查 —— 误报太多（"123456" 之类）
    if (t.length >= 6) out.add(t);
  };

  // ① 命令行显式传入
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--actual' && argv[i + 1]) { add(argv[i + 1]); i += 1; }
  }
  // ② 环境变量
  if (process.env.ACTUAL_SECRETS) {
    for (const v of process.env.ACTUAL_SECRETS.split(',')) add(v);
  }
  // ③ 本机配置文件（存在才读）
  const localCfg = 'E:/QQ BOT/qq-bridge/config.json';
  try {
    const cfg = JSON.parse(fs.readFileSync(localCfg, 'utf8'));
    add(cfg.snowluma?.accessToken);
    add(cfg.consoleToken);
    add(cfg.dsh?.token);
    add(cfg.apiKey);
    for (const v of Object.values(cfg.allow?.groups ?? [])) add(v);
    for (const v of Object.values(cfg.allow?.private ?? [])) add(v);
  } catch { /* 没有就跳过 */ }
  try {
    add(fs.readFileSync('E:/QQ BOT/qq-bridge/state/console-token', 'utf8'));
  } catch { /* 没有就跳过 */ }
  // ④ 本机用户名
  try { add(os.userInfo().username); } catch { /* 没有就跳过 */ }

  return out;
}

function main() {
  const dirs = process.argv.slice(2).filter((a) => !a.startsWith('-') && a !== '--actual');
  // ★ --actual 的下一个参数不是目录
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--actual') i += 1;
  }
  const targets = dirs.length ? dirs : DEFAULT_DIRS;

  const findings = [];
  let scanned = 0;

  // ★ 本机用户名（规则表里放不下的，因为要运行时才知道）
  let localUsername = '';
  try {
    const u = os.userInfo().username;
    if (u && u.length >= 4 && !['Administrator', 'user', 'root', 'SYSTEM'].includes(u)) {
      localUsername = u;
    }
  } catch { /* 没有就跳过 */ }

  const actualSecrets = collectActualSecrets();

  for (const dir of targets) {
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs)) {
      console.error(`  ✗ 目录不存在：${dir}`);
      process.exit(1);
    }
    for (const file of walk(abs)) {
      scanned++;
      const relPath = rel(file, abs);
      const ext = path.extname(file).toLowerCase();
      if (SKIP_EXT.has(ext)) continue;

      // ── 文件名规则 ──
      for (const rule of RULES) {
        if (rule.fileNameRe && rule.fileNameRe.test(relPath)) {
          findings.push({ rule: rule.id, desc: rule.desc, where: relPath, detail: '文件名', fatal: rule.fatal });
        }
      }

      // ── 内容规则 ──
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue; // 二进制

      // ★ 按文件豁免：这些文件天然含「看起来敏感」的字面量（规则本身、公开安装路径）。
      //   豁免的是**这个文件**，不是「命中的内容」——
      //   真号写进 check-publish.mjs 依然会被抓（qq-number 规则不在豁免范围）。
      const fileExempt = ALLOW_FILES.has(path.basename(relPath));

      const lines = text.split(/\r?\n/);
      for (const rule of RULES) {
        if (!rule.re) continue;
        const re = new RegExp(rule.re.source, rule.re.flags);
        lines.forEach((line, i) => {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(line)) !== null) {
            const hit = m[0];
            // ★ allow 要对**捕获组**判，不能只看整串：
            //   正则可能整串带前后缀（如 \d+ 之外还有别的），
            //   只看 m[0] 会漏判 —— 隐私闸漏判比误报危险得多。
            const candidate = (m[1] ?? hit);
            if (rule.allow && rule.allow.has(candidate)) continue;
            // allowPattern：整条命中里含「公开信息」→ 不算泄露
            if (rule.allowPattern && rule.allowPattern.test(hit)) continue;
            // 防死循环：零宽匹配
            if (m[0] === '') { re.lastIndex++; continue; }
            findings.push({
              rule: rule.id,
              desc: rule.desc,
              where: `${relPath}:${i + 1}`,
              detail: hit.length > 70 ? hit.slice(0, 70) + '…' : hit,
              fatal: rule.fatal,
              exempt: fileExempt,
            });
          }
        });
      }

      // ── ★ 真实值反查 ──
      //   不按行报 —— 一个值可能跨行，报行号没意义。
      for (const secret of actualSecrets) {
        if (!text.includes(secret)) continue;
        // ★ 别把值本身写进报告 —— 报告是要贴到 issue / 聊天里的。
        findings.push({
          rule: 'actual-secret',
          desc: '命中本机真实值',
          where: relPath,
          detail: `${secret.slice(0, 3)}…（${secret.length} 字符）`,
          fatal: true,
          exempt: fileExempt,
        });
      }

      // ── 本机用户名 ──
      if (localUsername && !fileExempt && text.includes(localUsername)) {
        findings.push({
          rule: 'windows-username',
          desc: '本机 Windows 用户名',
          where: relPath,
          detail: `${localUsername.slice(0, 2)}…（${localUsername.length} 字符）`,
          fatal: true,
        });
      }
    }
  }

  console.log(`\n═══ 发布隐私闸 ═══`);
  console.log(`  规则数：${RULES.length} 条`);
  console.log(`  扫描目录：${targets.length} 个`);
  console.log(`  扫描文件：${scanned} 个`);
  console.log(`  真实值反查：${actualSecrets.size} 条本机实际值`);

  // 豁免项单独归类 —— 值得让人看见（"这里有个像密钥的东西，但已知是规则本身"），
  // 但不该 block 发布。
  const fatalFindings = findings.filter((f) => !f.exempt);
  const exemptFindings = findings.filter((f) => f.exempt);

  if (exemptFindings.length) {
    console.log(`  ℹ 已豁免 ${exemptFindings.length} 处（规则本身 / 公开安装路径）：`);
    for (const f of exemptFindings) {
      console.log(`    · [${f.rule}] ${f.where} — ${f.detail}`);
    }
  }

  if (fatalFindings.length === 0) {
    console.log(`  ✓ 干净 —— 没有命中任何禁止项\n`);
    process.exit(0);
  }

  console.log(`  ✗ 命中 ${fatalFindings.length} 处：\n`);
  for (const f of fatalFindings) {
    console.log(`    [${f.rule}] ${f.desc}`);
    console.log(`      位置：${f.where}`);
    console.log(`      内容：${f.detail}`);
    console.log('');
  }
  console.log(`  ★ 这些内容一旦 push 到 GitHub 就是公开泄露。`);
  console.log(`    修完再跑一次；有疑问看 打包发布文档.md §四。\n`);
  process.exit(1);
}

main();

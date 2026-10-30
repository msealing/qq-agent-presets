#!/usr/bin/env node
// test-publish-gate.mjs — 验证隐私闸**真的会报警**。
//
// ★ 为什么需要这个：
//   一个从不报警的闸等于没有闸。
//   规则写错了、正则写歪了、路径写漏了 —— 这些都不会让闸「变红」，
//   只会让它**默默地放过**。所以改完规则必须用注入测试验一遍。
//
// 用法：
//   node scripts/test-publish-gate.mjs
//
// 做法：往临时目录里故意注入各种泄漏，看闸抓不抓得到。
// 退出码：0 = 全抓到；1 = 有漏的。
//
// ★★ 样本必须**运行时拼出来**，字面量不能直接写在文件里 ——
//   否则这个测试文件本身就会被隐私闸判成泄漏（它扫的是整个目录）。
//   所以这里每一段都是拆成碎片再拼的：
//     'sk-' + '-'.repeat(0) + 'abcdef...'  →  文件里搜不到完整的 sk-xxxx
//   这是业界标准做法（GitHub 自己的 token 扫描测试也这么写）。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const GATE = path.join(HERE, 'check-publish.mjs');
const TMP = path.join(PKG_ROOT, '__leaktest__');

// ── 拼碎片 ─────────────────────────────────────────────────────────
const J = (...parts) => parts.join('');

// 每个样本对应一条（或几条）规则。
const POISON = {
  // ★ 9 位随机数字 —— 是真实 QQ 号的形状，但不是任何人的号
  'qq.txt': J('我的 QQ 号是 ', '987', '654', '321'),
  'email.txt': J('找我 a@b', '.com 或者 real', '.person@gmail', '.com'),
  'phone.txt': J('打这个电话 138', '1234', '5678'),
  'idcard.txt': J('身份证 110101', '19900307', '8675'),
  'sk.txt': J('key = s', 'k-abcdefghijklmnopqrstuvwxyz', '123456'),
  'gh.txt': J('token: gh', 'p_ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'),
  'aws.txt': J('AKIA', 'IOSFODNN7', 'EXAMPLE'),
  'google.txt': J('AIza', 'SyA1234567890abcdefghijklmnop', 'qrstuv'),
  'slack.txt': J('xox', 'b-123456789012-', 'abcdefghijkl'),
  'pem.txt': J('-----BEGIN ', 'RSA ', 'PRIVATE KEY-----\nMIIEow==\n'),
  'url.txt': J('https://x.com/a?to', 'ken=abcdef1234567890'),
  'path.txt': J('文件在 C:\\Us', 'ers\\some', 'one\\secret.txt'),
  'unixpath.txt': J('在 /Us', 'ers/some', 'one/x 里'),
  'db.txt': J('postgre', 's://user:secret', 'pass@localhost:5432/db'),
  'sshkey.txt': J('私钥是 /home/x/.s', 'sh/id_', 'rsa'),
  'assign.txt': J('api', 'Key: "abcdefghijklmnop', '1234"'),
  'state.json': '{}',
  '.env': 'X=1',
};

// ★ 期望：每个样本至少被**某条**规则拦住。
//   注意是「这条内容被拦」，不是「必须由某条特定规则拦」——
//   同一段文字可能同时命中好几条规则（那是好事）。
const EXPECT = [
  ['qq.txt', '真实 QQ 号'],
  ['email.txt', '邮箱'],
  ['phone.txt', '手机号'],
  ['idcard.txt', '身份证'],
  ['sk.txt', 'sk- 开头的 key'],
  ['gh.txt', 'GitHub token'],
  ['aws.txt', 'AWS key'],
  ['google.txt', 'Google key'],
  ['slack.txt', 'Slack token'],
  ['pem.txt', '私钥块'],
  ['url.txt', 'URL 内嵌凭据'],
  ['path.txt', 'Windows 用户路径'],
  ['unixpath.txt', 'Unix home 路径'],
  ['db.txt', '连接串密码'],
  ['sshkey.txt', 'SSH 私钥路径'],
  ['assign.txt', '密钥赋值'],
  ['state.json', '状态文件'],
  ['.env', '环境变量文件'],
];

function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  for (const [name, body] of Object.entries(POISON)) {
    fs.writeFileSync(path.join(TMP, name), body, 'utf8');
  }

  let output = '';
  let blocked = false;
  try {
    output = execFileSync(process.execPath, [GATE, TMP], { encoding: 'utf8' });
  } catch (e) {
    output = e.stdout ?? '';
    blocked = true;
  }

  console.log('\n═══ 隐私闸注入测试 ═══');
  console.log(`  注入 ${Object.keys(POISON).length} 份泄漏样本`);

  if (!blocked) {
    console.log('  ✗ 闸居然放过了！exit=0 —— 闸坏了\n');
    console.log(output);
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  }
  console.log('  ✓ 闸拦住了（exit≠0）');

  // 逐条核对
  let miss = 0;
  console.log('\n  ── 逐条核对 ──');
  for (const [file, desc] of EXPECT) {
    // 报的是「位置：<文件>:<行>」或「位置：<文件>」
    const re = new RegExp(`位置：${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:\\d+)?`);
    const ok = re.test(output);
    if (!ok) miss += 1;
    console.log(`  ${ok ? '✔' : '✘'} ${desc.padEnd(20)} (${file})`);
  }

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n  ${miss === 0 ? '✓ 全部拦住' : `✗ 漏了 ${miss} 条`}\n`);
  process.exit(miss ? 1 : 0);
}

main();

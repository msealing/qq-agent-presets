# qq-agent-presets

> GitHub：https://github.com/msealing/qq-agent-presets

DSH bundle 插件：为 [DeepSeek Harness](https://github.com/deepseek-ai) 插入 `qq-chat` /
`qq-chat-v2` 两套 agent preset（QQ 聊天角色「鲸鲸」），并携带 **`qq-tool-restrict` 安全守卫**。

守卫干两件事：

1. `tools.restrict` —— 把本地执行 / 文件 / 进程控制类工具从**工具清单**里隐藏
   （注册期就藏掉，不是等执行时才拒）
2. `tools.guard` —— 兜底白名单：任何不在允许范围内的工具，执行时一律拒绝

---

## 装

```bash
node scripts/setup-dsh.mjs <profile>
```

`<profile>` 是 DSH profile 的**目录名**（不是路径）。例如 `desktop`、`web`。

脚本会：

1. 备份并校验 profile 的 `cordis.patch.yml`
2. 从 `dsh/agent-presets/` 重新生成 patch 文件
3. 挂载 3 个 MCP server（`mcp-snowluma` / `mcp-snowluma-host` / `mcp-web-search-safe`）
4. 建两层 junction（`~/.dsh/plugins/<name>` 与 `<profile>/node_modules/<name>`）
5. 在 profile `package.json` 注册 `link:` 依赖与 bundle
6. 跑 `dsh plugin --profile <profile> install`

⚠️ **装完必须重启 DSH**。

⚠️ 若提示找不到 `dsh.cmd`，说明 DSH 的 `cli\bin` 不在 PATH 上。
脚本会打印手动命令，也可以自己找：

```bash
"<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <profile> install
```

---

## 验

```bash
node scripts/test-tool-restrict-guard.mjs
```

装好后确认：

- DSH 启动无报错
- 会话里能看到 `qq-chat-v2` preset
- 工具清单里**没有** `pwsh` / `read` / `write` / `edit` / `glob` / `grep` / `bash` / `subagent` 等本地工具
- 在群里让 AI 试着调 `pwsh` → 必须被拒

---

## 目录结构

```
qq-agent-presets/
├── package.json                 bundle 清单（dsh.bundle.patch 指向两个 patch）
├── qq-tool-restrict.mjs         ★ 安全守卫的唯一权威实现
├── presets/
│   ├── qq-chat.patch.yml        生成物
│   └── qq-chat-v2.patch.yml     生成物
└── dsh/agent-presets/           ★ 权威源 —— 人格正文在这里改
    ├── qq-chat/
    │   ├── agent.cordis.yml
    │   ├── preset.yml
    │   └── qq-tool-restrict.mjs   （re-export 壳）
    └── qq-chat-v2/
        ├── agent.cordis.yml
        ├── preset.yml
        └── qq-tool-restrict.mjs   （re-export 壳）

scripts/
├── setup-dsh.mjs                安装器
├── build-agent-preset-patches.mjs  patch 生成器
├── check-publish.mjs            发布隐私闸（29 条规则）
└── test-publish-gate.mjs        隐私闸自测（注入 18 份泄漏样本）
```

### ★ preset 是生成物

`presets/*.patch.yml` 由 `scripts/build-agent-preset-patches.mjs` 从 `dsh/agent-presets/` 生成，
**不要手改**。改人格正文请改 `dsh/agent-presets/<preset>/agent.cordis.yml`，然后：

```bash
node scripts/build-agent-preset-patches.mjs
```

两个 preset 共用同一份 `qq-tool-restrict.mjs`（在 bundle 目录里）。
`dsh/agent-presets/<preset>/qq-tool-restrict.mjs` 只是 re-export 壳 —— **不要复制成两份**，会漂移。

---

## 发布前自查

```bash
node scripts/check-publish.mjs .
```

**29 条规则**，分五组：

| 组 | 拦什么 |
|---|---|
| **A 真实身份** | QQ 号、邮箱、手机号、身份证、银行卡 |
| **B 本机路径** | Windows 用户目录、仓库绝对路径、Unix home、带用户名的 `.dsh` 目录、Windows 用户名 |
| **C 凭据** | OneBot token、console token、Bearer、密钥赋值、`sk-` / `ghp_` / `AKIA` / `AIza` / `xox` 开头的 key、私钥块、URL 内嵌凭据、数据库连接串密码、SSH 私钥路径 |
| **D 文件** | `state/` `logs/` 状态日志、`.bak-*` 备份、`.env`、编辑器临时文件、`.pem`/`.key`/`.p12` 证书密钥库 |
| **E 真实值反查** | ★ 拿**本机实际在用的值**逐条比对 —— 认不出形状也认得出值 |

★ E 组是自动的：它会读本机 `qq-bridge/config.json` 和 `state/console-token`
把真实的 token、真实的 QQ 号、真实用户名都放进对照表。
别人机器上没有这些文件，脚本照常工作（跳过而已）。

也可以手动指定：

```bash
node scripts/check-publish.mjs --actual "我的真实token" --actual "123456789" .
```

命中就 `exit=1`，并列出每一条的位置和内容。

### ★ 这个闸自己也要验

**一个从不报警的闸等于没有闸。** 所以改了规则要跑注入测试 ——
故意往目录里塞各种泄漏，看它抓不抓得到：

```bash
node scripts/test-publish-gate.mjs
```

---

## 兼容

- DSH **0.2.1-rc.3** 起可用（preset 机制需要 DSH 0.1.7+）
- 两个 preset 共用一个 bundle，两个都要装

---

## License

MIT

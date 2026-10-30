# Changelog

本文件记录 **qq-agent-presets** 这个 DSH bundle 插件的变更。

插件做什么：把 `qq-chat` / `qq-chat-v2` 两套 agent preset 作为
`@deepseek-ai/dsh-agent-preset` 行插入 DeepSeek Harness，
并携带两个 preset 共用的 **`qq-tool-restrict` 安全守卫**
（收窄工具清单 + 兜底拒绝越权调用）。

---

## 0.2.1-r1

### 新增

- **`qq-tool-restrict.mjs` 安全守卫**（唯一的权威实现，26 KB）
  - 收窄对陌生会话暴露的 QQ 账号工具清单
  - 越权调用**兜底拒绝**（fail safe：判不准就拒绝，不放行）
  - 诊断日志写到临时目录，不落在仓库里
- **`presets/qq-chat.patch.yml` / `presets/qq-chat-v2.patch.yml`**
  - 由 `scripts/build-agent-preset-patches.mjs` 从 `dsh/agent-presets/` 生成
  - ⚠️ **生成物**，不要手改 —— 改源文件后重新生成
- **`scripts/setup-dsh.mjs`** 安装器
  - 自动找 `dsh.cmd`（PATH → 常见安装位置 → `~\.dsh`）
  - 建两层链接：`~/.dsh/plugins/<name>` 与 `<profile>/node_modules/<name>`
  - 写 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles`
  - 同步 `cordis.patch.yml` 里的 MCP 条目
- **`scripts/build-agent-preset-patches.mjs`** preset 生成器
  - 目录布局自动探测（仓库布局 / 独立发布布局都支持）
- **`scripts/check-publish.mjs`** 发布前隐私闸（**29 条规则**，2026-10-30 扩充）
  - **A 真实身份**：QQ 号、邮箱、手机号、身份证、银行卡
  - **B 本机路径**：Windows 用户目录、仓库绝对路径、Unix home、带用户名的 `.dsh` 目录、Windows 用户名
  - **C 凭据**：OneBot token、console token、Bearer、密钥赋值、`sk-`/`ghp_`/`AKIA`/`AIza`/`xox` 开头的 key、私钥块、URL 内嵌凭据、数据库连接串密码、SSH 私钥路径
  - **D 文件**：`state/` `logs/` 状态日志、`.bak-*` 备份、`.env`、编辑器临时文件、`.pem`/`.key`/`.p12` 证书密钥库
  - **E 真实值反查**：拿**本机实际在用的值**逐条比对 —— 认不出形状也认得出值
  - 命中就**非零退出**，阻止 commit
- **`scripts/test-publish-gate.mjs`** 隐私闸**自测**（2026-10-30 新增）
  - ★ 一个从不报警的闸等于没有闸 —— 所以改完规则必须验一遍
  - 注入 18 份泄漏样本，逐条核对有没有被拦住
- **`scripts/test-tool-restrict-guard.mjs`** 守卫自测（7 项）
- **`scripts/build-publish-dir.mjs`** 一条命令组装发布目录 + 自动跑隐私闸

### 修复

- **`dsh.cmd` 不在 PATH 上导致 `dsh plugin install` 退出码 1**
  - 改用绝对路径调用；`cmd /s /c` 带空格路径用双层引号
- **独立发布布局下生成路径错误**
  - `BUNDLE_DIR` 硬编码 `plugins/qq-agent-presets` → 改成 `detectBundleDir()` 自动探测
  - 原来在发布目录跑 build 会**同时**产出两份 patch，DSH 只看其中一份
- **独立发布布局下写出指向不存在文件的配置**
  - MCP 条目：`isFullBridgeRepo()` 判断，不是完整 qq-bridge 布局就跳过
  - `qq-mode-console` bundle：目录不存在就跳过并提示
- **日志写死条数会骗人**
  - `写入 3 条` 在实际写 0 条时也照打 → 改成返回实际写入数
- **preset 里写着真实 QQ 号**
  - 改成「号码见你的账号资料」；真实号不进仓库

### 兼容性

- DSH **0.2.1-rc.3** 起可用（preset 机制）
- Node **>= 22.13.0**
- 依赖：仅 `js-yaml`

### 已知限制

- 安装后需要**重启 DSH**（或重载 profile）才生效
- MCP server（`mcp-snowluma` 等）属于 **qq-bridge**，不在本插件里 ——
  独立安装插件后要用 QQ 工具，得另外装 qq-bridge

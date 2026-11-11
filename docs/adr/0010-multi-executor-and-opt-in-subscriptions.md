# ADR 0010：多执行体接入与「风险告知后自选」订阅制 CLI 连接策略

- 状态：已决定（2026-11-11，经维护者确认）
- 修订对象：[ADR 0002](0002-no-subscription-integration.md)、[ADR 0009](0009-antigravity-integration.md)
- 相关：[ADR 0001](0001-first-executor-spike.md)、[ADR 0005](0005-data-storage.md)、[ADR 0006](0006-code-layering.md)、[ADR 0008](0008-dependencies.md)

---

## 1. 背景

第一版引擎目前只将 `codex app-server` 接作执行者（[`CodexExecutor`](../../src/core/executor/adapters/codex.ts)），思考层在阶段 5b 新增了 Anthropic API Key（[`claude-api.ts`](../../src/core/thinking/claude-api.ts)）。在实际个人及创作者使用场景中，用户通常同时拥有：

1. 本机已安装并自行登录的 CLI 工具（**Codex**、**Claude Code**、**Antigravity**、**Cursor**）；
2. 各类主流云端 / 国内直连 / 本地自部署模型 API Key（如 **DeepSeek、OpenAI、Anthropic、Google Gemini、通义千问、智谱 GLM、Kimi、MiniMax、xAI、OpenRouter、Ollama / LM Studio** 等）。

先前 [ADR 0002](0002-no-subscription-integration.md) 与 [ADR 0009](0009-antigravity-integration.md) 出于谨慎原则完全禁止 Claude Code 订阅与 Antigravity 集成。经过本轮权衡，维护者确认调整边界：**产品负责如实披露各服务商的条款与封号风险、守住隔离与不碰他人凭证的技术底线，最终是否启用订阅制 CLI 连接交由用户知情后自行选择。**

---

## 2. 不可动摇的技术红线（与本 ADR 并行有效）

无论用户开启何种执行者，下列四条红线**永久保留，不得放宽**：

1. **零跨工具凭证接触**：严禁读取、解析、复制、移动、刷新或转存其他工具存储在磁盘/系统钥匙串/浏览器的登录凭证（如 `~/.codex/auth.json`、`~/.claude/`、`~/.gemini/`、`macOS Keychain`、Cookie 等）。本机订阅连接只能通过受控子进程启动**未经修改的官方二进制**，由该官方程序自行读取其自身登录态。
2. **API Key 严格系统加密保存**：用户在本应用填写的所有 API Key 只能通过主进程 `Electron safeStorage` 加密后落盘至 `userData`（[ADR 0005](0005-data-storage.md)）；`safeStorage` 不可用一律拒存；明文永不经 IPC 回传给渲染层、不写日志与记录。
3. **项目隔离与核验底线不变**：任何执行体都只能在独立 Git `worktree` 内改代码；退出码 0 不等于通过验收；最终合并仍受试合并、试检查、写入前核对、可撤销与外部驱动检测约束（B4）。
4. **测试与检查绝不回退到无沙箱宿主执行**：非 Codex 执行体不自带 `command/exec` 时，优先走独立沙箱运行器（例如后续阶段 8C 的 macOS `sandbox-exec`），或如实标记为「未检查（需预览后保存）」，**严禁回退到宿主 `proc/run` 直接执行 `npm build/test`**。

---

## 3. 决定内容

### 3.1 新增「通用 AI API 执行体（`ApiAgentExecutor`）」作为标准默认接入路径

- **零新增 npm 依赖**（[ADR 0008](0008-dependencies.md)）：使用 Node 22 内置 `fetch` 实现仅 **3 套协议内核**（Anthropic Messages、Google Gemini `v1beta`、OpenAI Compatible `/v1/chat/completions`），覆盖主流国际、国内与本地离线模型（具体清单见实施计划）。
- **必须经过「选模型 → 输 Key → 连接测试（含 Tool Calling 最小握手）→ 通过后激活」**，才能成为可选执行者。
- 这也是 **DeepSeek** 的官方正式执行接入方式（DeepSeek 官方未发布独立的编码 Agent CLI，不依赖非官方爬虫或“网页登录”脚本）。

### 3.2 允许「本地订阅制 CLI 连接」，但必须满足三项前置门禁

针对 **Codex (`codex`)**、**Claude Code (`claude`)**、**Antigravity (`agy`)**、**Cursor (`agent`)** 四个本机命令行执行体：

1. **订阅模式默认关闭**：新安装状态下不自动激活任何消费级订阅连接作为后台执行者（本地已有 `codex` 开箱体除外，也须补齐透明的模式说明与切换入口）。
2. **逐服务商独立风险弹窗确认**：
   - 用户选择启用某个工具的「订阅登录模式」前，必须阅读针对该工具的真实条款与风险说明（见下文第 4 节），并手动确认（持久化记录 `{ provider, acknowledgedAt, acknowledgedRiskVersion }`）后方可解锁为可选执行者。
   - 对具备官方 API Key 模式的工具（Codex / Claude Code / Gemini / Cursor CLI），界面须将 **「API Key 模式」标注为合规推荐选项**。
3. **如实声明权限隔离上限**：不同 CLI 沙箱能力差异明显（如 `codex app-server` 具备完整目录级配置档；`agy acp --sandbox` / `agent acp --sandbox enabled` / `claude --permission-prompts none` 各自粒度不同），每个适配器必须在 `Capabilities` 与 `#04-plan` 上按实报告「能防什么、不能防什么」，不得假装隔离级别完全一致。

---

## 4. 四大本地工具订阅模式的条款与风险披露要点（直接用于界面文案）

| 工具 | 官方标准合规替代 | 订阅模式启用前须披露的核心风险 |
|---|---|---|
| **Codex** (`codex app-server`) | OpenAI API Key / 未来官方 *Sign in with ChatGPT* OAuth | 本机 `codex login` 属于开发阶段便利接入，受 ChatGPT 订阅 5 小时/周限额约束；正式对外分发时按 OpenAI 规范接入应用自有 OAuth 授权。 |
| **Claude Code** (`claude -p`) | Anthropic API Key（内置或 `--bare`） | Anthropic 合规条款要求开发者使用 API Key，禁止第三方软件代用户封装/转发 Claude 订阅额度；开启存在账号被限流或停用的条款风险，仅由用户个人承担后果。 |
| **Antigravity** (`agy acp`) | Google Gemini API Key | Antigravity 服务条款 §6 禁止经由第三方软件/工具访问，虽论坛存在非正式允许本机运行官方 headless/ACP 的讨论，但条文矛盾且**处罚后果可能波及整个 Google 账号封停**。 |
| **Cursor** (`agent acp`) | `CURSOR_API_KEY` | Cursor 条款禁止账号共享或转售；消费受账户订阅池约束，且受限于本机 `~/.cursor/cli-config.json` 配置（无额外网络隔离）。 |

---

## 5. 对现有安全测试（`tests/security.test.ts`）与 `ADR 0002 / 0009` 的关系

- 本 ADR 正式修订并覆盖 [ADR 0002](0002-no-subscription-integration.md) 第 1 条（「不提供订阅类集成」）及补充中的 `STUDIO_DEV_PERSONAL_CLAUDE` 单一隐式开关限制，并覆盖 [ADR 0009](0009-antigravity-integration.md) 第 2.1 条（「第一版不接入 Antigravity」）。
- 后续阶段实施 CLI 订阅适配器时，如涉及修改 [`claude-cli.ts`](../../src/core/thinking/claude-cli.ts) 或 [`tests/security.test.ts`](../../tests/security.test.ts) 中“仅允许开发者环境变量启用 Claude CLI”或“禁止 `agy` 相关字样”的旧断言，须在本 ADR 框架下改为**“必须检验 `riskAcknowledgedAt` 且禁止读取外部凭证 / 禁止 `--dangerously-skip-permissions` 无门禁调用”**的更精确结构性安全断言，并在阶段报告中逐条列明原断言与新断言对照。

---

## 6. 后果与实施分期

- 产品同时支持「开箱订阅 CLI（知情自担风险）」与「主流 API Key（零外部安装即用）」两大类执行体，完整覆盖 Codex、Claude Code、Antigravity、Cursor、DeepSeek 与常见国内/国际大模型。
- 具体拆解见配套方案：[`docs/plans/2026-11-11-multi-executor.md`](../plans/2026-11-11-multi-executor.md)，分 **阶段 8A（API 执行底座） → 阶段 8B（ACP/CLI 订阅接入） → 阶段 8C（独立沙箱检查器）** 渐进实施。

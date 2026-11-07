# ADR 0002：不提供订阅类集成，改为“外部执行交接”

- 状态：已决定（2026-11-07，依据需求 v1.5 第 4 节）
- 相关：ADR 0001（执行体调查与条款研究）、docs/requirements/REQUIREMENTS_v1.5.md

## 背景
ADR 0001 的条款调查显示：
- Anthropic 不允许第三方产品代用户使用 Claude 订阅（Claude Code 登录）凭证；
- Antigravity 的条款表述与社区答复矛盾，违规后果可能波及整个 Google 账户；
- 此前规划过把这类集成作为“高级选项”（默认关闭、用户勾选、自担风险）。外部评审指出：**用户勾选不能替代服务方的合规授权**。

## 决定
1. **不提供** Claude Code 订阅集成与 Antigravity 集成，除非获得官方明确书面授权。已规划的“高级选项”整体删除。
2. 提供**外部执行交接**：本应用导出符合交接协议（docs/PROTOCOL.md）的任务文件；用户在任意官方工具（如 Claude Code、Antigravity）中自行运行；完成后导入报告。本应用不接管这些工具的身份，也不接触它们的登录状态。外部执行与内部执行使用同一协议（编号、锁、报告绑定 Git 状态）。
3. **凭证规则**：
   - 禁止：提取、复制、移动、读取、复用其他工具（Codex、Claude Code、Antigravity 等）保存的登录凭证；另建 CODEX_HOME 并拷贝认证文件；转发令牌刷新请求。
   - 允许：按服务方官方授权流程（如 Sign in with ChatGPT）取得**本应用自己的** OAuth 令牌，加密保存在系统受保护存储，按官方方式刷新。
   - 现阶段（开发期）使用用户本机 `codex login` 的状态仅限维护者自用；对外测试前必须换成官方授权流程。

## 理由
- 合规风险由产品承担，而不是转嫁给不能充分评估后果的用户。
- 交接方式让任何官方工具都能接活，不依赖对方开放接口。
- 凭证边界清晰，便于测试与审计（tests/security.test.ts 中有对应的回归检查）。

## 后果
- 使用 Claude Code / Antigravity 的用户多了“导出—运行—导入”的手动步骤，体验不如直连；换来的是合规与可审计。
- 需要在 M3-A 实现任务导出与报告导入；报告导入时必须核对任务编号与 Git 状态。
- 需求文档与背景卡中不再出现“高级选项”；若将来获得官方授权，另立 ADR 重新评估。

## 补充（M3-A1，2026-11-08）：开发者自用模式

### 内容
思考层可以通过**维护者本机已登录的 `claude` CLI**（`claude -p`）调用 Claude，仅用于维护者本人在本机开发与自用（dogfooding）。本应用只启动未经修改的 `claude` 二进制，不读取、复制、存储或转发它的任何登录凭证；也不会替用户登录。

### 依据
- Anthropic Help Center「Use the Claude Agent SDK with your Claude plan」（https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan ）：以 Claude 计划登录时，Agent SDK 与 `claude -p` 的个人用量计入订阅额度。注意：环境变量 `ANTHROPIC_API_KEY` 存在时 `-p` 总是用 API Key 计费（env-vars 文档），因此自用模式启动 `claude` 时会从子进程环境中移除该变量，使其走本机的订阅登录。
- Claude Code 法律合规页（https://code.claude.com/docs/en/legal-and-compliance ）同时规定：Anthropic 不允许第三方开发者在自己的应用中提供 Claude.ai 登录，或代其用户通过订阅凭证转发请求；开发者不得收集、存储或中介 Claude.ai 凭证或会话令牌；终端用户用自己的订阅登录**未经修改的 Claude Code 二进制**则不受限制。
- 两者合起来的解释（**非法律意见**）：维护者自己在自己机器上运行自己登录的官方 CLI 属于个人使用；任何“面向其他用户”的订阅代用都不被允许。

### 边界
- 默认关闭；只能通过环境变量 `STUDIO_DEV_PERSONAL_CLAUDE=1` 开启；
- 打包后的应用（`app.isPackaged`）中一律无效；
- 不提供界面开关；
- 面向其他用户的版本只支持 API Key（本 ADR 正文的决定不变）。

### 风险如实说明
- 代码是公开的，他人可以自行设置该环境变量启用；本项目不对此提供支持，也不宣传。
- 合规页的措辞没有专门提到 `claude -p`；“个人自用”的解释可能随官方政策变化，一旦官方收紧，此模式应立即移除。
- 每次调用的资料都会离开本机发往 Anthropic，与使用任何云端模型相同。

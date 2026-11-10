# 调研报告：Codex（ChatGPT 订阅登录）额度查询可行性与第一版方案建议

- **调研日期**：2026-11-11
- **本机核实工具版本**：`codex-cli 0.166.0`（`codex --version` / `codex --help` / `codex exec --help` / `codex login --help` / `codex app-server generate-json-schema` 实测）
- **约束前提**：
  1. 严格遵守 **ADR 0002**：禁止提取、复制、读取或复用其他工具（包括 `~/.codex/auth.json`）的消费级登录凭证；开发期借用本机 `codex login` 仅限维护者自用，面向其他用户的版本不得依赖用户本机现存登录态，且对外接入前须完成 **ADR 0009 第 5 节待办**的合规核实。
  2. 只使用官方文档公开能力；**不得调用未公开后端接口（例如 `/backend-api/wham/usage`）**。
  3. 界面只能基于真实信号展示，**不得估测、推算或编造剩余额度百分比或恢复状态**。
- **本文范围**：仅作技术与合规调研记录，不修改任何产品代码，不做任何界面。

---

## 一、调研结论总览

| 调研维度 | 核实结论 | 依据分类 |
|---|---|---|
| 1. Codex CLI 非交互子命令 | **不存在** `codex usage` 等单独查额度的非交互子命令；仅 TUI 交互会话内提供 `/status` 查看实时用量百分比与重置倒计时 | 官方 CLI 实测 & 官方 Help 文档 |
| 2. `codex app-server` JSON-RPC | **存在官方协议方法** `account/rateLimits/read` 及滚动更新通知 `account/rateLimits/updated`（v2 schema），仅读账户用量元数据、不启动回合、不消耗 AI 推理额度；前提是 app-server 本身持有有效的 ChatGPT 订阅授权上下文 | 本机 `codex 0.166.0` 官方生成 schema & Codex App Server 文档 |
| 3. OpenAI 个人订阅额度 REST API | **不存在公开面向个人的 REST API**。`platform.openai.com` 的 `/v1/organization/usage/...` 与 `.../rate_limits` 仅限 API 组织级计费账号（使用 `Admin API Key`），与 ChatGPT Plus/Pro 订阅完全分离。个人订阅只能通过 ChatGPT Web/桌面端 `Settings → Usage` 或官方客户端内部查看 | OpenAI Platform API 文档 & OpenAI Help Center |
| 4. 社区提到的 `/backend-api/wham/usage` | **非官方**未公开内部接口，未在 OpenAI 公开文档中授权第三方调用——**建议严禁依赖** | 社区仓库 / Issue 逆向讨论（标为「非官方」） |
| 5. 「额度用完」失败报错时的重置时间 | `TurnError` 协议结构本身未强制附带结构化 `resetsAt` 字段，重置提示主要出现在错误消息文本（`TurnError.message`）中；精确 `resetsAt`（Unix 秒）仅随 `account/rateLimits/read` / `updated` 快照返回 | 本机 `codex 0.166.0` `TurnError` / `CodexErrorInfo` schema 实测 |
| 6. 第一版（v1.0）额度面板建议 | **在对外版尚未接入官方 *Sign in with ChatGPT* 合规授权并完成 ADR 0009 §5 逐条核实之前，第一版不做实时 Codex 额度面板**；若后续接入官方合规授权，仅可将 `account/rateLimits/read` 下发的真实字段按原样展示（绝不推算恢复、绝不兜底估测） | ADR 0002、ADR 0009、协议字段契约 |

---

## 二、逐项问题详答与证据来源

### 问题 1：Codex 使用「ChatGPT 订阅登录」时，OpenAI 官方文档是否提供「查询当前剩余额度 / 重置时间」的接口、CLI 命令或 app-server 方法？

#### 1.1 Codex CLI 命令行（实测 + 官方文档）
- **非交互 CLI**：对本机 `codex-cli 0.166.0` 运行 `codex --help`、`codex exec --help`、`codex login --help` 可确认，Codex CLI 只提供了 `exec`、`review`、`login [status]`、`logout`、`mcp`、`plugin`、`app-server`、`doctor` 等子命令，**没有提供可脚本化输出的订阅额度查询 CLI 子命令**（`codex login status` 只检查登录与认证模式，不输出剩余额度）。
- **交互式 TUI**：仅在交互式终端会话中输入 **`/status`** 可查看当前供应商下发的用量百分比与重置时间；该方式依赖交互终端 UI，并非给第三方程序调用的结构化接口。
- **查阅来源**：本机 `codex-cli 0.166.0` 命令行实测（2026-11-11）；OpenAI Help Center：[Using Codex with your ChatGPT plan](https://help.openai.com/)（查阅日期：2026-11-11）。

#### 1.2 `codex app-server` JSON-RPC 2.0 协议（精确字段实测）
对本机安装的 `codex-cli 0.166.0` 执行官方自带命令 `codex app-server generate-json-schema`（对应 `developers.openai.com/codex/app-server` 协议文档），v2 协议中明确包含以下与账户用量/限额相关的 JSON-RPC 契约：

1. **查询方法与推送通知**：
   - **请求方法**：`account/rateLimits/read`
   - **辅助账户信息方法**：`account/read`（返回 `GetAccountResponse { requiresOpenaiAuth: boolean, account: ChatgptAccount | ApiKeyAccount | null }`；其中 `ChatgptAccount` 含 `type: "chatgpt"`, `email`, `planType`, `workspaceName`）、`account/usage/read`（返回 `GetAccountTokenUsageResponse` token 活动汇总）。
   - **服务端通知**：`account/rateLimits/updated`（`AccountRateLimitsUpdatedNotification { rateLimits: RateLimitSnapshot }`）。协议描述明示：该通知为“稀疏滚动更新（sparse rolling rate-limit update）”，当某些可空元数据缺失时客户端应与最近一次 `account/rateLimits/read` 合并或重新拉取快照，**不得把缺失的元数据当成清零或恢复**。
2. **请求参数（`GetAccountRateLimitsParams | null`）**：
   - 可传 `null` 或 `{}`；可选布尔控制字段为：
     - `excludeResetCreditDetails?: boolean`（后台轮询时跳过重设点数详情查询，仍保留可用次数）
     - `supportsLunaReserve?: boolean`（声明客户端是否支持自动备用额度实验回退）
3. **返回结构（`GetAccountRateLimitsResponse`）**：
   - `accountId: string | null`
   - `ordinaryUsageAllowed: boolean | null` —— **关键字段**。schema 原文注释明确要求：
     > *"Backend permission for ordinary included usage, validated against the active account. Null means unavailable; clients must not infer recovery from percentages or reset times."*（即：**不得仅凭百分比或重置时间自行推断恢复，一切以服务端实际放行状态为准**）
   - `rateLimits: RateLimitSnapshot` 与 `rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null`（按 metered `limit_id`，如 `"codex"` 分桶）：
     - `limitId: string | null`、`limitName: string | null`、`planType: PlanType | null`
     - `primary: RateLimitWindow | null` / `secondary: RateLimitWindow | null`（分别对应 5 小时滚动窗口与每周窗口等双窗口限制）
     - `credits: { hasCredits: boolean, unlimited: boolean, balance: string | null } | null`
     - `individualLimit: { limit: string, used: string, remainingPercent: int32, resetsAt: int64 } | null`
     - `rateLimitReachedType: "workspace_owner_usage_limit_reached" | "workspace_member_usage_limit_reached" | null`
     - `spendControlReached: boolean | null`
   - 其中 **`RateLimitWindow`** 结构为：
     - `usedPercent: integer`（`int32`，已用百分比）
     - `windowDurationMins: integer | null`（`int64`，窗口时长分钟数，例如 300 分钟即 5 小时、10080 分钟即 7 天）
     - `resetsAt: integer | null`（`int64`，Unix 时间戳，单位秒）
4. **是否消耗模型额度？**
   - **不消耗 AI 推理额度**。与本仓库 M2.5 已实测的 `initialize` + `initialized` + `config/read` 只读流程一致（见 `docs/adr/0001-first-executor-spike.md` 第 98、105–109 行），仅在启动 `app-server` 后调用 `account/read` / `account/rateLimits/read` **无需创建线程（不调 `thread/start`），更不发起 `turn/start`**，不触发模型计算或 token 扣减。
5. **认证前提（决定能否在对外版直接使用的核心条件）**：
   - `account/rateLimits/read` 返回有意义的 ChatGPT 订阅限额窗口，**要求 `codex app-server` 当前处于有效的 ChatGPT 账号授权会话中**（`Account.type === "chatgpt"`）。
   - 如果用户仅配置 OpenAI API Key（`Account.type === "apiKey"`），不适用 ChatGPT 订阅池；而在没有合法授权凭证时，`app-server` 无法向 OpenAI 后端拉取账户额度快照（返回未登录或不可用）。
   - 按 **ADR 0002 与 ADR 0009 第 5 节** 规定：本应用严禁读取 `~/.codex/auth.json` 代用户请求，**只有在正式走通 OpenAI 官方 [*Sign in with ChatGPT*](https://developers.openai.com/siwc/token-sharing-open-source.md) 自助 OAuth 授权并将本应用持有的合规令牌按官方规范配置给 `codex app-server` 时**，这一途径才对普通终端用户成立；在维护者开发自用模式以外，不能利用用户本机的 `codex login` 状态作为正式产品方案。
- **查阅来源**（2026-11-11）：
  - 本机实测：`codex app-server generate-json-schema`（`codex-cli 0.166.0` v2 schema：`Account`、`GetAccountRateLimitsParams`、`GetAccountRateLimitsResponse`、`RateLimitSnapshot`、`RateLimitWindow`、`AccountRateLimitsUpdatedNotification`）。
  - OpenAI 官方 Codex App Server 协议说明：[Codex App Server](https://developers.openai.com/codex/app-server/)。
  - OpenAI 官方开源应用接入指南：[Using ChatGPT plans in open-source apps](https://developers.openai.com/siwc/token-sharing-open-source.md)、[Sign in with ChatGPT Quickstart](https://developers.openai.com/siwc/quickstart)。

---

### 问题 2：OpenAI 官方是否存在面向个人账号使用的 ChatGPT Plus/Pro 订阅剩余额度查询 REST API？

- **结论：不存在。**
- OpenAI 官方文档唯一公开的用量与限额查询 REST API 位于 **`platform.openai.com` 开发者 API 平台**，例如：
  - `GET https://api.openai.com/v1/organization/usage/completions`（以及 `audio_speeches`、`audio_transcriptions`、`code_interpreter_sessions`、`costs` 等）
  - `GET https://api.openai.com/v1/organization/projects/{project_id}/rate_limits`
- **关键区别**：上述 REST API **仅适用于按量付费/预充值的 OpenAI Platform API 组织账号**，且明确要求使用组织管理员密钥（`Admin API Key` / `AdminApiKeyAuth`），无法读取消费者 ChatGPT Plus（\$20/月）、Pro（\$100–\$500/月）或 Business/Enterprise 订阅套餐共享的 Codex 5 小时/周度限额池。OpenAI 文档明确说明 ChatGPT 订阅与 API 平台计费体系相互独立、互不共享额度。
- **个人订阅的官方查看位置**：普通用户只能通过 **ChatGPT Web / 桌面应用内的 `Settings → Usage`**（官方文档曾说明的路径为 `chatgpt.com/codex/settings/usage` 及主设置下的 Usage / Usage & Billing 面板）或在官方授权的 Codex 客户端（如 CLI `/status`）内部查看实时比例、重置时间与购买即时重置（Instant Reset）。
- **关于 `/backend-api/wham/usage`（明确标为「非官方」）**：
  - GitHub 等开源社区工具与讨论中提到第一方网页/客户端背后请求 ChatGPT 内部端点 `/backend-api/wham/usage`（附带 `ChatGPT-Account-ID` 与消费级会话/OAuth token）以读取 5 小时/每周配额百分比。
  - **【非官方风险声明】**：该 `/backend-api/wham/usage` 接口**未出现在 `platform.openai.com` 或 `developers.openai.com` 的任何官方公开 API 契约文档中**，属于内部前后端私有接口，随时可能变更、下线或触发风控限制，且直连请求往往要求读取/携带登录凭证。**本应用必须禁止依赖、也禁止代码直接调用该非官方端点。**
- **查阅来源**（2026-11-11）：
  - OpenAI Platform API 文档（Usage & Rate Limits）：[platform.openai.com/docs/api-reference/usage](https://platform.openai.com/docs/api-reference/usage)、[platform.openai.com/docs/guides/rate-limits](https://platform.openai.com/docs/guides/rate-limits)。
  - OpenAI Help Center：[Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)、ChatGPT / Codex 共享用量及即时重置帮助文档（help.openai.com，2026-11-11 检索确认 `Settings → Usage` 与 `chatgpt.com/codex/settings/usage` 说明）。

---

### 问题 3：执行体或思考者调用失败且原因为「额度用完」时，Codex CLI / app-server 返回的错误内容里是否包含明确的重置时间？

- 对照本机 `codex-cli 0.166.0` 的 `TurnError` / `CodexErrorInfo` 官方 schema 与本仓库现行错误分类逻辑（`src/core/thinking/errors.ts`）：
  1. **协议对象层面**：`TurnError` 结构为：
     - `message: string`（必填，人类可读错误消息）
     - `additionalDetails: string | null`（可选补充详情）
     - `codexErrorInfo: CodexErrorInfo | null`（枚举含 `"usageLimitExceeded"`、`"rateLimitExceeded"`、`"sessionBudgetExceeded"` 等）
     - 在通用执行/讨论回合的 `TurnError` 契约上，**并没有强制提供一个独立顶层数值型 `resetsAt` 字段**（注：仅图片生成特定失败结构 `UsageLimitExceededImageGenerationFailure` 中包含 `resetsAt` 字段，普通文本/编码回合的 `TurnError` 无此顶层结构化时间戳字段）。
  2. **错误文本与客户端展示层面**：当消费级 ChatGPT 订阅触及 5 小时或周限额时，`codex` 通常在错误消息文案 `message`（或终端 stderr 输出）中附带人类可读的重置窗口提示（例如 *"You've hit your usage limit... try again in ... / at ..."* 文本），这类错误会被 `src/core/thinking/errors.ts` 中的 `classifyServiceError`（正则 `/hit your (?:\w+ )?limit|usage limit|.../i`）可靠识别为 `'quota_exhausted'`，并由 `task-state-view.ts` 在「停止 / 中断页（#06-stopped）」呈报 **「额度用完已停下，已做的修改保留在任务副本里，你的项目没有变化」**。
  3. **结构化精确恢复时间与服务端实际判定**：要获得确定性的 Unix 秒级重置时间 `resetsAt`，在 `codex app-server` 协议体系内来自 **`account/rateLimits/read` / `account/rateLimits/updated` 中的 `RateLimitWindow.resetsAt`**；并且 **`GetAccountRateLimitsResponse.ordinaryUsageAllowed` 明确规定不得仅以百分比归零或本地时间经过 `resetsAt` 推算已可恢复使用**（仍以服务端下发的 `ordinaryUsageAllowed` 与实际限额状态为准）。
  4. **对比 OpenAI API Key 路径**：走标准 OpenAI HTTP REST API Key 调用触发 429 时，HTTP 响应头会附带 `Retry-After` 及 `x-ratelimit-*`（如 `x-ratelimit-remaining-requests`），但这仅适用于 API Key，与 ChatGPT 订阅限额机制不同。
- **查阅来源**（2026-11-11）：
  - 本机 `codex-cli 0.166.0` v2 schema（`TurnError`、`CodexErrorInfo`、`GetAccountRateLimitsResponse`）；
  - 本仓库源码 `src/core/thinking/errors.ts` 第 3–9 行、`src/core/app/task-state-view.ts` 第 62–68、79–86 行；
  - OpenAI Platform API 限额与 429 响应头文档：[platform.openai.com/docs/guides/rate-limits](https://platform.openai.com/docs/guides/rate-limits)。

---

### 问题 4：结合 ADR 0002 与 ADR 0009，明确「第一版 Codex 额度面板能否做、能展示到什么程度」的建议结论

1. **第一版（v1.0 对外发布边界）结论：暂不做实时 Codex 订阅额度面板。**
   - **依据**：
     - **合规边界（ADR 0002 + ADR 0009 §5）**：现阶段（阶段 7 之前）本应用**没有接入** OpenAI 官方 *Sign in with ChatGPT* OAuth 自助授权流程（且尚未完成 ADR 0009 第 5 节待办对第三方程序编排 Codex 的 Plan Usage 合规逐条确认与 UI/品牌义务落实）。开发期借助本机 `codex login` 仅限维护者自用，面向其他用户的发布版禁止读取 `~/.codex/auth.json` 等外部工具凭证。
     - **零真实凭证则无合法数据**：在普通用户尚未完成由本应用发起并管控的官方授权前，没有任何合规 API 可以替用户读取其 ChatGPT 订阅剩余额度；而 `/backend-api/wham/usage` 属于非官方内部端点，绝不能依赖。
   - **第一版唯一真实可靠的交互形态**：
     - 在全局设置「AI 与角色」中展示 Codex CLI 安装与就绪状态（已有环境体检）；
     - 执行或思考中途真实遇到 `usageLimitExceeded` / `quota_exhausted` 报错时，如实展示「额度用完已停下」与服务端原话中的重置时间提示（若有且经安全过滤），并提供指引链接/说明让用户在 **ChatGPT 应用 `Settings → Usage`** 查看完整用量并购买即时重置（或切换思考者 / 使用外部执行交接把任务交给用户自己已登录的工具）。

2. **后续版本（v1.x 完成 *Sign in with ChatGPT* 官方授权接入 + ADR 0009 §5 合规确认后）的严格设计边界**：
   - 若未来产品按 OpenAI 官方规范接入了本应用自持 OAuth token 并传给 `codex app-server`，则**可以合规做出真实的 Codex 额度展示**，技术路径**仅限**在受控子进程启动临时 `codex app-server` 调用只读 JSON-RPC **`account/rateLimits/read`**（及会话期间监听 **`account/rateLimits/updated`**），不调任何未公开 HTTP 端点、不消耗模型 token。
   - **严格展示上限（真实信号原则，只增事实、不做猜测）**：
     - 展示 `account.planType`（订阅档位）与 `rateLimitsByLimitId['codex']`（或兜底 `rateLimits`）下的真实窗口：例如 5 小时窗口（`windowDurationMins === 300`）与周窗口（`10080`），显示后台直接下发的 `100 - usedPercent`% 与格式化后的重置时间 `resetsAt`（仅当 `resetsAt !== null` 时显示）。
     - 若 `credits?.hasCredits` 为 `true`（且非 `unlimited`），展示下发的 `credits.balance`；否则不显示猜测余额。
     - 若 `account/rateLimits/read` 返回失败/超时、或 `Account.type === "apiKey"`、或 `ordinaryUsageAllowed === null`，明确展示 **「当前无法获取订阅额度」**，附官方网页查询指引（`Settings → Usage`）；**禁止通过本应用累计历史消耗 token 来本地倒推百分比**，也**禁止在本地时间越过 `resetsAt` 时自动将受限状态改成「额度已恢复」**。

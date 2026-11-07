# ADR 0001：第一个真实执行体的技术验证

- 状态：已决定（2026-11-07）
- 候选：Claude Code（headless 模式）、Codex（app-server）

## 需要验证的问题

对每个候选，在本机 macOS 上验证以下各项，结果填入下表。

| # | 问题 | 判定标准 |
| - | - | - |
| 1 | 能否获得**结构化事件流**（消息、工具调用、结束） | 能以 JSON 行等机器可读格式逐条读取 |
| 2 | 能否**拦截权限请求**并由本应用回答允许/拒绝 | 不依赖跳过权限的参数即可完成任务 |
| 3 | 能否**可靠中断** | 发出停止后数秒内进程结束，且不再修改文件 |
| 4 | 能否**限定工作目录** | 在 worktree 中运行时不访问外部路径（或访问会触发权限请求） |
| 5 | **退出码语义** | 任务失败时退出码非 0 |
| 6 | **授权合规** | 由第三方开源桌面应用启动、使用用户自己登录的账号，是否符合该厂商现行条款（附条款链接与日期） |
| 7 | **安装与登录检测** | 能否不发起实际任务就判断“已安装/已登录” |

## 验证方法

每个候选写一个最小脚本（放在 `spikes/<name>/`），在临时 Git 仓库中执行固定任务：“在 index.html 中加入一个标题为 Hello 的 h1”，依次测试 1～5 与 7。第 6 项人工查阅条款并记录原文链接。

## 结果

验证环境：macOS，Claude Code 2.1.318（模型 haiku，`--setting-sources project`，不读用户级 settings/hooks），Codex CLI 0.166.0（登录方式 ChatGPT 账号）。固定任务与临时仓库见上文；脚本在 `spikes/claude-code/run.mjs`、`spikes/codex/run.mjs`，原始事件流样本（已脱敏）在各自的 `samples/`，汇总数据在 `samples/results.json`。全部实验均未使用任何跳过权限/沙箱的参数。

| # | Claude Code | Codex |
| - | - | - |
| 1 | **通过**。`-p --output-format stream-json --verbose` 输出 JSON 行：`system/init`、`assistant`（含 `tool_use` 块）、`user`（`tool_result`）、`result`。证据：`samples/e1-e2-allow.jsonl`，工具调用含 `name` 与 `input`。注意 `result` 不一定是最后一行，其后还有 `system/task_summary` 等。 | **通过**。`codex exec --json` 输出 `thread.started` → `turn.started` → `item.started/completed`（`command_execution`、`file_change`、`agent_message`）→ `turn.completed`/`turn.failed`。证据：`samples/e1-exec-events.jsonl`；app-server 另有更细的通知流（`item/started`、`item/agentMessage/delta`、`turn/completed` 等）。 |
| 2 | **通过**。`--permission-prompt-tool mcp__perm__approve` 指向自建 MCP 服务器，收到 `{tool_name, input, tool_use_id}`，回 `{"behavior":"allow","updatedInput":…}` 或 `{"behavior":"deny","message":…}`。允许：`index.html` 被改成含 `<h1>Hello</h1>`；拒绝：文件哈希不变，`result.permission_denials=["Edit"]`。证据：`results.json` 的 `e2_allow`/`e2_deny`。 | **仅 app-server 通过；`codex exec` 不行**。`exec` 没有审批通道（read-only 下写文件只是失败，文件未变）。app-server（`thread/start` 设 `approvalPolicy:"on-request"`、`sandbox:"read-only"`）会发来 `item/commandExecution/requestApproval`，回 `{"decision":"accept"}`：文件被改；回 `"decline"`：文件未变，回合正常结束。证据：`e2_app_accept`/`e2_app_decline`。app-server 官方标注为 experimental。 |
| 3 | **通过**。首个工具调用出现后发 SIGTERM：829 ms 后退出（退出码 143），退出后 4 秒内文件列表不变。注意发信号时那一步可能已落盘，中断不会回滚。证据：`e3_interrupt`。 | **通过**。`exec`：SIGTERM 后进程立即结束（约 8 ms），之后文件不再变化。app-server：`turn/interrupt` 后 106 ms 回合状态变为 `interrupted`，之后文件不再变化。同样不回滚已完成的那一步（`note1.txt` 已存在）。证据：`e3_exec_interrupt`、`e3_app_interrupt`。 |
| 4 | **通过（触发权限请求）**。在仓库外读写 `../outside.txt` 时，`Read`/`Bash` 都发来权限请求；拒绝后文件未变。没有提示工具时（默认 `-p`），这类调用被直接拒绝并出现 `system/permission_denied`。证据：`e4_write_outside`、`e4_read_outside`、`e4_no_prompt_tool`。 | **app-server 通过；`exec` 未能证明**。`workspace-write` + `on-request` 下，写 `../outside.txt` 触发 `requestApproval`（reason 写明“工作区外”），拒绝后文件不存在。`exec` 路线中模型自己没有尝试写入，无法判断沙箱拦截行为。**坑**：`workspace-write` 默认允许写系统临时目录，仓库放在 `/tmp` 下时 `../outside.txt` 会直接写成功。证据：`e4_app_outside`、`e4_exec_outside`。 |
| 5 | **通过，但语义需注意**。无效模型：退出码 1，`result.is_error=true`（`subtype` 仍为 `success`）；`--max-turns 1`：退出码 1，`subtype=error_max_turns`；权限被拒绝但任务“完成”：退出码 0，需读 `permission_denials`。证据：`e5_bad_model`、`e5_max_turns`、`e2_deny`。 | **通过，但语义需注意**。无效模型：退出码 1，事件为 `error` 与 `turn.failed`；任务本身失败（读不存在的文件）但回合完成：退出码 0。app-server 没有进程退出码，需看 `turn/completed` 的状态。证据：`e5_exec_bad_model`、`e5_exec_failing_task`。 |
| 6 | **订阅登录不通过；API Key 模式通过**。Anthropic 条款：订阅账号的 OAuth 登录仅供订阅用户本人用于 Claude Code 及 Anthropic 自家应用；构建产品或服务的开发者（含 Agent SDK）应使用 API Key；不允许第三方开发者提供 Claude.ai 登录或代用户通过订阅凭证转发请求。Help Center（2026-06-15 更新）称 `claude -p` 与第三方应用用量仍计入订阅额度，但未推翻上述限制，属灰色地带，分发给他人的产品不宜依赖。详见下文“授权合规调查”。 | **通过**。OpenAI 官方明确支持开源、在用户本机运行的应用让符合条件的 ChatGPT 计划用户用自己的计划驱动 AI 功能（Sign in with ChatGPT / 开源应用使用 ChatGPT 计划，文档含 Codex app-server 配置）。义务：遵循 UI/品牌规范、需单独的计划使用授权、阅读预览期限制。详见下文“授权合规调查”。 |
| 7 | **通过**。`claude --version` 输出版本；`claude auth status` 输出 JSON（`loggedIn`、`authMethod`），已登录退出码 0。用空的 `CLAUDE_CONFIG_DIR` 模拟未登录：退出码 1，`loggedIn:false`、`authMethod:"none"`。证据：`e7_detect`。 | **通过**。`codex --version` 输出版本；`codex login status` 已登录输出 “Logged in using ChatGPT”（写到 stderr），退出码 0。用空的 `CODEX_HOME` 模拟未登录：输出 “Not logged in”，退出码 1。证据：`e7_detect`。 |

### 集成要点

**Claude Code**
- 推荐调用方式：`claude -p <任务> --output-format stream-json --verbose --permission-prompt-tool mcp__<server>__<tool> --mcp-config <文件> --strict-mcp-config --no-session-persistence`，工作目录设为任务的隔离副本；用 `--setting-sources project` 避免读取用户级设置与 hooks（用户级 allow 规则、hooks 会改变权限行为）。权限提示工具是一个 MCP 服务器：集成时应让它把请求转发给主应用（IPC/本地 socket），由用户点“允许/拒绝”，再把结果回给 Claude Code；`updatedInput` 原样回传即为原参数允许。
- 事件映射思路：`assistant.message.content[]` 中的 `text` → 消息，`tool_use` → 工具调用开始，`user` 中的 `tool_result` → 工具调用结束，`result` → 结束（`is_error`、`subtype`、`permission_denials`）。权限请求来自 MCP 调用，而不是事件流，要和事件流里的 `tool_use_id` 关联。
- 已知坑：`result` 之后还会有 `system/*` 事件，不能当作最后一行；无效模型时 `is_error=true` 但 `subtype=success`；被拒绝的权限不会让进程失败（退出码 0），必须检查 `permission_denials` 才能向用户如实报告；SIGTERM 退出码为 143；`--permission-prompt-tool` 的 MCP 约定（输入字段与返回 JSON）我们在 2.1.318 上实测可用，但官方文档页面里未找到完整字段说明，升级版本后需回归；样本中有大量与任务无关的 `system/init` 字段（工具、插件列表），解析时应忽略未知字段。

**Codex**
- 推荐调用方式：需要审批拦截就用 `codex app-server`（stdio，换行分隔 JSON-RPC）：`initialize` → `initialized` → `thread/start`（`cwd`、`approvalPolicy:"on-request"`、`sandbox`）→ `turn/start`；收到 `item/commandExecution/requestApproval` 或 `item/fileChange/requestApproval` 时回 `{id, result:{decision:"accept"|"decline"}}`；中断用 `turn/interrupt`。`codex exec --json` 只适合无需审批的只读/受限任务。务必显式传 `sandbox` 与 `approvalPolicy`：用户全局配置里可能是 `danger-full-access`。回包格式以 `codex app-server generate-json-schema` 生成的 schema 为准（版本间可能变化）。
- 事件映射思路：`item/started`/`item/completed`（`agentMessage`、`commandExecution`、`fileChange`）→ 消息/工具调用；`*/requestApproval` → 权限请求（带 `reason`、`command`、`cwd`）；`turn/completed` 的 `status`（`completed`/`interrupted`/失败）→ 结束。`exec --json` 的事件是 snake_case（`item.completed`），app-server 是 camelCase 与 `item/…` 方法名，两套不要混用。
- 已知坑：`exec` 没有审批通道；`workspace-write` 默认允许写系统临时目录，隔离副本若放在临时目录下，“仓库外”的临时路径也可写；拒绝审批后回合仍正常结束（`turn/completed`），需要自己根据是否收到并拒绝过审批来标记“未执行”；app-server 标注为 experimental，协议可能变；`item/*` 之外还有大量通知（账号、限流、MCP 启动状态等），应忽略未知方法；`codex login status` 的文字写在 stderr；`approval_policy="untrusted"` 在官方文档中已退役，不要使用。

## 授权合规调查（第 6 项，2026-11-07）

> 非法律意见。条款可能变化，发布前及每个大版本前需重新核对原文。

**Anthropic（Claude Code / Agent SDK）**
- 来源：[Claude Code Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)；[Help Center：Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)。
- 订阅账号的 OAuth 登录专供订阅用户本人，用于 Claude Code 及 Anthropic 自家应用的“常规使用”；构建产品或服务的开发者（含使用 Agent SDK 者）应使用 API Key。
- 明确不允许第三方开发者提供 Claude.ai 登录，或代表其用户通过 Free/Pro/Max 订阅凭证转发请求；Anthropic 可不经通知执行限制。
- Help Center（2026-06-15 更新）称 Agent SDK、`claude -p` 与“第三方应用”的用量目前仍计入订阅额度——说明存在被计量的使用，但并未推翻上一条限制。
- 结论：灰色地带，对分发给他人的产品不宜依赖订阅登录。以“用户自己的 API Key”为默认合规路径；若要支持订阅模式，需先向 Anthropic 书面确认。

**OpenAI（Codex / Sign in with ChatGPT）**
- 来源：[快速入门](https://developers.openai.com/siwc/quickstart)；[开源应用使用 ChatGPT 计划（含 Codex app-server 配置、预览限制）](https://developers.openai.com/siwc/token-sharing-open-source.md)；[Cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)；[Help Center：Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)；[DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit)。
- 官方明确支持：开源、在用户本机运行的应用，可让符合条件的 Plus/Pro 用户用自己的 ChatGPT 计划驱动 AI 功能，无需 API Key；开源项目为自助接入；有专门一节说明如何让 Codex app-server 使用经授权的 OAuth 访问令牌。
- 义务：遵循 UI/UX 与品牌规范（“Continue with ChatGPT”按钮、请求使用计划时显示“Using ChatGPT plan”）；仅登录不代表获准使用计划，需单独的计划使用授权；预览期限制需阅读。
- 注意：DevKit 的 OpenAI 代码采用 “Noncommercial License v1.0”，**不得复制进本项目（MIT）**；按官方文档自行实现，或仅作参考。
- 结论：合规路径清晰，满足第 6 项。

## 其他候选（Cursor、Antigravity、DeepSeek、开源框架）调查

**Cursor（Cursor CLI / agent）**
- 来源：[Headless](https://cursor.com/docs/cli/headless)；[权限](https://cursor.com/docs/cli/reference/permissions)；[官方论坛答复](https://forum.cursor.com/t/inquiry-regarding-official-api-or-commercial-license-for-using-cursors-engine-as-a-backend-component/165063/5)。
- 官方支持 headless（`-p`，输出 text/json/stream-json）用于脚本和自动化，可用 `CURSOR_API_KEY` 认证；另有 `@cursor/sdk`。限制：不能把 Cursor 作为独立服务转售或让第三方使用你账户下的用量；不能用输出训练竞争模型。由用户本人账号在本机运行不在限制之列。
- 技术坑：headless 下文件修改只有加 `--force` 或 `--yolo` 才生效，权限主要靠 `cli.json` 的 allow/deny 静态规则，**没有逐条询问的回调**（第 2 项可能不满足，需实测或改走 ACP；Cursor CLI 支持 ACP）。
- 结论：条款基本通过；技术上需验证能否在不使用 `--force`/`--yolo` 的前提下实现逐条审批。**未实测。**

**Google Antigravity（agy CLI）**
- 来源：[条款 §6](https://antigravity.google/terms/)；[Headless 文档](https://antigravity.google/docs/cli/headless/)；[FAQ](https://antigravity.google/docs/faq)；论坛：[1](https://discuss.ai.google.dev/t/is-orchestrating-the-official-antigravity-cli-from-a-local-multi-agent-coding-application-allowed/181088)、[2](https://discuss.ai.google.dev/t/headless-agy-runs-launched-by-a-script-from-another-ai-coding-tool-within-the-additional-terms/185494)。
- 条款 §6 禁止“使用第三方软件、工具或服务访问本服务”，FAQ 举例包括 OpenClaw 等；违者可被暂停账户，社区报告该风险可能波及整个 Google 账户。
- 论坛答复称：在本机启动未经修改的官方 `agy`、用其文档化的 headless 模式、不提取或转发登录令牌，属于允许的用法。但答复者是否为 Google 官方人员、是否具有约束力，**未核实**。
- 结论：技术上可行，条款上存在重大不确定性且后果严重（账户被封）。获得 Google 官方书面确认前不接入；若将来接入，应要求用户自行确认风险，或仅支持 API Key/Vertex 计费模式。

**DeepSeek**
- 来源：DeepSeek API 文档（OpenAI 兼容接口）；社区 CLI：[Whale](https://pkg.go.dev/github.com/usewhale/whale)（MIT）、DeepSeek-CLI（MIT）。
- 未发现 DeepSeek 官方的编码 Agent CLI；DeepSeek 是模型与 API 提供方，用户使用自己的 API Key 是标准、合规的方式。通过社区 Agent（如 Whale，支持 headless exec 与 worktree）或通用开源 Agent 框架接入。社区工具中“浏览器登录”等非 API Key 路径自称可能违反 DeepSeek 条款，不得使用。
- 优势：成本低；在中国大陆可直接访问，对本地用户很重要。
- 结论：条款通过（API Key 模式）；技术上取决于所选社区 Agent 的事件流与权限能力，需单独验证。

**开源 Agent 框架（Harness，如 OpenCode 等）**
- 用 API Key 接入任意模型提供方：合规。
- 用 Claude 或 Antigravity 订阅登录令牌接入：被两家明确禁止，已有封禁执行记录。本项目不得采用。

## 决定

2026-11-07。

1. **第一个执行体：Codex，通过 `codex app-server` 接入。** 依据：第 2、3 项在 app-server 路线上通过（`exec` 没有审批通道，不用于需要审批的任务），第 6 项条款路径清晰。
2. **认证**：开发阶段使用用户本机 `codex login` 的登录状态；面向用户发布前，实现官方“Sign in with ChatGPT”（开源本地应用的计划使用授权），遵循其 UI/品牌规范。**不得复制 OpenAI DevKit 代码**（非商业许可，与本项目 MIT 不兼容）。
3. **第二个执行体候选：Claude Code，仅 API Key 模式**（不依赖订阅登录）。
4. **下一轮验证**：ACP 协议（Cursor 等）、DeepSeek（Whale）。
5. **Antigravity** 在获得官方书面确认前不接入。

原则（保留）：第 2、3、6 项任一不满足的候选不得作为第一个执行体。Codex 的 app-server 被官方标注为 experimental，协议可能变化，适配器必须显式传参并有版本回归测试。

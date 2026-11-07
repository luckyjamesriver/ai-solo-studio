# ADR 0001：第一个真实执行体的技术验证

- 状态：进行中（M2）
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
| 6 | 待查 | 待查 |
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

## 决定

待定。原则：第 2、3、6 项任一不满足的候选不得作为第一个执行体。

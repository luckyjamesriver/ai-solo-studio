# 阶段 8 实施规划 · 多执行体接入（主流 AI API + 本地 CLI 订阅与风险自选）

- 制定日期：2026-11-11
- 依据决策：[ADR 0010 · 多执行体接入与「风险告知后自选」订阅制 CLI 连接策略](../adr/0010-multi-executor-and-opt-in-subscriptions.md)
- 遵循规范：[ADR 0005](../adr/0005-data-storage.md)（安全存储）、[ADR 0006](../adr/0006-code-layering.md)（分层）、[ADR 0008](../adr/0008-dependencies.md)（零新增运行时依赖）、UI v2.1 简洁大白话规范

---

## 1. 整体结构：两条主线、两套底座、一个配置中心

```text
用户配置（SettingsPage · AI 接入与角色）
 ├── A. 本地订阅 / CLI 工具（仅受控启动本机官方二进制，不读凭证文件）
 │    ├── Codex (codex app-server)          ── 已有，补全模式切换与风险告知
 │    ├── Claude Code (claude -p stream-json) ── 订阅模式(清Key+safe-mode) / Key模式(--bare)
 │    ├── Antigravity (agy acp --sandbox)    ─┐ 共用 AcpExecutor（stdio JSON-RPC）
 │    └── Cursor (agent acp --sandbox)       ─┘
 └── B. 主流 AI API 执行体（Built-in ApiAgentExecutor，Node fetch，零新依赖）
      ├── Anthropic Messages   ── Anthropic Claude
      ├── Google Gemini v1beta ── Google Gemini（替代 Antigravity 订阅的合规首选）
      └── OpenAI Compatible    ── OpenAI / DeepSeek / 通义千问(DashScope) / 智谱GLM /
                                  Kimi(Moonshot) / MiniMax / xAI / OpenRouter /
                                  Ollama & LM Studio / 自定义网关
```

所有接入项通过测试与合规门禁后，产出统一 [`Executor`](../../src/core/executor/types.ts) 实例，交给 [`TaskRunner`](../../src/core/task/runner.ts) 在独立 Git `worktree` 中运行。

---

## 2. 参考同类平台与内置常用 API 服务商目录（阶段 8A）

参考开源同类产品 **Roo Code**（与 Cline 同源，覆盖直连云服务、中转聚合、本土兼容与本地运行）设计内置预设清单，并补齐国内开发者高频直连选项：

| `presetId` | 页面显示名 | 协议族 (`protocol`) | 默认接口地址 (`defaultBaseUrl`) | 预设推荐模型（支持手填任意模型 ID + 拉取 `/models`） | 特殊字段 / 说明 |
|---|---|---|---|---|---|
| `openai` | OpenAI | `openai_compat` | `https://api.openai.com/v1` | `gpt-5`、`gpt-5-mini`、`gpt-5.5` | 支持拉取 `/models` |
| `anthropic` | Anthropic（Claude） | `anthropic` | `https://api.anthropic.com/v1/messages` | `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5` | 复用 `claude-key.ts` 请求头规范 |
| `gemini` | Google Gemini | `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `gemini-3.8-flash`、`gemini-3.5-flash`、`gemini-2.5-pro`、`gemini-4-argon` | Header 传 `x-goog-api-key` |
| `deepseek` | DeepSeek | `openai_compat` | `https://api.deepseek.com` | `deepseek-chat`、`deepseek-reasoner` | 国内直连主力；可设默认首选本土 API |
| `qwen` | 阿里百炼（Qwen） | `openai_compat` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 预设编码模型 + 支持自定义填（含国际端 `dashscope-intl` 切换） | 兼容百炼 Coding/通用 Key |
| `zhipu` | 智谱（GLM） | `openai_compat` | `https://open.bigmodel.cn/api/paas/v4` | GLM 编码/对话模型（另提供 Coding 专用端 `.../api/coding/paas/v4` 快捷切换） | 国内直连 |
| `moonshot` | 月之暗面（Kimi） | `openai_compat` | `https://api.moonshot.cn/v1` | Kimi 长上下文/编程模型（提供国际端 `api.moonshot.ai/v1` 切换） | 国内直连 |
| `minimax` | MiniMax | `openai_compat` | `https://api.minimaxi.com/v1` | `MiniMax-M3.1-Flash` 等（提供国际端 `api.minimax.io/v1` 切换） | 区分国内/国际域名 |
| `xai` | xAI（Grok） | `openai_compat` | `https://api.x.ai/v1` | 支持手填或拉取 `/models` | Bearer Key |
| `openrouter` | OpenRouter | `openai_compat` | `https://openrouter.ai/api/v1` | 支持拉取 `/models`（如 `anthropic/...`、`google/...`、`deepseek/...`） | 单 Key 聚合多家模型 |
| `ollama` | 本地模型（Ollama / LM Studio） | `openai_compat` | `http://localhost:11434/v1` | 自动从本地 `/models` 拉取已加载模型（也可手填 `1234` 端口 LM Studio） | 免真 Key（可填 `local`）；提示需选支持 Tool Calling 的模型 |
| `custom_openai` | 自定义 OpenAI 兼容 | `openai_compat` | 用户填写 URL | 用户手填模型 ID | 默认按 `nonOfficialModelEndpoint` 提示外发与地址风险 |

---

## 3. 核心模块设计细节

### 3.1 多配置档案与加密密钥库（`src/core/app/`）

1. **`ProviderProfileStore`**（替换单一的 `claude-api-key` 记录，向下兼容迁移老数据）：
   - 每条配置 `ProviderProfile` 存储非敏感元数据：
     - `id`: UUID / `default-codex` 等
     - `kind`: `'cli_subscription' | 'api'`
     - `provider`: Preset ID 或 CLI ID（`'codex' | 'claude_cli' | 'agy' | 'cursor' | 'openai' | 'anthropic' | 'gemini' | 'deepseek' | ...`）
     - `label`: 显示名称（如 `"DeepSeek · deepseek-chat"`）
     - `model`: 选定模型 ID（可为空表示用 CLI 默认）
     - `baseUrl`: API 服务商实际地址（仅非官方地址或用户覆盖时保存；展示用）
     - `authMode`: `'local_subscription' | 'api_key'`
     - `riskAcknowledgedAt?: string`（仅订阅模式使用，未确认不可设为可用执行者）
     - `verifiedAt?: string` / `last4?: string` / `executorReady: boolean`
2. **`ProviderSecretVault`**（重构自 `claude-key.ts`）：
   - 通过注入的 `SecretVault`（Electron `safeStorage`）按 `profileId` 分别加密保存明文 Key。
   - **安全不变量**：`safeStorage` 不可用拒绝保存；IPC 永远只接收明文写、永远只返回 `{ configured, last4, verifiedAt, executorReady }`；通用脱敏正则覆盖 `sk-*`、`AIza*`、`gsk_*`、`or-*` 等常见前缀及当次明文全匹配替换。

### 3.2 连接测试规范（「通过后才成为执行者」）

为防止“聊天能通、改代码就报错”或“没确认风险就偷偷接上”，所有接入点统一走后端 **`testAndSaveProviderConnection`**（经 IPC 白名单暴露）：

1. **API 配置连接测试（2 步连续握手）**：
   - **第 1 步 · 认证与可达性校验**：发最小请求（`max_tokens: 16`），按状态码精确分类：`Key 无效（401/403）`、`额度不足或限流（402/429）`、`地址无法访问或超时（网络错误）`、`模型名不存在（404 / invalid model）`。
   - **第 2 步 · Tool Calling 执行能力校验**：附带 1 个最小只读工具定义（`{ name: 'ping_workspace', parameters: { ... } }`），要求端点成功解析 `tools` 字段（不报 400 `tools not supported` / 不丢弃工具 Schema）。
   - 两步都通过才写入 `verifiedAt` 与 `executorReady: true`；**若第 1 步通而第 2 步报不支持工具 calling**，明确提示「该模型或接口仅支持对话、暂不支持工具调用，可用作讨论思考者但无法担任执行者」，仅允许选作思考者或取消。
2. **本地订阅 CLI 连接测试**：
   - 检查风险弹窗是否已明确勾选（`riskAcknowledgedAt`）；
   - 调用对应适配器 `detect()` 完成 **安装 → 启动(`--version`) → 版本记录 → 本机登录态探测 → 隔离配置可读性** 五层核验（例如 `codex app-server`、`claude auth status` / 只读 `--tools ""` ping、`agy models` / `agy acp` 握手、`agent status`）；全部非 fail 且登录确认后才置为 `executorReady: true`。

### 3.3 通用 API 执行体引擎（`src/core/executor/adapters/api-agent.ts`）

实现 [`Executor`](../../src/core/executor/types.ts) 接口，在独立 `worktree` 内跑确定性的 **ReAct / Tool-Use 循环**：

1. **内置受控工具集（共 6 个，均纯 Node 实现，不依赖第三方 SDK）**：
   - `list_dir` / `read_file` / `search_files`：文件读取默认允许工作树内路径，禁止穿透 [`sensitiveFallbackList()`](../../src/core/executor/modes.ts#L97-L104) 中的敏感目录；若用户计划允许读工作树外则按 [`Capabilities`](../../src/core/capabilities/model.ts) 与读取清单统一提示。
   - `write_file` / `edit_file`：调用 `fs.realpath` 二次校验目标绝对路径必须位于 `opts.cwd`（或任务明确授权的 `extraWritableDirs`）下，**物理阻止跨出任务副本写入或修改 `.git/`**。
   - `run_command`：优先委托给 `opts.sandboxRunner`（或阶段 8C macOS `sandbox-exec`）受限运行；无沙箱且 `constructionMode !== 'full_trust'` 时直接拒绝执行命令并记录为 `blocked: DeniedOperation`（供验收卡如实呈现「AI 请求的操作是否都已执行」）。
2. **上下文与轮次止损**：
   - 步数上限（如默认 40 轮 tool loop）、单次命令超时、总任务超时、以及响应 `AbortSignal` 实时取消（解决停止竞态：收到 `stop()` 立刻 `abort` 在途 `fetch` + 终止在途命令，产出 `{ kind: 'stopped' }`）。
3. **三协议统一适配层（`src/core/executor/api-protocols/`）**：
   - `openai-compat.ts`：标准 `/chat/completions` + `tool_calls` + `role: 'tool'`（兼容 `reasoning_content` 提取进事件日志而不污染文件）。
   - `anthropic-messages.ts`：标准 `/v1/messages` + `tool_use` / `tool_result` 内容块（可与 `src/core/thinking/claude-api.ts` 共用基础请求与错误分类函数）。
   - `gemini-generate.ts`：标准 `/v1beta/models/<model>:generateContent` + `functionDeclarations` / `functionCall` / `functionResponse`。

### 3.4 本地 CLI / ACP 执行体适配器

1. **通用 `AcpExecutor`（`src/core/executor/adapters/acp.ts`）**：
   - 驱动 `agy acp --sandbox --stdio`（Antigravity）和 `agent acp`（Cursor CLI），通过 stdio 行分隔 JSON-RPC 通信：
     - `initialize` → `session/new`（传 `cwd` = 任务 worktree）→ `session/prompt` → 流式映射 tool call / agent message / `session/update` 到 `ExecutorEvent`。
     - **权限策略对齐**：对 Cursor ACP 的 `session/request_permission` 按规则响应（工作树内文件读写且无危险外链按配置处理，越出边界一律回 `reject-once` 并推 `blocked` 事件）；Antigravity 加传 `--sandbox` 与 `--disable-slash-commands`。
     - 启动前构造隔离事件 `isolation`，向界面如实告知“仅通过 CLI `--sandbox` / `.cursor/cli.json` 限制，无法做到 Codex `default_permissions` 同等目录白名单级隔离”的已知边界。
2. **`ClaudeCodeExecutor`（`src/core/executor/adapters/claude-code.ts`）**：
   - 复用本机已验证的 `claude -p --output-format stream-json --verbose --input-format stream-json --permission-prompts none --safe-mode --strict-mcp-config --disable-slash-commands --no-session-persistence`。
   - 通过 `--settings <sessionTmpJson>` 注入 `permissions.allow`（限定 `cwd` 范围）与 `sandbox.enabled`；订阅模式从子进程环境剔除 `ANTHROPIC_API_KEY`，API Key 模式加 `--bare` 并经子进程 env 传入临时解密 Key（运行结束内存清零，绝不写磁盘或命令行参数！）。
   - 解析 `stream-json` 的 `system/init` 校验 `mcp_servers`/`slash_commands` 为空、`permission_denials` 转换为 `DeniedOperation` 结构化进入验收卡。

### 3.5 动态构造器切换与 `#04-plan` / 工作台接入

- [index.ts](../../src/main/index.ts) 中的 `makeExecutor` 改造为按当前任务/项目选定的 `executorProfileId` 动态工厂：`factory.createForProfile(profileId, vault)`。
- **配置与选择层级**（沿用现有角色机制）：
  - **全局设置（「AI 接入与角色」）**：维护全部连接配置 + 指定默认「执行者」（仅显示 `executorReady === true` 的接入项）+ 默认「首席思考者 / 复核思考者」（思考者也可逐步复用多 API 服务商！）。
  - **项目设置 / `#04-plan`**：允许某项目覆盖默认执行者，显示真实执行者名 + 模型 + 当前模式（如 `DeepSeek · deepseek-chat（API）` / `Antigravity（本机订阅 · 风险自担）` / `Claude Code（API Key）`）及其实际隔离能力说明。
- **首次外发告知（`Disclosure`）**：动态汇总当前所有已激活配置对应的 AI 服务名，不再仅硬编码 Codex / Claude。

---

## 4. 三阶段拆解与验收标准

| 阶段 | 范围与核心交付物 | 对用户立即可见效果 | 必过验证 |
|---|---|---|---|
| **阶段 8A**<br>*规约生效 + 通用 API 执行底座* | 1. 新建并确认 ADR 0010。<br>2. `ProviderProfileStore` + 多 Profile `ProviderSecretVault`（`safeStorage`）+ 兼容迁移原 `claude-api-key`。<br>3. `ApiAgentExecutor`（3 协议 12 家预设：DeepSeek / OpenAI / Anthropic / Gemini / 通义 / 智谱 / Kimi / MiniMax / xAI / OpenRouter / Ollama / 自定义）。<br>4. 设置页接入管理 +「选模型 → 输 Key → 连接测试（含 Tool Calling 验证）→ 设为执行者」。 | 不装任何重型 CLI，只要有 **DeepSeek / Gemini / OpenAI / Claude / 本地 Ollama** 的 API Key，测通即可直接当后台执行者完成“需求→讨论→施工→验收→保存撤销”全闭环。 | Mock HTTP Server 单元测试（3 协议 tool loop、越界写入拒绝、密钥脱敏、`safeStorage` 不可用拒绝）；`security.test.ts` 新增 IPC 与明文零泄漏断言；完整 Electron E2E + CI 双平台绿灯。 |
| **阶段 8B**<br>*本地订阅制 CLI / ACP 与风险告知* | 1. 订阅接入二次风险确认弹框与持久化（Codex / Claude Code / Antigravity / Cursor 四份独立文案）。<br>2. `AcpExecutor`（Antigravity `agy acp` + Cursor `agent acp`）与 `ClaudeCodeExecutor`（订阅清 Key / API Key `--bare` 二选一），完善 `CodexExecutor` 模式选择。<br>3. 计划卡 `#04-plan` 展示非 Codex 执行体的真实隔离局限说明。 | 本机已装的 **Claude Code / Antigravity / Cursor / Codex** 用户可在了解风险并手动勾选后直接用现有订阅登录开跑。 | 假 CLI 脚本 E2E（验证未勾选风险前禁用启用、订阅子进程环境不含其他工具 Key、ACP `reject-once` 拒绝越界同步入验收卡 `DeniedOperation`、停止即时 kill）。 |
| **阶段 8C**<br>*独立沙箱检查运行器* | 1. 脱离 Codex 的 macOS `sandbox-exec`（Seatbelt）`SandboxCommandRunner` 适配器（对齐 `sensitiveFallbackList` 读取拒绝与仅 `worktree` 可写，禁网除非能力放开）。<br>2. 跨平台兜底（Linux / 无可用沙箱时诚实报 `not_available` → `unchecked_needs_confirm`）。 | 即使电脑上完全没装 Codex、纯用 DeepSeek/Claude/Cursor API 执行，保存验收时的 `npm run build` / `npm test` 也能受控自动运行通过。 | 哨兵测试：沙箱内尝试读 `~/.ssh` 失败、尝试写主项目失败、写 `worktree` 内成功；断网下尝试外联失败。 |

---

## 5. 下一步建议

目前所有文档（[ADR 0010](../adr/0010-multi-executor-and-opt-in-subscriptions.md) 与本规划文档）均已就绪，**`src/` 源码保持未改动**（遵守「先不接，把方案列出」）。

当你准备开始写代码时，告诉我开启 **「阶段 8A（先落地通用 AI API 执行底座 + DeepSeek/主流平台设置与连接测试）」**，我就可直接按既定规范（零新依赖、安全断言只增不减、E2E + 双平台 CI 绿灯）开始推进实施。

# 阶段 5b 完成报告 · 项目简介、Claude API Key 接入与 AI 角色设置（UI v2.1 原型 `#13-settings`、`#14-project-settings`）

- 仓库：`luckyjamesriver/ai-solo-studio`（分支 `rebuild`）
- 依据规范：[`docs/ui/UI_v2.1.md`](../ui/UI_v2.1.md)（已冻结）、需求 v1.5 第 3/4 节、[`docs/adr/0002-no-subscription-api-only.md`](../adr/0002-no-subscription-api-only.md)（不接入订阅、不复用其他工具凭证）、[`docs/adr/0008-dependency-rules.md`](../adr/0008-dependency-rules.md) 与可点击原型 [`docs/ui/prototype.html`](../ui/prototype.html)（`#13-settings`、`#14-project-settings`）

---

## 1. 提交清单与内容摘要（大白话）

本阶段按要求拆为 4 个核心提交，外加 1 个在全量 E2E 压测中发现并修复的计划卡竞态修复提交（随后附 E2E、截图与本报告提交）：

1. **`feat(think): project brief as required context for ordinary projects`（[`e0598c5`](https://github.com/luckyjamesriver/ai-solo-studio/commit/e0598c550637ea595124a27de60ae0eb4282b6ab)）**
   - **让普通用户的项目也能发起讨论，而不必手动写开发文档。**
   - [`loadRequiredContext`](../../src/core/thinking/flow/support.ts) 改为固定优先级：优先读取项目内的 `docs/PROJECT_CONTEXT.md`（提取第 1、2、4 节，现有行为不变）；若不存在则读取应用管理的 `.studio/project-brief.md`（复用相同取节逻辑）；两份都不存在时**依然拒绝发起 AI 调用**，绝不放松必带层规则。
   - 新增 [`brief.ts`](../../src/core/thinking/flow/brief.ts) 与 [`ProjectBriefForm.tsx`](../../src/renderer/ProjectBriefForm.tsx)，提供 3 个问题（项目是什么 / 有什么不能违反的原则，选填 / 做给谁用），表单写明该简介会作为必带层发送给 AI 服务并遵守首次资料外发同意，**绝不在用户项目 `docs/` 下创建或修改任何文件**。
   - 在 [`DiscussionPage.tsx`](../../src/renderer/DiscussionPage.tsx) 点击「开始讨论」若检测到缺少必带层，不再直接报错卡死，而是先内联弹出项目简介表单，保存后自动继续开始讨论；在 [`ProjectBoard.tsx`](../../src/renderer/ProjectBoard.tsx)（项目设置 `#14-project-settings`）新增「项目简介」卡片供随时查看与修改（若项目已有 `docs/PROJECT_CONTEXT.md` 则只读展示「本项目使用 docs/PROJECT_CONTEXT.md」）。

2. **`feat(settings): Claude API key with encrypted storage and validation`（[`015511e`](https://github.com/luckyjamesriver/ai-solo-studio/commit/015511edfd6f59df4392abdf230484945bef3a6e)）**
   - **支持在设置里接入个人 Anthropic API Key，并且先验活、再加密保存、全程隔离明文。**
   - 新建 [`claude-key.ts`](../../src/core/app/claude-key.ts) 与测试 [`stage5b-claude-key.test.ts`](../../tests/stage5b-claude-key.test.ts)，在 [`app-store.ts`](../../src/core/app/app-store.ts) 封装 `update()`（仅作用于应用 `userData` 目录，符合 ADR 0006 边界），并在 [`disclosure.ts`](../../src/core/app/disclosure.ts) 按接入状态动态增加 `Anthropic` 首次外发说明服务项。
   - 主进程 [`main/index.ts`](../../src/main/index.ts) 接入 Electron 异步 `safeStorage`（`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`，拒绝 Linux `basic_text` 明文降级）：点击保存时先用 Node 内置 `fetch` 向 `/v1/messages` 发最小请求验证（失败按 `Key 无效` / `网络不通` / `服务不可用` 如实报错且对密钥字符串脱敏），验证通过后才加密写入应用数据目录。
   - 渲染层 [`SettingsPage.tsx`](../../src/renderer/SettingsPage.tsx) 最多展示后 4 位与状态，支持删除 Key；全项目源码与安全测试显式禁止读取 Claude Code / Claude 桌面应用 / Codex 等任何外部工具凭证目录（ADR 0002）。

3. **`feat(think): Claude API thinker`（[`a2eb5c3`](https://github.com/luckyjamesriver/ai-solo-studio/commit/a2eb5c3fd884c7cdf154d69f5487fa09d6b4c5a5)）**
   - **新增仅负责思考的 Claude API 思考者，不带任何工具、不虚构费用、不新增 npm 依赖。**
   - 新建 [`claude-api.ts`](../../src/core/thinking/claude-api.ts) 实现 `Thinker` 接口（服务名为 `'Anthropic'`），直接使用 Node 内置 `fetch` 请求 Anthropic Messages API：请求体严禁携带 `tools`，仅发送 `model`、`max_tokens`、`system`、`messages`，并兼容自适应思考响应中 `thinking` 与 `text` 混合内容块（若响应夹带 `tool_use` 块会主动收集到 `refusedToolRequests` 而不执行）。
   - 用量统计在 [`driver.ts`](../../src/core/thinking/flow/driver.ts) 与 [`DiscussionPage.tsx`](../../src/renderer/DiscussionPage.tsx) 增加 `inputTokens` / `outputTokens` / `hasTokenUsage`：直接展示 API 返回的输入与输出 token 数；**严格坚持零虚构原则**——除非响应本身返回 `cost_usd`，否则不内置价目表、不估算美元金额。
   - 错误分类复用 [`classifyServiceError`](../../src/core/thinking/errors.ts)（新增识别 Anthropic 的 `authentication_error` / `permission_error` / `credit balance` / `billing_error` / HTTP 401/402/403/429/529），保留原有开发期环境变量才可用的 `dev-personal`（`ClaudeCliThinker`）不变，并补充默认跳过的真实 API 集成测试 [`claude-api.real.test.ts`](../../tests/integration/claude-api.real.test.ts)。

4. **`feat(settings): AI access and role settings with project override`（[`ebc6ae5`](https://github.com/luckyjamesriver/ai-solo-studio/commit/ebc6ae520bfa10aee486dc23bcf17bc40dfc4c20)）**
   - **全局配置 AI 接入与默认角色、项目支持覆盖，并在讨论开始时锁定角色。**
   - 新建 [`ai-settings.ts`](../../src/core/app/ai-settings.ts) 与测试 [`stage5b-ai-roles.test.ts`](../../tests/stage5b-ai-roles.test.ts)：未配置时产品默认值为「首席 Codex、不复核、执行 Codex」（与阶段 5a 一致）；未接入的 AI 不允许保存；删除 Claude Key 后全局与各项目用到 Claude 的角色自动回退为 `unset`（「未设置」）并在下一次开始讨论前提示。
   - 设置页 `#13-settings`（[`SettingsPage.tsx`](../../src/renderer/SettingsPage.tsx) 默认「AI 与角色」页签）展示 Codex 与 Claude 接入状态、默认角色（首席/复核下拉、可选 Claude 模型、「执行」固定纯文字 Codex 不放下拉框），当首席与复核选同一个 AI 时显示「未经独立评审」提示，且 [`driver.ts`](../../src/core/thinking/flow/driver.ts) 按单思考者模式运行。
   - 项目设置 `#14-project-settings`（[`ProjectBoard.tsx`](../../src/renderer/ProjectBoard.tsx)）支持「跟随全局设置 / 本项目单独设置」切换；讨论在真正开始调用思考前（`isThreadStarted` 为真、调用 [`lockThreadRoles`](../../src/core/thinking/flow/driver.ts)）按「项目设置 → 全局设置」确定首席和复核并写入线程记录，中途修改设置不影响已开始的线程；[`DiscussionPage.tsx`](../../src/renderer/DiscussionPage.tsx) 顶部清晰展示本线程实际「首席」与「复核」。

5. **E2E 全量压测竞态修复：`fix(plan): await mode save before closing full-trust cancel dialog`（[`4ae7d53`](https://github.com/luckyjamesriver/ai-solo-studio/commit/4ae7d53)）**
   - 全量跑 44 项 E2E 时暴露出 [`PlanCard.tsx`](../../src/renderer/PlanCard.tsx) 原 `cancelTrust` 的已有竞态：`cancelTrust` 先调用 `setShowTrust(false)` 卸载确认弹窗，再异步发送 `savePlan('standard')`；若紧接着重新勾选「完全信任」，稍后返回的 `savePlan` 回调通过 `onChanged` 触发 `useEffect` 把界面又刷回 `standard`，造成后续点击开工未弹确认框。改为通过 `savePromiseRef` 跟踪并等待 `savePlan` 完成及任务状态更新后再在 `finally` 中关闭确认弹窗。

---

## 2. Claude API Key 的完整存储与使用路径（防泄露闭环）

从用户输入到最终发出 HTTP 请求，密钥经历的每一环节与解密边界如下：

1. **界面输入（渲染进程 [`SettingsPage.tsx`](../../src/renderer/SettingsPage.tsx)）**
   - 用户在密码框输入密钥字符串，仅存在于该组件临时 React state 中；保存成功后立刻清空输入框，取消编辑不落盘，渲染层源码禁用 `apiKey` / `api_key` 标识符（由 `security.test.ts` 强制校验）。
2. **Preload 与 IPC 传入（[`preload/index.cts`](../../src/preload/index.cts) → [`main/index.ts`](../../src/main/index.ts)）**
   - 仅通过 `window.studio.saveClaudeKey(secret: string)` 单向送入主进程 `settings:saveClaudeKey` handler；Preload 与主进程不暴露任何读取明文、`decrypt`、`cipherB64` 或 `getSecret` IPC 接口。
3. **验证与加密落盘（仅主进程 + [`ClaudeKeyStore.save`](../../src/core/app/claude-key.ts)）**
   - **安全存储前检**：主进程注入的 `SecretVault.isAvailable()` 先检查 Electron `safeStorage.isAsyncEncryptionAvailable()`，并在 Linux 环境下显式拒绝 `basic_text` 明文降级模式；不可用时直接拒绝保存并返回原因，绝不明文写入磁盘。
   - **最小请求验活**：[`validateAnthropicKey`](../../src/core/app/claude-key.ts) 带着密钥作为 `x-api-key` 请求头，通过 Node `fetch` POST 到 `https://api.anthropic.com/v1/messages`（`anthropic-version: 2026-10-21`、`max_tokens: 16`、`messages: [{ role: 'user', content: 'ok' }]`，无工具）；失败时把错误归类为 `Key 无效` / `网络不通` / `服务不可用` 并用 [`redactSecret`](../../src/core/thinking/claude-api.ts) 剥离任何可能回显的密钥后返回，不落盘。
   - **加密写入应用目录**：验证成功后调用 `safeStorage.encryptStringAsync(secret)` 生成 Base64 密文 `cipherB64`，再经 [`AppStore.update`](../../src/core/app/app-store.ts) 将 `{ configured: true, cipherB64, last4, verifiedAt }` 写入应用 `userData` 下的受管存储（记录 ID `claude-api-key`），对渲染层和 IPC 仅返回 `{ configured, available, last4, verifiedAt, unavailableReason }`（最多 4 位尾号）。
4. **运行期即时解密与请求发出（仅主进程内存）**
   - 当讨论或对话选中 Claude 时，主进程为 [`ClaudeApiThinker`](../../src/core/thinking/claude-api.ts) 注入按次闭包 `getSecret: () => claudeKeys.getSecret()`，**思考者实例本身不保存明文 Key 字段**。
   - 只在每次执行 `detect()` 或 `think()` 时，才由主进程侧调用 [`ClaudeKeyStore.getSecret()`](../../src/core/app/claude-key.ts) 读取 `cipherB64`、通过 `safeStorage.decryptStringAsync` 在主进程内存瞬间解出明文，直接放入 Node `fetch` 请求头 `'x-api-key': secret` 发出 HTTPS 请求。
   - 响应报错与原始文本经过 `redactSecret(..., secret)` 清洗后才返回上层，密钥不会进入磁盘线程记录（`.studio/threads/`）、任务记录、日志、控制台摘要或界面截图。
5. **删除与角色回退**
   - 点击删除触发 `settings:deleteClaudeKey` → [`ClaudeKeyStore.delete`](../../src/core/app/claude-key.ts) 覆写应用存储为 `{ configured: false, deletedAt }`（物理清除 `cipherB64` 与 `last4`），同时调用 [`AiSettingsStore.onClaudeKeyDeleted`](../../src/core/app/ai-settings.ts) 把全局及全部项目配置里的 `'claude'` 自动回退为 `'unset'`（「未设置」）。

---

## 3. Claude 默认模型名称与官方文档查证来源

- **代码默认值**：`DEFAULT_CLAUDE_API_MODEL = 'claude-opus-5-5'`（定义于 [`src/core/thinking/claude-api.ts#L5-L6`](../../src/core/thinking/claude-api.ts#L5-L6)），并在设置页默认角色卡片中提供模型可配置项（同时列出官方当前同代模型建议 `claude-opus-5-5`、`claude-sonnet-4-6`、`claude-haiku-4-5` 并允许填入其他模型 ID）。
- **API 版本头与请求约定**：`ANTHROPIC_API_VERSION = '2026-10-21'`；按官方该版本变更移除了 `temperature` / `top_p` / `top_k` 采样参数，请求体仅发 `model`、`max_tokens`、`system`、`messages`，并从响应 `content` 数组中过滤提取 `block.type === 'text'`（兼容前置 `type: 'thinking'` 自适应思考块）。
- **官方文档查证来源（查证时间：`2026-11-10`）**：
  - 模型总览与推荐模型：`https://platform.claude.com/docs/en/about-claude/models/overview`（及 `choosing-a-model.md`）
  - API 版本与参数变化：`https://platform.claude.com/docs/en/api/versioning`（及 `get-started.md`）
  - Opus 5.5 新特性与自适应思考说明：`https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5.md`

---

## 4. `tests/security.test.ts` 逐条变更说明

所有原有安全断言保持零删除、零放宽，本次仅做如下同步登记与新增断言（全部 **54 条**全部通过）：

1. **第 249、254 行（`M3-A2` 具体思考者实现扫描）**：在 `concrete` 正则补充 `ClaudeApiThinker` 与 `claude-api(?:\.js)?['"]`，并在思考层入口排除正则补充 `claude-api`，确保 `src/core/thinking/flow` 与 `src/core/thinking/handoff` 依然零直接依赖具体思考者实现。
2. **第 280–316 行 & 第 474–485 行（Preload IPC 精确白名单与参数形态登记）**：
   - 将受控 IPC 方法列表从 **46** 项扩增至 **55** 项，按前例在对应分组登记 `getProjectBrief`、`saveProjectBrief`、`getClaudeKeyStatus`、`saveClaudeKey`、`deleteClaudeKey`、`getAiSettings`、`saveAiRoles`、`getProjectRoles`、`saveProjectRoles`；`NEW` 精确参数字典同步登记上述 9 个方法。
   - `SHAPES` 与 `MAIN_SHAPES` 新增对应固定参数形态（`secret: string`、`chief: string, reviewer: string, model: string`、`projectId: string, brief: ProjectBriefInput`、`projectId: string, mode: string, chief: string, reviewer: string`），并增加对 `ProjectBriefInput` 的结构检查（含 `whatItIs: string`，禁用一切路径类字段）。
3. **第 826–827 行（`projectId` 校验守卫计数）**：将带 `projectId` 且必须首先经过 `controllerFor(projectId)` / `projectStatus(projectId)` / `openProjects.close(projectId)` 校验的主进程 handler 精确计数从 **36** 同步更新为 **40**（新增 2 个简介读写 handler 与 2 个项目角色读写 handler）。
4. **第 1067–1119 行（新增「阶段 5b：Claude API Key 安全隔离与外部凭证禁读（只增不减）」3 条测试）**：
   - **禁止读取外部工具凭证与禁止降级明文加密**：去注释扫描全源码（仅允许 `modes.ts` 沙箱拒读黑名单），禁止出现 `.claude.json`、`.claude/credentials|settings|statsig`、`Application Support/Claude`、`.config/Claude`、`AppData/Roaming/Claude`、`com.anthropic.claudefordesktop`、`.codex/auth.json`、`.credentials.json`、`security find-*-password`、`keytar`、`setUsePlainTextEncryption`（附 6 条正则有效性自检样本）；并断言主进程使用异步 `safeStorage.isAsyncEncryptionAvailable(`、`encryptStringAsync(`、`decryptStringAsync(`、拦截 `basic_text` 且禁止 `setUsePlainTextEncryption`。
   - **渲染层零 `apiKey` 明文字段、Preload 零密钥读取透传**：全量扫描 `src/renderer/` 禁止匹配 `\bapiKey\b|api_key`（不区分大小写，附自检样本），并断言 `src/preload/index.cts` 不含 `getSecret|decrypt|cipherB64`。
   - **执行者锁定为固定文字且禁读 dev 环境变量**：断言 `SettingsPage.tsx`（`global-role-executor`）与 `ProjectBoard.tsx`（`project-role-executor`）均不得出现 `<select[^>]*executor`，且 `src/core/app/ai-settings.ts` 不出现 `DEV_PERSONAL_ENV`。

---

## 5. 与规范或原型的差异与原因说明

1. **`#13-settings` 省略「额度与接手」页签、`额度` 与 `额度用完时` 卡片**：严格遵循阶段 5b 范围明确排除项（「不做：额度面板、DeepSeek、预算设置页、导出给外部工具」），不在界面保留未实现功能的空占位。
2. **`#13-settings` 与 `#14-project-settings` 的「执行」角色不使用下拉框**：原型中「执行」位置以选择控件样式示意，阶段 5b 需求明确要求「执行（只有 Codex，显示为固定文字，不放下拉框）」，已改为只读固定文本卡片并用 `security.test.ts` 守卫禁止还原为下拉框。
3. **设置与项目设置的增量细节**：按阶段 5b 功能要求，在 `#13-settings`「默认角色」卡片中补充了可选的「Claude 模型」配置输入（默认 `claude-opus-5-5`）；在 `#14-project-settings` 增加「项目简介」卡片供普通用户查看与维护 `.studio/project-brief.md`（若存在 `docs/PROJECT_CONTEXT.md` 则只读提示）。

---

## 6. 阶段 5b 截图清单（`docs/screenshots/stage5b/`）

全部由本地 Electron E2E 自动截取并人工核验无误（界面不含真实 Key，仅测试用假密钥末尾 4 位）：

| 序号 | 文件名 | 对应场景与核验要点 |
|---|---|---|
| 1 | [`01-project-brief-form.png`](../screenshots/stage5b/01-project-brief-form.png) | 无简介项目点击「开始讨论」先弹出 3 问项目简介表单 + 外发说明 |
| 2 | [`02-project-settings-brief.png`](../screenshots/stage5b/02-project-settings-brief.png) | 项目设置 `#14-project-settings` 中查看/修改项目简介 + 项目角色覆盖开关 |
| 3 | [`03-settings-unset.png`](../screenshots/stage5b/03-settings-unset.png) | 设置页 `#13-settings`「AI 与角色」初始状态（Codex 已登录、Claude Key 未设置） |
| 4 | [`04-settings-key-invalid.png`](../screenshots/stage5b/04-settings-key-invalid.png) | 输入无效 Key 验证失败时的明确分类错误提示（`Key 无效`）与未落盘状态 |
| 5 | [`05-settings-key-valid.png`](../screenshots/stage5b/05-settings-key-valid.png) | 验证通过加密保存后，仅展示已设置状态、可用性与测试用假密钥最多后 4 位（不含真实密钥） |
| 6 | [`06-settings-same-ai.png`](../screenshots/stage5b/06-settings-same-ai.png) | 首席与复核选择同一个 AI 时实时展示「未经独立评审」说明，执行列为固定 Codex 文字 |
| 7 | [`07-discussion-dual-claude.png`](../screenshots/stage5b/07-discussion-dual-claude.png) | 首席 Claude（API）+ 复核 Codex 双思考者讨论界面，顶部显示本线程锁定角色、出现「与复核对话」页签、右侧统计输入/输出 token 且不虚构美元金额 |

---

## 7. 验证结果、过程中遇到的失败及 CI

### 本地验证结果（全量通过）
- `npm run typecheck`：退出码 `0`
- 全量单元测试（`npx vitest run --maxWorkers=4`）：**32 个文件通过，12 个真实环境/联网集成测试按条件跳过（共 44 个文件）；594 个用例通过，38 个集成用例跳过，0 失败**（耗时 `89.20s`；其中 [`tests/flow.test.ts`](../../tests/flow.test.ts) 54 项、[`tests/thinking.test.ts`](../../tests/thinking.test.ts) 34 项、[`tests/stage5-discuss.test.ts`](../../tests/stage5-discuss.test.ts) 11 项、[`tests/stage5b-claude-key.test.ts`](../../tests/stage5b-claude-key.test.ts) 4 项、[`tests/stage5b-ai-roles.test.ts`](../../tests/stage5b-ai-roles.test.ts) 3 项、[`tests/security.test.ts`](../../tests/security.test.ts) 54 项全部通过；[`tests/integration/claude-api.real.test.ts`](../../tests/integration/claude-api.real.test.ts) 默认跳过）。
- 构建与冒烟测试（`npm run build && npm run smoke`）：全部 PASS（精确校验 `window.studio` 共 **55** 个 IPC 方法与五层环境体检，退出码 `0`）。
- 全量 Electron E2E（`E2E_STAGE5B_SHOT_DIR=docs/screenshots/stage5b npm run test:e2e`）：**44 / 44 全部通过**（耗时 `198.71s`，0 失败、0 跳过）。

### 过程中遇到的所有失败及根因修复
1. **提交①单测报错缺少 Git 仓库**：[`stage5-discuss.test.ts`](../../tests/stage5-discuss.test.ts) 新增简介回退测试初用普通空目录而非 `makeRepo`，讨论绑定在工作树隔离检查时要求合法 Git 仓库；改用 `makeRepo` 初始化测试仓库后通过。
2. **Electron 45 `safeStorage.decryptStringAsync` 类型错误（提交② `typecheck` 捕获）**：Electron 45 的异步解密方法返回 `{ result: string, shouldReEncrypt: boolean }` 对象而非直接返回字符串；在主进程 `SecretVault.decrypt` 读取 `.result` 后通过类型检查。
3. **ADR 0006 `RecordStore` 边界拦截（提交② `security.test.ts` 捕获）**：`claude-key.ts` 初稿直接 `import type { OpenOptions } from '../persistence/index.js'` 触发持久化模块导入白名单限制；在 `app-store.ts` 导出 `AppStoreOptions` 类型并由 `claude-key.ts` 与 `ai-settings.ts` 复用后遵守边界。
4. **`parseStructured` 返回字段名误差（提交③ `typecheck` 捕获）**：`ClaudeApiThinker` 初稿误用 `structured.value`（实际为 `structured.content`）；修正字段名后通过编译与单测。
5. **`FakeThinker.displayName` 文案差异（提交③ `stage5-discuss.test.ts`）**：`FakeThinker` 默认展示名为 `'模拟思考者（测试用）'` 而非固定英文 `'Fake'`；调整断言匹配真实返回值。
6. **假 Anthropic 服务在 E2E 阶段匹配顺序问题 & 组件断言细化（初跑阶段 5b E2E 时发现）**：
   - `draft` 阶段 prompt 的 JSON Schema 带有 `"items"` 字段，先匹配 `"items"` 误命中了 `REQ` 分支而非 `DRAFT`；调整假服务按最特征键顺序判断（`"resolutions"` → `REVISE`，`"requirement_checks"` → `REVIEW`，`"coverage"` → `DRAFT`，其余 → `REQ`）。
   - `ProjectBoard` 项目设置页签实际 `data-testid` 为 `tab-project-settings`，表单 `<textarea>` 内容应使用 Playwright `.inputValue()` 读取而非 `.innerText()`。
7. **删除 Claude Key 后在 `chief='unset'` 时无法创建草稿任务（真实业务流缺陷）**：当用户此前将首席设为 Claude、复核设为 Codex，随后删除 Claude Key 时，首席自动回退为 `unset`；此时新建草稿任务进入 [`DiscussionService.ensureBoundThread`](../../src/core/app/discussion-service.ts) 会触发「尚未开始」分支传出 `single: false` 但未提供双思考者，被 `FlowEngine` 抛出 `需要评审者；或使用单思考者模式（single）`。已在 `resolveUnstartedPlan` 中为未开始的占位草稿线程显式传递 `single: true` 并补充回归单测。
8. **全量 E2E 运行中 [`PlanCard.tsx`](../../src/renderer/PlanCard.tsx) `完全信任` 取消后竞态超时（43/44 通过，1 项超时）**：如第 1 节所述，`cancelTrust` 先卸载确认框再异步保存 `standard` 模式，高负载下被紧随其后的勾选操作触发竞态覆写；在 `4ae7d53` 中通过 `savePromiseRef` 跟踪并在保存及 `onChanged` 完成后再关闭确认面板，全量 44/44 E2E 一次稳定通过。

### GitHub Actions 双平台 CI（`rebuild` 分支）
- 验证运行（`e57afe1`，含全部代码、[`4ae7d53`](https://github.com/luckyjamesriver/ai-solo-studio/commit/4ae7d53) 竞态修复、全部 44 项 E2E、7 张阶段 5b 截图与本报告）：[https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42857375346](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42857375346)
  - `test (ubuntu-latest)`：`success`（1m3s，[job 129973983878](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42857375346/job/129973983878)，含 `typecheck`、`npm test`、`build`）
  - `test (macos-latest)`：`success`（4m47s，[job 129973983264](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42857375346/job/129973983264)，含 `typecheck`、`npm test`、`build` 与 macOS 全部 Electron E2E）

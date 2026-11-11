# 阶段 8A 完成报告 · 通用 AI API 执行底座、连接测试、加密存储与执行者切换

- 仓库：`luckyjamesriver/ai-solo-studio`（分支 `rebuild`）
- 依据文档：[`ADR 0008`](../adr/0008-dependencies.md)（依赖规则，零新增 npm 依赖）、[`ADR 0010`](../adr/0010-multi-executor-and-opt-in-subscriptions.md)（多执行者架构与订阅制知情自担风险）、[`docs/plans/2026-11-11-multi-executor.md`](../plans/2026-11-11-multi-executor.md)
- 实施边界：
  - **本阶段完成（Stage 8A）**：12 家主流 AI 服务商与自定义端点（底层收敛 3 套协议、原生 `fetch`）、两步连接测试（鉴权可达性 + Tool Calling 握手）、Electron `safeStorage` 分库加密存储、`ApiAgentExecutor` 任务副本隔离工具环路、全局默认 / 项目覆盖 / 计划卡任务级执行者切换、`unset` 回退保护与动态「资料外发」告知清单。
  - **延后实施（不在本阶段范围）**：Stage 8B（`acp` / `claude-cli` 本地订阅 CLI 执行适配器与知情确认弹框）与 Stage 8C（脱离 Codex CLI 的独立 macOS `sandbox-exec` 检查运行器）。本阶段当本机未安装 Codex CLI 时，API 执行者诚实沿用既有的 `unchecked_needs_confirm`（需用户确认未检查）路径，不伪造已检查结果。

---

## 1. 提交清单

1. **`docs(adr,plan): add ADR 0010 and Stage 8 multi-executor plan`（[`d8ec0b1`](https://github.com/luckyjamesriver/ai-solo-studio/commit/d8ec0b1)）**
   - 确立多执行者统一抽象、消费级订阅工具的风险告知与显式授权门禁、3 期拆解路线与安全测试修订规约。
2. **`feat(providers): add API provider catalog, 3-protocol verification client and encrypted profile store`（[`c5146e5`](https://github.com/luckyjamesriver/ai-solo-studio/commit/c5146e5)）**
   - 新增 [`src/core/executor/api/catalog.ts`](../../src/core/executor/api/catalog.ts)：内置 12 家服务商预设、端口校验 `normalizeApiEndpoint`（远程强制 HTTPS，仅本机回环允许 HTTP）与官方域名判定 `isOfficialEndpointForPreset`。
   - 新增 [`src/core/executor/api/client.ts`](../../src/core/executor/api/client.ts)：基于 Node 内置 `fetch` 实现 `openai_compat`、`anthropic`、`gemini` 三协议请求封装 `callProviderModel`、可用模型拉取 `fetchProviderModels`、两步连接测试 `testProviderConnection`（鉴权/模型测试 + `PING_TOOL` 工具调用握手）与错误脱敏 `redactApiSecrets`。
   - 新增 [`src/core/app/provider-profiles.ts`](../../src/core/app/provider-profiles.ts)：`ProviderProfileStore` 使用 `SecretVault`（Electron `safeStorage`）把配置元数据存放在 `provider-profiles`，把密钥密文独立存放在 `provider-secrets`；`safeStorage` 不可用时拒绝保存且绝不明文落盘，界面与视图仅返回 `last4` 尾号、来源域与 `executorReady` 标记。
   - 新增 [`tests/stage8a-providers.test.ts`](../../tests/stage8a-providers.test.ts)（3 个用例）。
3. **`feat(executor): add ApiAgentExecutor and dynamic task executor resolution`（[`617334e`](https://github.com/luckyjamesriver/ai-solo-studio/commit/617334e)）**
   - 新增 [`src/core/persistence/worktree-fs.ts`](../../src/core/persistence/worktree-fs.ts)：提供受 `ADR 0006` 持久化目录边界管控的 `writeWorktreeTextFile`（不扩展既有 `FS_WRITE_EXEMPT` 白名单）。
   - 新增 [`src/core/executor/adapters/api-agent.ts`](../../src/core/executor/adapters/api-agent.ts)：实现 `Executor` 接口（工具：`list_dir`、`read_file`、`search_files`、`write_file`、`edit_file`、`run_command`），强制执行 `realpath` 防符号链接逃逸任务副本、`.git` 目录写删禁止、`sensitiveFallbackList` 敏感凭证路径读拒绝、完全信任模式下必须经 `requireFullTrustConfirmed` 门禁、支持 `AbortController` 立即 `stop()`、全程日志密钥脱敏，且环境限制说明以 `source: 'host'` 消息呈现（不误写 `iso.warnings` 以免误阻断 `saveBlockers`）。
   - 更新 [`src/core/task/runner.ts`](../../src/core/task/runner.ts)：新增 `RunnerOptions.resolveExecutor`、`create(req, initialExecutor?)`、`setTaskExecutor(id, executorId, executorName)` 与按任务解析的 `sandboxForTask(t)`。
   - 新增 [`tests/stage8a-executor.test.ts`](../../tests/stage8a-executor.test.ts)（3 个用例）。
4. **`feat(settings,task): wire verified API executors into settings, project/plan selector and disclosure`（[`975971f`](https://github.com/luckyjamesriver/ai-solo-studio/commit/975971f)）**
   - 扩展 [`src/core/app/ai-settings.ts`](../../src/core/app/ai-settings.ts)（`buildVerifiedExecutorOptions`、`saveDefaultExecutor`、`saveProjectExecutor`、`onProviderProfileDeleted`、`resolveEffectiveExecutor`）、[`src/core/app/disclosure.ts`](../../src/core/app/disclosure.ts)（动态 `apiServices` 清单）与 [`src/core/app/task-controller.ts`](../../src/core/app/task-controller.ts) / [`src/core/app/task-view.ts`](../../src/core/app/task-view.ts)。
   - 更新 [`src/main/index.ts`](../../src/main/index.ts)、[`src/preload/index.cts`](../../src/preload/index.cts)、[`src/renderer/api.ts`](../../src/renderer/api.ts)、[`src/renderer/App.tsx`](../../src/renderer/App.tsx)、[`src/renderer/SettingsPage.tsx`](../../src/renderer/SettingsPage.tsx)、[`src/renderer/ProjectBoard.tsx`](../../src/renderer/ProjectBoard.tsx)、[`src/renderer/PlanCard.tsx`](../../src/renderer/PlanCard.tsx)、[`scripts/smoke.mjs`](../../scripts/smoke.mjs) 与 [`tests/security.test.ts`](../../tests/security.test.ts)（IPC 白名单增至 70 项，受 `projectId` 校验保护增至 49 项）。
   - 新增 [`tests/stage8a-controller.test.ts`](../../tests/stage8a-controller.test.ts)（3 个用例）。
5. **`feat(e2e): add Stage 8A multi-executor E2E tests, screenshots and UX fixes`（[`a192d60`](https://github.com/luckyjamesriver/ai-solo-studio/commit/a192d60)）**
   - 修复审查截图与全套 E2E 跑出的 5 处细节：
     1. 修复 `SettingsPage.tsx` 与 `ProjectBoard.tsx` 窄列卡片内执行者下拉框超宽溢出卡片边框的问题，并在全局与项目执行者行新增独立「应用执行者」按钮（未安装 Codex CLI 或未配 Claude Key 时仍可独立指定/切换 API 执行者）。
     2. 修复 `ProjectBoard.tsx` 切换「项目设置」页签时 `rolesView` 异步加载完成前提前渲染导致选项回弹与脱离 DOM 的竞态；并初始化 `roleMode` 兼顾 `rv.executorMode === 'custom'`。
     3. 移除 `SettingsPage.tsx` 渲染层内字面 `https://...` 默认值与占位文本，改为从 core 下发的服务商预设读取（满足 [`tests/design-tokens.test.ts`](../../tests/design-tokens.test.ts) 规则）。
     4. `TaskController` 对 Codex 执行者存入任务记录的 `displayName` 保持 `'Codex'`（下拉框选项仍清晰显示 `'Codex（本机）'`），保证既有任务卡片与验收头文案一致。
     5. 修复 `TaskRunner.sandboxForTask()` 对 `'external'`（Stage 7 外部交接任务）与 `'unset'` 回退本地沙箱检查器，保证 Stage 7 导入报告后的试运行检查正常触发。
   - 新增 Stage 8A Electron E2E 用例（[`e2e/shell.e2e.ts`](../../e2e/shell.e2e.ts)）与 8 张截图 [`docs/screenshots/stage8a/`](../screenshots/stage8a/)。

---

## 2. 内置 AI API 目录（12 项预设 → 3 套协议）

| 分类 | 服务商 ID | 名称 | 底层协议 | 典型推荐模型 | 密钥要求 |
|---|---|---|---|---|---|
| 国内直连 | `deepseek` | DeepSeek | `openai_compat` | `deepseek-chat`, `deepseek-reasoner` | 必填 |
| 国内直连 | `qwen` | 阿里百炼（Qwen） | `openai_compat` | `qwen3-coder-plus`, `qwen3-coder-flash` | 必填 |
| 国内直连 | `zhipu` | 智谱（GLM） | `openai_compat` | `glm-4.5`, `glm-4.5-air` | 必填 |
| 国内直连 | `moonshot` | 月之暗面（Kimi） | `openai_compat` | `kimi-k3`, `kimi-k3.1-pro` | 必填 |
| 国内直连 | `minimax` | MiniMax | `openai_compat` | `MiniMax-M3.1-Flash` | 必填 |
| 国际官方 | `openai` | OpenAI | `openai_compat` | `gpt-5`, `gpt-5-mini`, `gpt-5.5` | 必填 |
| 国际官方 | `anthropic` | Anthropic（Claude API） | `anthropic` | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` | 必填 |
| 国际官方 | `gemini` | Google Gemini API | `gemini` | `gemini-3.8-flash`, `gemini-3.5-flash`, `gemini-2.5-pro`, `gemini-4-argon` | 必填 |
| 国际官方 | `xai` | xAI（Grok） | `openai_compat` | `grok-code-fast-1`, `grok-4` | 必填 |
| 聚合入口 | `openrouter` | OpenRouter（聚合） | `openai_compat` | `anthropic/claude-sonnet-4.5` 等 | 必填 |
| 本机推理 | `ollama` | 本地模型（Ollama / LM Studio） | `openai_compat` | `qwen2.5-coder:32b`, `deepseek-r1:14b` | 可留空 |
| 通用自定义 | `custom_openai` | 自定义 OpenAI 兼容服务 | `openai_compat` | 手动填写 | 默认必填（支持免密后端） |

- 两步连接测试：第 1 步校验密钥与模型可达性（出错分类为 `invalid_key` / `model_not_found` / `rate_limit` / `network` / `service_unavailable`）；第 2 步发送带单个 `PING_TOOL` 工具定义的请求确认服务端支持 Tool Calling。支持鉴权但不支持 Tool Calling 的模型允许保存为 **「仅支持对话」**（`toolCallingSupported: false`、`executorReady: false`），绝不进入全局、项目或计划卡的可选执行者列表。

---

## 3. 按 `ADR 0010 §5` 对既有安全基线与角色测试的修订对照

1. **[`tests/security.test.ts`](../../tests/security.test.ts) · 执行者配置约束**
   - **原断言（阶段 5b 固定仅 Codex 版）**：
     ```ts
     it('AI 角色设置只允许固定枚举且禁止通过全局或项目角色配置接入非 Codex 执行者', () => {
       ...
       expect(sp).toContain('data-testid="global-role-executor"');
       expect(sp).not.toMatch(/<select[^>]*executor/i);
       expect(pb).toContain('data-testid="project-role-executor"');
       expect(pb).not.toMatch(/<select[^>]*executor/i);
     });
     ```
   - **新断言（依据 ADR 0010 修订为「只允许连接测试与工具调用双重通过的执行者」）**：
     ```ts
     it('AI 角色与执行者设置只允许已验证通过的配置（ADR 0010 修订原仅限 Codex 约束）；禁止环境变量自动激活与未经测试保存', () => {
       ...
       expect(sp).toContain('data-testid="global-role-executor"');
       expect(pb).toContain('data-testid="project-role-executor"');
       expect(sp).toContain('aiSettings?.verifiedExecutors');
       expect(pb).toContain('rolesView?.verifiedExecutors');
       expect(ai).not.toMatch(/DEV_PERSONAL_ENV/);
       expect(ai).toMatch(/executorReady/);
       expect(ai).toMatch(/verified\.some\(\(v\) => v\.id === id\)/);
       expect(profilesSrc).toContain('testProviderConnection');
       expect(profilesSrc).toContain('executorReady: tested.toolCallingSupported');
       expect(profilesSrc).toContain('this.vault.isAvailable()');
     });
     ```
2. **[`tests/stage5b-ai-roles.test.ts`](../../tests/stage5b-ai-roles.test.ts) 与 [`e2e/shell.e2e.ts`](../../e2e/shell.e2e.ts) 阶段 5b 执行者列表断言**
   - **原断言**：`expect(htmlSettings).not.toMatch(/<select[^>]*executor/i)` 及 `expect(await a.page.locator('select[data-testid*="executor"]').count()).toBe(0)`。
   - **新断言**：验证 `<select data-testid="global-role-executor">` 在未添加已验证 API 执行者时仅包含唯一默认选项 `Codex（本机）`（`value="codex"`），严禁把尚未测试工具调用的 Claude API Key / 服务商列入可选执行者。
3. **新增安全基线条目**：
   - `tests/security.test.ts` 新增 `describe('阶段 8A：多 AI API 执行者安全边界（只增不减）')`：强制断言 `ApiAgentExecutor` 包含 `resolveRealOrNearestParent`、`containsDotGit`、`sensitiveFallbackList`、`requireFullTrustConfirmed` 且禁用 `child_process`/`proc/run`/`spawn(`；断言 `ProviderProfileStore` 的 `ProviderProfileView`、`listProfiles`、`getSecret` 之前片段、`deleteProfile`、`nextProfile` 与 `{ ok: ... }` 返回语句绝不泄露 `cipherB64` 或明文密钥。
   - IPC 白名单同步扩展并锁紧：新增 8 个无本地路径参数的 preload 方法（总计 70 项；`ProviderModelFetchInput` 使用 `savedId` 避免触发路径关键字匹配），49 个带 `projectId` 的主进程处理函数全部校验 `openProjects`。

---

## 4. 视觉核验截图（阶段 8A 真实 Electron E2E 生成）

| 序号 | 截图 | 验证界面状态 |
|---|---|---|
| 01 | [`01-provider-invalid-key.png`](../screenshots/stage8a/01-provider-invalid-key.png) | 设置页填写错误 DeepSeek Key 点击「连接测试并保存」→ 内联报错「Key 无效或无权限」，不回显输入密钥 |
| 02 | [`02-provider-chat-only.png`](../screenshots/stage8a/02-provider-chat-only.png) | 拉取模型并测试不支持 Tool Calling 的模型 → 列表标注琥珀色「仅支持对话」，不显示「设为默认执行者」，且未进入「执行」下拉框 |
| 03 | [`03-settings-providers-ready.png`](../screenshots/stage8a/03-settings-providers-ready.png) | 测试通过 `DeepSeek · deepseek-chat` 与 `Anthropic · claude-opus-5-5` → 双双标为绿色「可执行者」并隐藏仅保留尾号，全局默认已切换至 DeepSeek |
| 04 | [`04-disclosure-dynamic.png`](../screenshots/stage8a/04-disclosure-dynamic.png) | 「资料外发」弹窗动态列出当前已接入的 OpenAI、DeepSeek 与 Anthropic 服务及各自用途 |
| 05 | [`05-project-executor-override.png`](../screenshots/stage8a/05-project-executor-override.png) | 「项目设置 → AI 角色」切换「本项目单独设置」并单独指定 Anthropic 为本项目执行者（卡片无溢出） |
| 06 | [`06-plan-executor-select.png`](../screenshots/stage8a/06-plan-executor-select.png) | `#04-plan` 新任务继承项目执行者后通过「切换本次执行者」改选 DeepSeek，页头执行者实时更新 |
| 07 | [`07-acceptance-api-executor.png`](../screenshots/stage8a/07-acceptance-api-executor.png) | `ApiAgentExecutor` 在隔离副本中通过真实 Tool Calling 循环改写 `index.html`，进入 `#07-accept` 验收差异后安全保存回主项目 |
| 08 | [`08-settings-deleted-unset.png`](../screenshots/stage8a/08-settings-deleted-unset.png) | 删除被引用的全局 DeepSeek 配置 → 默认执行者安全回退为「未设置（请重新选择）」并红字提示，后续任务开工时被明确拦截 |

---

## 5. 测试与 CI 验证记录

### 本地完整验证（最后一次代码修改之后执行）
- `npm run typecheck`：通过（0 错误）
- `npx vitest run --maxWorkers=2`：**38 passed | 12 skipped (50 个文件)**，**623 passed | 38 skipped (661 项用例)**（跳过的 12 个文件 / 38 项用例均为需真实外部 CLI 或真实付费密钥的 `tests/integration/*.real.test.ts`）
  - 新增及更新关键单测全部通过：`tests/stage8a-providers.test.ts`（3/3）、`tests/stage8a-executor.test.ts`（3/3）、`tests/stage8a-controller.test.ts`（3/3）、`tests/stage5b-ai-roles.test.ts`（3/3）、`tests/security.test.ts`（59/59）、`tests/design-tokens.test.ts`（3/3）
- `npm run smoke`（含 `npm run build`）：通过（`window.studio` 恰好 71 个白名单键）
- `npm run test:e2e`：**Test Files 1 passed (1) · Tests 52 passed (52)**（无跳过、无失败；含 Stage 8A 新增端到端用例与全部 Stage 1～7 回归）

### GitHub Actions 双平台 CI
- 代码及报告首推 run [`43020433400`](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/43020433400)（提交 [`4ee5444`](https://github.com/luckyjamesriver/ai-solo-studio/commit/4ee5444)）：
  - **`test (ubuntu-latest)`**：`success`（1m 22s，`npm run typecheck`、`npm test`、`npm run build` 全绿）
  - **`test (macos-latest)`**：`success`（10m 51s，`npm run typecheck`、`npm test`、`npm run build`、`Electron end-to-end (macOS)` 包含阶段 8A 在内的全量 52 项 E2E 全绿）


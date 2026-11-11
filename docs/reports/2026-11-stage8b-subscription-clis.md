# 阶段 8B 完成报告：本机订阅制 CLI 知情自担风险接入（Claude Code / Antigravity / Cursor CLI）

- 日期：2026-11-11
- 分支：`rebuild`
- 依据文档：
  - `docs/adr/0010-multi-executor-and-opt-in-subscriptions.md`
  - `docs/plans/2026-11-11-multi-executor.md`
- 提交序列（阶段 8B）：
  1. `5c11a32` `feat(subscription): add risk catalog, persistence store and Claude Code CLI executor`
  2. `829f087` `feat(executor): add ACP executor adapter for Antigravity and Cursor CLI`
  3. `527e413` `feat(subscription): integrate subscription CLIs into settings, disclosure, controller and UI`
  4. `25b4f6c` `test(e2e): add Stage 8B subscription CLI end-to-end test and UI screenshots`
  5. （本报告与 CI 实证提交）

---

## 一、实现概览

1. **风险条款目录与强制门禁（`src/core/executor/cli/subscriptions.ts`）**：
   - 定义 `SubscriptionCliId = 'claude_cli' | 'agy' | 'cursor'` 与 `SUBSCRIPTION_CLI_CATALOG`，逐项列明对应服务条款冲突/账号连坐与额度风控条目、官方 API 替代入口与诚实隔离边界（`isolationHonesty`）。
   - 提供 `requireRiskAcknowledged(cliId, gate)`：任何本地订阅 CLI 适配器在 `start()` 拉起子进程前必须先经此门禁校验持久化确认记录，绝无绕过路径。
2. **订阅 CLI 状态与风险确认持久化（`src/core/app/subscription-clis.ts`）**：
   - `SubscriptionCliStore` 持久化 `{ enabled, model, riskAcknowledgedAt, acknowledgedRiskVersion, lastVerifiedAt }` 至应用数据目录（`AppStore` 记录 `subscription-clis`），默认全部关闭、绝不自动启用，也不读取/保存任何外部工具账号凭证。
   - `testAndEnable` 校验 `riskAck === true` 与实时探测结果（已安装 + 未处于未登录状态）；`disable` 删除记录并触发 `AiSettingsStore.onSubscriptionDisabled(cliId)` 将引用它的全局或项目默认执行者回退为 `'unset'`。
3. **Claude Code 受限订阅执行适配器（`src/core/executor/adapters/claude-code.ts`）**：
   - 使用实际 CLI 探测校准确认的受限参数：`claude -p --output-format stream-json --input-format stream-json --safe-mode --restricted --strict-mcp-config --disable-slash-commands --no-session-persistence --permission-prompts none --permission-mode acceptEdits --settings <inlineJson>`，提示词经 stdin 传入。
   - 启动子进程前强制 `requireRiskAcknowledged` 且从子进程环境剔除 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等 API 密钥变量，绝不向 `claude` 传递任何跳过权限参数。
4. **通用 ACP（Agent Client Protocol）执行适配器（`src/core/executor/adapters/acp.ts`）**：
   - 支持 Antigravity（`agy acp --sandbox --include-default-customizations=false --stdio`）与 Cursor CLI（`agent --sandbox enabled --workspace <cwd> [--model <m>] acp`）通过 stdio JSON-RPC 2.0 握手运行。
   - `session/request_permission` 回调内逐项核验工作树边界、`containsDotGit`、敏感目录黑名单（`sensitiveFallbackList`）与高危命令风险（`assess`）：越界/敏感读取/`.git`/未开启联网或高风险命令一律返回 `reject-once` 并向任务时间线写入 `blocked` (`DeniedOperation`)，最终展示到验收页「被拦下的操作」待用户逐条确认。
   - 停止时发送 `session/cancel` 后执行 `SIGTERM`（超时转 `SIGKILL`）；子进程启动前强制剔除 API 密钥环境变量。
5. **设置界面、外发清单与计划确认页集成（`src/main/index.ts`、`src/core/app/ai-settings.ts`、`src/core/app/task-controller.ts`、`src/core/app/task-view.ts`、`src/renderer/SettingsPage.tsx`、`src/renderer/PlanCard.tsx`）**：
   - 全局设置「AI 与角色」新增通栏区块「本机订阅 CLI 执行者（风险自担）」：展示本机探测状态、可选模型输入框与逐项风险弹窗（未勾选确认前禁用确认按钮），支持设为默认、重新检测与停用。
   - 外发清单 `Disclosure` 动态列出已启用的订阅 CLI 与风控计费说明；计划确认页（`#04-plan`）支持切换 `sub:*` 执行者并下发 `executorNotice` 诚实隔离提示条（渲染层不含任何 `INTERNAL_WORDS`）。
   - 为避免在每轮任务创建时重复触发耗时较大的本机 `agy --version` / `agy models`（实测约 3.2s + 3.7s）外部探测，主进程对订阅探测加入 30 秒路径感知缓存，并在未启用任何订阅 CLI 的路径采用 `onlyIfEnabled` 快速跳过，同时在「测试并启用」「停用」「重新体检」及可执行路径变化时立即失效缓存。

---

## 二、真机 CLI 实测校准记录

| 工具 | 实测版本 / 命令 | 参数与探测结论 |
| --- | --- | --- |
| Claude Code (`claude`) | `2.1.319` | `claude auth status`（未登录/已登录返回 JSON 与退出码）；支持 `--safe-mode --restricted --strict-mcp-config --disable-slash-commands --no-session-persistence --permission-prompts none --permission-mode acceptEdits --settings <json>` |
| Antigravity CLI (`agy`) | `1.5.3` | `agy --version`（约 3.2s）、`agy models`（约 3.7s）无独立 `auth status` 子命令；`agy acp --sandbox --include-default-customizations=false --stdio` 响应 JSON-RPC `initialize`（`protocolVersion: 1`） |
| Cursor CLI (`agent`) | `2026.11.05-86047df` | `agent status --format json` 返回登录状态（`isAuthenticated`）；`agent --sandbox enabled [--workspace <dir>] [--model <m>] acp` 响应 JSON-RPC `initialize`（`protocolVersion: 1`） |

---

## 三、`tests/security.test.ts` 改动全文对照

按事先授权，原有所有安全断言均保持不变（仅在 IPC 白名单精确登记 3 个无路径参数的新频道并更新总数为 `73`，新增阶段 8B 安全边界验证，且对 `exportExternalTask` 与 `src/core/thinking/handoff/**` 与外部 CLI 适配器隔离做出明确校验）：

```diff
--- a/tests/security.test.ts
+++ b/tests/security.test.ts
@@ -282,12 +282,13 @@ describe('安全基线（防回归）', () => {
     // 阶段 6（提交②+③）：新增 reworkConflictTask、getSaveHistory 与 undoFromHistory
     // 阶段 7（提交①+②）：新增 exportExternalTask、importExternalReport、revealHandoff 与 reworkExternalTask
     // 阶段 8A（ADR 0010）：新增 listProviderCatalog、listProviderProfiles、fetchProviderModels、saveAndTestProvider、deleteProviderProfile、saveDefaultExecutor、saveProjectExecutor 与 setTaskExecutor
-    expect(entries.map((e) => e.name)).toEqual(['detectEnvironment', 'chooseProject', 'recentProjects', 'openRecent', 'listOpenProjects', 'closeProject', 'getWorkbench', 'projectStatus', 'getProjectBrief', 'saveProjectBrief', 'initProject', 'getDisclosure', 'acceptDisclosure', 'getClaudeKeyStatus', 'saveClaudeKey', 'deleteClaudeKey', 'getAiSettings', 'saveAiRoles', 'listProviderCatalog', 'listProviderProfiles', 'fetchProviderModels', 'saveAndTestProvider', 'deleteProviderProfile', 'saveDefaultExecutor', 'getProjectRoles', 'saveProjectRoles', 'saveProjectExecutor', 'listTasks', 'createTask', 'getTask', 'setTaskExecutor', 'savePlan', 'addExtraDir', 'removeExtraDir', 'startTask', 'exportExternalTask', 'importExternalReport', 'revealHandoff', 'stopTask', 'continueTask', 'reworkTask', 'reworkExternalTask', 'editReworkPermissions', 'getDiscussionView', 'startDiscussion', 'confirmDiscussionSend', 'confirmDiscussionRequirements', 'resolveDiscussionFailure', 'adjudicateDiscussion', 'decideDiscussionApproval', 'modifyDiscussionRequirements', 'sendDiscussionChat', 'skipDiscussion', 'getAcceptanceView', 'openPreview', 'skipPreview', 'confirmCriterion', 'rejectCriterion', 'confirmOverall', 'ackDenied', 'recheck', 'saveTask', 'saveUncheckedTask', 'discardTask', 'undoSave', 'retryCleanup', 'reworkConflictTask', 'getSaveHistory', 'undoFromHistory', 'revealProject']);
-    expect(entries).toHaveLength(70);
-    const SHAPES = ['', 'id: string', 'secret: string', 'input: ProviderModelFetchInput', 'input: ProviderSaveInput', 'chief: string, reviewer: string, model: string', 'projectId: string', 'projectId: string, brief: ProjectBriefInput', 'projectId: string, mode: string, chief: string, reviewer: string', 'projectId: string, mode: string, id: string', 'consent: boolean', 'projectId: string, request: string', 'projectId: string, id: string', 'projectId: string, id: string, executorId: string', 'projectId: string, id: string, feedback: string', 'projectId: string, id: string, plan: PlanInput', 'projectId: string, id: string, key: string', 'projectId: string, id: string, ack: boolean', 'projectId: string, id: string, version: string', 'projectId: string, id: string, itemId: string, version: string', 'projectId: string, id: string, itemId: string, version: string, reason: string', 'projectId: string, id: string, preset: string', 'projectId: string, id: string, service: string, allow: boolean', 'projectId: string, id: string, edits: RequirementEditInput[]', 'projectId: string, id: string, choice: string, note: string', 'projectId: string, id: string, kind: string, key: string, decision: string, reason: string', 'projectId: string, id: string, decision: string', 'projectId: string, id: string, newRequest: string', 'projectId: string, id: string, target: string, message: string', 'projectId: string, id: string, target: string'];
+    // 阶段 8B（ADR 0010）：新增 listSubscriptionClis、enableSubscriptionCli、disableSubscriptionCli
+    expect(entries.map((e) => e.name)).toEqual(['detectEnvironment', 'chooseProject', 'recentProjects', 'openRecent', 'listOpenProjects', 'closeProject', 'getWorkbench', 'projectStatus', 'getProjectBrief', 'saveProjectBrief', 'initProject', 'getDisclosure', 'acceptDisclosure', 'getClaudeKeyStatus', 'saveClaudeKey', 'deleteClaudeKey', 'getAiSettings', 'saveAiRoles', 'listProviderCatalog', 'listProviderProfiles', 'fetchProviderModels', 'saveAndTestProvider', 'deleteProviderProfile', 'saveDefaultExecutor', 'listSubscriptionClis', 'enableSubscriptionCli', 'disableSubscriptionCli', 'getProjectRoles', 'saveProjectRoles', 'saveProjectExecutor', 'listTasks', 'createTask', 'getTask', 'setTaskExecutor', 'savePlan', 'addExtraDir', 'removeExtraDir', 'startTask', 'exportExternalTask', 'importExternalReport', 'revealHandoff', 'stopTask', 'continueTask', 'reworkTask', 'reworkExternalTask', 'editReworkPermissions', 'getDiscussionView', 'startDiscussion', 'confirmDiscussionSend', 'confirmDiscussionRequirements', 'resolveDiscussionFailure', 'adjudicateDiscussion', 'decideDiscussionApproval', 'modifyDiscussionRequirements', 'sendDiscussionChat', 'skipDiscussion', 'getAcceptanceView', 'openPreview', 'skipPreview', 'confirmCriterion', 'rejectCriterion', 'confirmOverall', 'ackDenied', 'recheck', 'saveTask', 'saveUncheckedTask', 'discardTask', 'undoSave', 'retryCleanup', 'reworkConflictTask', 'getSaveHistory', 'undoFromHistory', 'revealProject']);
+    expect(entries).toHaveLength(73);
+    const SHAPES = ['', 'id: string', 'secret: string', 'input: ProviderModelFetchInput', 'input: ProviderSaveInput', 'input: SubscriptionEnableInput', 'chief: string, reviewer: string, model: string', 'projectId: string', 'projectId: string, brief: ProjectBriefInput', 'projectId: string, mode: string, chief: string, reviewer: string', 'projectId: string, mode: string, id: string', 'consent: boolean', 'projectId: string, request: string', 'projectId: string, id: string', 'projectId: string, id: string, executorId: string', 'projectId: string, id: string, feedback: string', 'projectId: string, id: string, plan: PlanInput', 'projectId: string, id: string, key: string', 'projectId: string, id: string, ack: boolean', 'projectId: string, id: string, version: string', 'projectId: string, id: string, itemId: string, version: string', 'projectId: string, id: string, itemId: string, version: string, reason: string', 'projectId: string, id: string, preset: string', 'projectId: string, id: string, service: string, allow: boolean', 'projectId: string, id: string, edits: RequirementEditInput[]', 'projectId: string, id: string, choice: string, note: string', 'projectId: string, id: string, kind: string, key: string, decision: string, reason: string', 'projectId: string, id: string, decision: string', 'projectId: string, id: string, newRequest: string', 'projectId: string, id: string, target: string, message: string', 'projectId: string, id: string, target: string'];
     for (const e of entries) {
       expect(SHAPES, `${e.name}(${e.params})`).toContain(e.params);
       expect(e.params, `${e.name} 不得有路径类参数`).not.toMatch(/\b(?:path|paths|dir|dirs|folder|file|filename|cwd|url)\b\s*:/i);
@@ -304,6 +305,10 @@ describe('安全基线（防回归）', () => {
       expect(body, `${typeName} 定义缺失`).toMatch(/endpoint: string/);
       expect(body, `${typeName} 不得含路径或 url 字段`).not.toMatch(/path|dir|folder|file|cwd|url/i);
     }
+    const subInputBody = /interface SubscriptionEnableInput \{([\s\S]*?)\}/.exec(preload)?.[1] ?? '';
+    expect(subInputBody, 'SubscriptionEnableInput 定义缺失').toMatch(/cliId: string/);
+    expect(subInputBody).toMatch(/riskAck: boolean/);
+    expect(subInputBody).not.toMatch(/path|dir|folder|file|cwd|url/i);
     // 每个 IPC 通道在主进程中都有处理函数，且主进程处理函数的参数形态同样固定
     const main = read('src/main/index.ts');
     for (const e of entries) expect(main, e.channel).toContain(`ipcMain.handle('${e.channel}'`);
@@ -491,6 +496,9 @@ describe('安全基线（防回归）', () => {
         saveAndTestProvider: 'input: ProviderSaveInput',
         deleteProviderProfile: 'id: string',
         saveDefaultExecutor: 'id: string',
+        listSubscriptionClis: '',
+        enableSubscriptionCli: 'input: SubscriptionEnableInput',
+        disableSubscriptionCli: 'id: string',
         getProjectRoles: 'projectId: string',
         saveProjectRoles: 'projectId: string, mode: string, chief: string, reviewer: string',
         saveProjectExecutor: 'projectId: string, mode: string, id: string',
@@ -1228,4 +1236,40 @@ describe('安全基线（防回归）', () => {
       expect(pStore).not.toMatch(/return\s*\{\s*ok:[^;]*\bcipherB64\b/);
     });
   });
+
+  describe('阶段 8B：本地订阅制 CLI 知情自担风险接入安全边界（只增不减）', () => {
+    it('外部交接导出路径（exportExternalTask / handoff）仍绝不接触任何订阅 CLI 适配器；适配器和门禁强制要求 riskAck === true 且剔除 API Key', () => {
+      const handoffFiles = sources.filter(([f]) => f.includes(`${path.sep}thinking${path.sep}handoff${path.sep}`));
+      expect(handoffFiles.length).toBeGreaterThan(0);
+      for (const [f, s] of handoffFiles) {
+        const clean = stripComments(s);
+        expect(clean, f).not.toMatch(/claude-code|adapters\/acp|subscriptions|child_process|\bspawn\(/);
+      }
+
+      const claudeSrc = stripComments(read('src/core/executor/adapters/claude-code.ts'));
+      const claudeStart = claudeSrc.slice(claudeSrc.indexOf('start(opts: StartOptions): ExecutorRun'));
+      expect(claudeStart.indexOf('requireRiskAcknowledged')).toBeGreaterThan(-1);
+      expect(claudeStart.indexOf('requireRiskAcknowledged')).toBeLessThan(claudeStart.indexOf('spawn('));
+      expect(claudeSrc).toContain('ANTHROPIC_API_KEY');
+      expect(claudeSrc).toContain('--safe-mode');
+      expect(claudeSrc).toContain('--restricted');
+      expect(claudeSrc).toContain('--strict-mcp-config');
+      expect(claudeSrc).not.toMatch(/allow-dangerously|bypassPermissions|dangerously-skip|--trust\b|--yolo/);
+
+      const acpSrc = stripComments(read('src/core/executor/adapters/acp.ts'));
+      const acpStart = acpSrc.slice(acpSrc.indexOf('start(opts: StartOptions): ExecutorRun'));
+      expect(acpStart.indexOf('requireRiskAcknowledged')).toBeGreaterThan(-1);
+      expect(acpStart.indexOf('requireRiskAcknowledged')).toBeLessThan(acpStart.indexOf('spawn('));
+      expect(acpSrc).toContain('OPENAI_API_KEY');
+      expect(acpSrc).toContain('CURSOR_API_KEY');
+      expect(acpSrc).toContain('sensitiveFallbackList');
+      expect(acpSrc).toContain('reject-once');
+      expect(acpSrc).not.toMatch(/allow-dangerously|bypassPermissions|dangerously-skip|--trust\b|--yolo/);
+
+      const subStoreSrc = stripComments(read('src/core/app/subscription-clis.ts'));
+      expect(subStoreSrc).toMatch(/testAndEnable[\s\S]*?input\.riskAck !== true/);
+      expect(subStoreSrc).not.toMatch(/cipherB64|\bpassword\b|\btoken\b|\brefreshToken\b/i);
+      expect(main).toMatch(/ipcMain\.handle\('subscriptions:testAndEnable'[\s\S]*?obj\.riskAck === true/);
+    });
+  });
 });
```

---

## 四、视觉截图清单（均经逐张审阅）

| 序号 | 截图文件 | 检查内容 |
| --- | --- | --- |
| 01 | `docs/screenshots/stage8b/01-settings-sub-clis-initial.png` | 设置页「本机订阅 CLI 执行者（风险自担）」通栏卡片，默认均未自动开启，Cursor 标注未登录 |
| 02 | `docs/screenshots/stage8b/02-risk-modal-agy.png` | Antigravity 风险条款弹窗：显示条款冲突、官方 Gemini API 替代、隔离边界，未勾选时禁用确认按钮 |
| 03 | `docs/screenshots/stage8b/03-risk-modal-checked.png` | 勾选风险知情复选框后，复选框内联对齐，主确认按钮变为可点击 |
| 04 | `docs/screenshots/stage8b/04-settings-sub-clis-enabled.png` | 启用 Claude Code 与 Antigravity，记录确认时间，将 Antigravity 设为默认执行者 |
| 05 | `docs/screenshots/stage8b/05-disclosure-subscription-cli.png` | 外发说明弹层动态列出已启用的本机订阅 CLI 名称、风险自担标识、模型与按本机账号计费说明 |
| 06 | `docs/screenshots/stage8b/06-plan-subscription-selector-honesty.png` | 计划确认页 `#04-plan`：执行者下拉支持切换订阅 CLI，右侧诚实提示栏展示隔离边界说明 |
| 07 | `docs/screenshots/stage8b/07-acceptance-acp-blocked.png` | 验收页 `#08-acceptance`：显示 Antigravity 在任务副本的实际修改，以及越界写操作拦截提示卡（「想修改任务副本以外的位置，已拦下」） |
| 08 | `docs/screenshots/stage8b/08-settings-disabled-unset.png` | 停用正在作为默认执行者的 Antigravity 后，默认执行者自动回退为「未设置」并显示醒目提醒 |

---

## 五、本地验证实测记录

1. `npm run typecheck`：通过（0 报错）。
2. `npx vitest run --maxWorkers=2`：共 53 个测试文件——**41 个测试文件（633 条单测）全部通过**；其余 12 个 `tests/integration/*.real.test.ts`（38 条）按既有门控跳过（需显式 `STUDIO_REAL_CODEX=1` 等真实联调开关），其中阶段 8B 新增测试文件：
   - `tests/stage8b-claude-code.test.ts`：3/3 通过
   - `tests/stage8b-acp.test.ts`：3/3 通过
   - `tests/stage8b-controller.test.ts`：3/3 通过
   - `tests/security.test.ts`：60/60 通过
3. `npm run smoke`：`build:core` + `build:renderer` 构建通过，Electron CDP 检查 `document.title`、隔离边界与 74 个 `window.studio` 暴露键名全部 `PASS`。
4. `npm run test:e2e`（`vitest run -c vitest.e2e.config.ts`）：首次全量运行中阶段 4 曾出现 1 次 `confirm-c0` 超时；单独复测阶段 4 通过（14.7s），随后重跑完整 53 项 E2E 全量集合 **53/53 全部通过**（含第 53 项阶段 8B E2E 完整闭环）。

---

## 六、双平台 CI 结果

待推送 `rebuild` 后回填 `ubuntu-latest` 与 `macos-latest` 实际运行链接与结论。

# 阶段 6 完成报告 · 保存结果、保存冲突、保存记录与撤销界面（UI v2.1 第 7 节）

- 仓库：`luckyjamesriver/ai-solo-studio`（分支 `rebuild`）
- 依据规范：[`docs/ui/UI_v2.1.md`](../ui/UI_v2.1.md)（已冻结）第 0、7、8 节、可点击原型 [`docs/ui/prototype.html`](../ui/prototype.html)（`#10-save-result`、`#11-save-conflict`、`#12-history`）及阶段 1 报告 [`docs/reports/2026-11-save-safety.md`](2026-11-save-safety.md)
- 严格裁剪原则：遵循阶段 6 范围与 UI v2.1 第 0 节诚实原则，**不改阶段 1 的安全判断与保存规则，不提供「以这个任务为准，覆盖保存」与「跨后续保存撤销」两个后台未实现的选项**。

---

## 1. 提交清单与内容摘要

1. **`feat(save): save progress and result states on the acceptance page`（[`b8648fa`](https://github.com/luckyjamesriver/ai-solo-studio/commit/b8648fa)）**
   - 实现 `#10-save-result`：在验收页右侧原地展示 4 步「保存前检查」真实实时进度（检查变化 → 合并 → 合并后检查 → 写入前核对）与单结果面板 [`SaveResultPanel.tsx`](../../src/renderer/SaveResultPanel.tsx)，所有标签、文案、按钮与出现条件统一由 [`view.ts`](../../src/core/acceptance/view.ts) 下发。
   - 当 `checks_failed` 时保存试检查原始凭证到 `Task.trialChecks` 并提供「查看构建检查依据 / 查看自动测试依据」跳转至 `#08-evidence`；当 `project_locked` 时带上阻塞任务 ID 供点击「去处理」直接跳转。

2. **`feat(save): conflict page with redo on latest project`（[`a536d19`](https://github.com/luckyjamesriver/ai-solo-studio/commit/a536d19)）**
   - 实现 `#11-save-conflict`（[`SaveConflictPage.tsx`](../../src/renderer/SaveConflictPage.tsx)）：在 [`TaskRunner.doSave`](../../src/core/task/runner.ts) 试合并发生冲突、`merge --abort` 前记录冲突文件路径与关联来源（查无已保存任务时统一写「项目里后来的改动」）。
   - 仅提供两个选项：主按钮「让 AI 在最新项目上重做这部分」（走阶段 4 退回修改路径）和次要按钮「先不处理」（返回列表留在「待验收」），支持展开查看双侧文件内容片段对照（复用 [`snippets.ts`](../../src/core/acceptance/snippets.ts) `buildSingleFilePreview` 与 [`DiffPreview.tsx`](../../src/renderer/DiffPreview.tsx)，绝不展示命令与 Git 原文）。

3. **`feat(save): save history and undo`（[`208d24f`](https://github.com/luckyjamesriver/ai-solo-studio/commit/208d24f)）**
   - 实现 `#12-history`（[`history.ts`](../../src/core/acceptance/history.ts)、[`SaveHistoryPage.tsx`](../../src/renderer/SaveHistoryPage.tsx)）：替换 [`ProjectBoard.tsx`](../../src/renderer/ProjectBoard.tsx) 原有简单历史列表，按主线提交倒序展示任务名、保存时间、执行者、轮次、3 类检查情况（`检查通过` / `未检查（没有检查脚本）` / `未检查（检查没能运行）` + 用户确认时间）、非工作台直提交的「项目外的改动」与跳转查看任务入口。
   - 仅当前最新一条仍有效保存进入 `previewUndo` 判断并可点「撤销…」，点击后弹出完整确认说明（撤销哪次保存、回到何状态、会新增提交及已知局限）；撤销失败/被挡/`manualReview`/`project_locked` 复用 [`SaveResultPanel.tsx`](../../src/renderer/SaveResultPanel.tsx) 展示（`undo_refused` 列出挡住它的保存并提示「没有改动任何文件」）。
   - 同步修复 [`TaskController.result`](../../src/core/app/task-controller.ts) 中结果合并优先级（本次操作返回的 `r.saveOutcome` 优先于历史缓存 `view.saveOutcome`，防止已保存任务在后续撤销被挡时误显示旧的 `'saved'` 结果）。

4. **`fix(settings): current Claude model list`（[`dc9190b`](https://github.com/luckyjamesriver/ai-solo-studio/commit/dc9190b)）**
   - 将 [`SUGGESTED_CLAUDE_MODELS`](../../src/core/app/ai-settings.ts) 与 [`SettingsPage.tsx`](../../src/renderer/SettingsPage.tsx) 备选清单中的过时模型 `claude-sonnet-4-6`、`claude-haiku-4-5` 更新为 Anthropic 当前同代正式模型 `claude-sonnet-5-5`、`claude-haiku-5-5`（默认仍为 `claude-opus-5-5`）。

5. **`test(e2e): add stage 6 save UI E2E tests, race fixes, and screenshots`（[`9160565`](https://github.com/luckyjamesriver/ai-solo-studio/commit/9160565)）**
   - 新增 5 项阶段 6 真实 Electron E2E 测试（共 49 项全过）并生成 11 张 [`docs/screenshots/stage6/`](../screenshots/stage6) 截图。
   - 修复全量 E2E 压测暴露出的两项已有时序竞态：
     1. [`TaskView.stoppedInfo.token`](../../src/core/app/task-view.ts) 移除 `acceptanceRev` 与 `state`，使同轮次停下后从 `stopped` 过渡到 `reviewing` 时不再因 `token` 漂移弹回停止页；
     2. [`SettingsPage.tsx`](../../src/renderer/SettingsPage.tsx) 增加 `rolesDirtyRef`，防止 `getAiSettings()` 异步延迟返回时覆盖用户已选中的角色草稿。
   - 调整 [`view.ts`](../../src/core/acceptance/view.ts) 中 `abnormal` 与 `isUndo` 在无保存前置步骤快照时不强行填充 4 行 `等待` 占位步骤。

---

## 2. 后台真实进度事件设计（零假动画）

阶段 1 的 `TaskRunner.save()` 只在全部步骤完成后返回一个结果。为如实展示「检查项目在验收期间是否有变化 → 合并两边的改动 → 合并后重新运行检查 → 写入前再确认一次」四步过程，本次改造为真实流式进度推送：

1. **核心层实时发事件（[`TaskRunner.doSave`](../../src/core/task/runner.ts)）**：
   - `TaskRunner` 继承 Node `EventEmitter`，通过 `emitSaveProgress(taskId, saveSteps, finished)` 在每个真实节点发出 `save_progress` 事件：
     - **步骤 1（`check_changes`）**：进入时先发 `running`；核对锁、外部驱动、位置、分支与脏文件并运行 `describeProjectMovement` 后，如实更新为 `done`（例如 `没有新的改动`、`有：「页脚微调」刚保存过`、`有：项目里后来的 N 次改动`）或提前失败退出；
     - **步骤 2（`trial_merge`）**：在独立临时 worktree（`.studio/trials/`）合并前发 `running`；若碰撞或出错立刻发 `failed` + 其余 `skipped` + `finished: true`；合并成功则根据 `preHead === binding.baseHead` 发 `done`（`已完成合并（项目期间无其他改动）` / `改的是不同文件，已自动合并`）；
     - **步骤 3（`trial_checks`）**：调用 `runTrialChecks` 前发 `running`；按真实检查结果更新为 `done`（如 `构建与 3 项测试通过`、`构建通过`、`3 项测试通过`）、`skipped`（`unchecked_needs_confirm`）或 `failed`（`checks_failed`，附总失败项数）；
     - **步骤 4（`final_verify`）**：写入主项目前发 `running`；核对期间无新提交后执行 `git merge --ff-only`，写入成功发出 `finished: true`（`期间没有新的改动，已写入主项目`），遇到 `project_changed`、`failed_restored` 或 `abnormal` 时如实发出 `failed` 与 `finished: true`。
   - 同时将最后一次 `saveSteps` 与结果快照持久化到 `Task.lastSave`，确保重启或切换页面后视图仍能还原当时的四步真实细节。
2. **主进程 / Preload 受控转发**：[`TaskController`](../../src/core/app/task-controller.ts) 监听 `runner.on('save_progress', ...)` → [`src/main/index.ts`](../../src/main/index.ts) 通过 `webContents.send('acceptance:saveProgress', { ...ev, projectId })` 推送 → [`src/preload/index.cts`](../../src/preload/index.cts) `onSaveProgress` 白名单订阅并在卸载时自动 `removeListener`（无路径、无原始错误、无命令正文）。

---

## 3. 每种保存 / 撤销结果的文案与按钮对照表

下表全部源自核心层 [`buildSaveOutcomeView`](../../src/core/acceptance/view.ts) 与 [`MESSAGES`](../../src/core/task/messages.ts) / [`uncheckedReasonText`](../../src/core/task/messages.ts)：

| `reason` | 标签 (`tag`) | 用户看到的文字 (`headline` / 补充说明) | 按钮列表（*主按钮* / 次要按钮） |
|---|---|---|---|
| `saved` | `已保存` | `已保存。可以在保存记录里撤销`（若清理挂起追加：`；临时文件还没清理干净，请点「重试清理」。`） | *`完成`*、`查看保存记录` |
| `unchecked_needs_confirm` (`none`) | `未检查` | `项目没有配置可用的自动检查脚本，合并后无法自动验证，请先预览确认后再决定是否仍然保存。` | *`打开预览`*、`仍然保存` |
| `unchecked_needs_confirm` (`unavailable`) | `未检查` | 依具体分类：`这次合并改动了项目的检查方式，所以没法自动检查。` / `当前没有可用的受限运行环境，检查未能运行，所以没法自动检查。` / `合并后的自动检查未能运行，所以没法自动检查。` | *`打开预览`*、`仍然保存` |
| `checks_failed` | `检查失败` | `合并后有 N 项检查没通过，没有保存，你的项目没有变化`，并列出各失败检查项（`构建未通过` / `K 项测试未通过` / `测试未通过`） | *`退回修改`*、`查看构建检查依据` / `查看自动测试依据` |
| `conflict` | `冲突` | 跳转展示 `#11-save-conflict` 冲突专页：`没有保存`、冲突位置、关联已保存任务（或`项目里后来的改动`）、项目当前状态、成果完整保留、可展开两边片段对比 | *`让 AI 在最新项目上重做这部分`*、`先不处理` |
| `project_changed` | `项目有变化` | `检查期间项目又有新的改动，没有保存` | *`重新保存`* |
| `failed_restored` | `保存失败 · 已安全恢复` | `写入时出错，已把项目恢复并核对过与保存前一致；成果仍在任务副本里` | *`重试`* |
| `abnormal` (`manualReview`) | `保存失败 · 恢复未确认` / `撤销失败 · 恢复未确认` | `写入中途出错，无法确认项目是否完好。已停止一切写入。` + `extraNote`: `处理完之前，这个项目的所有任务都不能保存或撤销` + 受影响文件列表（若有） | 验收页复用下方 `readonly-panel` 固定两钮：`在访达中显示项目`、`复制诊断摘要`；保存记录页内直接渲染此两钮 |
| `project_locked` | `项目已锁定` | `<另一个任务> 的保存出了问题还没处理，这个项目暂时不能保存`（撤销触发时末尾为 `暂时不能撤销`） | *`去处理`*（携带 `targetTaskId` 直接跳转该任务） |
| `undo_refused` | `无法撤销` | 有后续阻塞保存时：`在这次保存之后，还有后来的保存挡住了它，暂时不能只撤销这一项：「<任务名>」（<时间>）。（没有改动任何文件）`；否则：`这次保存之后项目还有其他修改，暂时不能只撤销这一项（没有改动任何文件）` | 无（不提供跨保存撤销，提示未改文件） |
| `failed` | `撤销未完成` / `没有保存` | `这次操作没有成功，项目保持原样。你可以稍后重试。` | *`重试`* |
| `acceptance_invalid` | `没有保存` | `你确认之后，任务副本里的内容又发生了变化，原来的验收已失效，请重新检查后再保存。` | *`重新检查`* |

---

## 4. 冲突重做时任务副本更新做法（严防冲突标记污染）

在 `#11-save-conflict` 点击「让 AI 在最新项目上重做这部分」时，调用主进程 `acceptance:reworkConflict` → [`TaskRunner.prepareConflictRedo`](../../src/core/task/runner.ts) → [`G.prepareWorktreeRedoOnMain`](../../src/core/git/git.ts)：

1. **先做隔离验证，不直接修改 `wt.path`**：
   - 先核对任务副本无未完成合并（`mergeInProgress === false`）、无外部驱动、仓库位置/分支未变且主项目工作区干净。
   - 比较主项目自 `t.conflict.againstHead` 至最新 `mainHead` 期间的改动：若主项目在此之后又改动了本任务修改过的任何文件，直接判定存在并发新改动并中止。
   - 提取任务相对 `wt.baseSha` 改动的非冲突文件列表（`taskFiles \ knownConflictFiles`）：在独立临时索引 `GIT_INDEX_FILE` 上以 `wt.baseSha` 为基础构造只含非冲突改动的 `nonConflictCommit`，并在 `.studio/trials/` 下新建以最新 `mainHead` 为基线的临时 worktree（`trialPath`）执行 `git merge --no-commit --no-ff nonConflictCommit`。
   - **冲突中止策略**：一旦 `merge` 报错或 `conflictedFiles(trialPath)` 非空，立即在临时 worktree 中执行 `merge --abort` 并删除临时 worktree 与临时索引，**完全不触碰任务原副本 `wt.path`、分支 `wt.branch` 与 `wt.baseSha`，绝不向副本写入 `<<<<<<<` 冲突标记，任务留在 `save_failed_unmerged`，向界面如实返回冲突提示与涉及文件**。
2. **验证全清后再原子更新副本与基线并开启新一轮**：
   - 当临时 worktree 上非冲突部分无冲突合入且生成 `finalTree`（若本任务全部改动均位于已知冲突文件上，则直接取 `mainHead^{tree}` 使冲突文件以最新主线代码干净起稿），才在 `wt.path` 中执行 `checkout -f -B <wt.branch> <mainHead>` → `clean -fd` → `read-tree --reset -u <finalTree>`。
   - 同步更新 `t.worktree.baseSha = mainHead`、`t.binding.baseHead = mainHead`、清除 `t.conflict`，并自动向本轮反馈写入冲突来源与冲突文件说明，复用阶段 4 `prepareContinue` + `start` 启动第 `N + 1` 轮施工。

---

## 5. Claude 备选模型列表查证说明

- **查证日期**：`2026-11-11`
- **官方文档来源**：[`https://platform.claude.com/docs/en/about-claude/models/overview`](https://platform.claude.com/docs/en/about-claude/models/overview)
- **查证与更新内容**：当前官方同代（Claude 5.5）三大主力模型为 `claude-opus-5-5`、`claude-sonnet-5-5` 与 `claude-haiku-5-5`。本次保留默认推荐模型 `claude-opus-5-5` 不变，将 [`SUGGESTED_CLAUDE_MODELS`](../../src/core/app/ai-settings.ts#L70-L74) 与 [`SettingsPage.tsx`](../../src/renderer/SettingsPage.tsx#L429) 中的旧备选项 `claude-sonnet-4-6`、`claude-haiku-4-5` 更新为 `claude-sonnet-5-5` 与 `claude-haiku-5-5`（并增加单测回归校验）。

---

## 6. `tests/security.test.ts` 变更与测试调整说明

所有阶段 1–5 安全不变量零删除、零放宽，本次只按规范登记新 IPC 并新增阶段 6 安全断言（共 **57 项**全部通过）：

1. **IPC 白名单与精确参数形态（第 282–284 行、第 513–518 行）**：
   - 将受控 IPC 方法清单从 **55** 项同步更新为 **58** 项，按分组依次登记 `reworkConflictTask`（`'projectId: string, id: string'`）、`getSaveHistory`（`'projectId: string'`）与 `undoFromHistory`（`'projectId: string, id: string'`）；仅接收项目/任务编号，不含路径或覆盖标志参数。
   - 事件监听器 `onSaveProgress` 通过受控 `ipcRenderer.on('acceptance:saveProgress', ...)` / `removeListener` 注册并在 [`scripts/smoke.mjs`](../../scripts/smoke.mjs) `EXPECTED_API` 中同步登记（共 59 项暴露属性）。
2. **`projectId` 校验守卫计数（第 830–831 行）**：
   - 将带 `projectId` 且必须先经过 `controllerFor(projectId)` / `projectStatus(projectId)` / `openProjects.close(projectId)` 校验的主进程 handler 数量从 **40** 同步更新为 **43**（+1 `acceptance:reworkConflict`、+2 `project:saveHistory` / `project:undoHistory`）。
3. **新增「阶段 6：保存进度、冲突、历史与撤销界面安全边界（只增不减）」3 项断言（第 1121–1160 行）**：
   - `onSaveProgress` 频道严格受控、[`SaveResultPanel.tsx`](../../src/renderer/SaveResultPanel.tsx) 不出现 `仍然保存|强制保存|全部确认|让 ?AI ?修改` 与底层凭证明文/命令关键字；
   - [`SaveConflictPage.tsx`](../../src/renderer/SaveConflictPage.tsx) 与 [`view.ts`](../../src/core/acceptance/view.ts) 不出现 `以这个任务为准` / `覆盖保存`、`SaveConflictPage` 不出现命令或调试字段，且 [`prepareWorktreeRedoOnMain`](../../src/core/git/git.ts) 含碰撞 `merge --abort` 守卫；
   - [`SaveHistoryPage.tsx`](../../src/renderer/SaveHistoryPage.tsx) 与 [`history.ts`](../../src/core/acceptance/history.ts) 不出现跨保存撤销字样、不泄漏调试/命令字段，且 [`TaskController.undoFromHistory`](../../src/core/app/task-controller.ts) 复用 `this.undoSave`（严格遵守核心层阶段 1 撤销校验）。
4. **冲突相关旧 E2E 占位测试说明**：
   - [`tests/b4-2-controller.test.ts#L263`](../../tests/b4-2-controller.test.ts#L263) 对 `UserAcceptanceView.actions` 五键（`['discard', 'recheck', 'retryCleanup', 'save', 'undo']`）与核心层无重做入口的结构断言**保持零修改并继续通过**；
   - [`e2e/shell.e2e.ts#L849`](../../e2e/shell.e2e.ts#L849) 原 B4-2 占位用例与第 656 行 `window.studio` 精确键值表已按阶段 6 新界面（`#11-save-conflict` 与新增 IPC）同步更新。

---

## 7. 与原型和规范的差异说明

1. **界面完全移除原型中未实现的操作**：依据任务范围与 UI v2.1 第 0 节诚实原则，未在 `#11-save-conflict` 渲染「以这个任务为准，覆盖保存」，也未在 `#12-history` 渲染跨后续保存撤销控件或假装可跳过新提交撤销前一次有效保存。
2. **`readonly-panel` 与 `SaveResultPanel` 在 `manualReview` 下的职责切分**：为延续 B4-2 对 `readonly-panel` 仅含「在访达中显示项目 / 复制诊断摘要」两枚按钮的结构约定，[`SaveResultPanel.tsx`](../../src/renderer/SaveResultPanel.tsx) 在 `readonly-panel` 上方展示受影响文件清单与锁定说明（传入 `hideButtons: true`），底部由 `readonly-panel` 提供操作按钮，避免按钮重复。
3. **非保存流程触发 `manualReview`（如撤销/核对）及 `undoFromHistory` 失败回执**：当 `manualReview` 或 `undo_refused` 没有预先执行「保存前检查四步」时，[`SaveResultPanel.tsx`](../../src/renderer/SaveResultPanel.tsx) 隐藏 `StepRows`，仅展示真实结果状态与提示文案，避免出现无关的 4 行「等待」。
4. **撤销后倒数第二次保存的可撤销性**：按阶段 1 规则与本任务明确说明，撤销任务 B 后分支上产生了 `studio: 撤销「任务 B」` 新提交，HEAD 已不再等于任务 A 的 `mergeCommit`，因此 [`buildSaveHistoryView`](../../src/core/acceptance/history.ts) 将当前最新仍有效的任务 A 交给 `runner.previewUndo(A)` 如实评估为不可单独撤销并展示核心层原因，不做越级跨提交撤销。

---

## 8. 阶段 6 界面截图清单（`docs/screenshots/stage6/`）

全部由本地 Electron 全量 E2E 运行时真实截取并逐张视觉核验：

| 序号 | 文件名 | 原型锚点 | 核验内容 |
|---|---|---|---|
| 1 | [`01-save-progress.png`](../screenshots/stage6/01-save-progress.png) | `#10-save-result` | 真实暂停运行中的第 3 步（合并后检查 `进行中`、前两步 `完成` 并显示实际结果、第 4 步 `等待`） |
| 2 | [`02-save-result-saved.png`](../screenshots/stage6/02-save-result-saved.png) | `#10-save-result` | 四步均 `完成`，`已保存。可以在保存记录里撤销` 与「完成」「查看保存记录」按钮 |
| 3 | [`03-save-result-checks-failed.png`](../screenshots/stage6/03-save-result-checks-failed.png) | `#10-save-result` | 第 3 步 `未通过`，提示无变化与 `1 项测试未通过`，主按钮「退回修改」与跳转「查看自动测试依据」 |
| 4 | [`04-save-result-project-changed.png`](../screenshots/stage6/04-save-result-project-changed.png) | `#10-save-result` | 检查期间主项目有新提交，第 4 步 `未通过`，显示「重新保存」主按钮 |
| 5 | [`05-save-result-failed-restored.png`](../screenshots/stage6/05-save-result-failed-restored.png) | `#10-save-result` | `git merge --ff-only` 写索引前受阻并核对无损，显示安全恢复文案与「重试」主按钮 |
| 6 | [`06-save-result-manual-review.png`](../screenshots/stage6/06-save-result-manual-review.png) | `#10-save-result` | 恢复未确认状态：列出受影响文件、`全部任务都不能保存或撤销` 警示与只读恢复面板（无虚假 4 步等待条） |
| 7 | [`07-save-result-project-locked.png`](../screenshots/stage6/07-save-result-project-locked.png) | `#10-save-result` | 另一任务 B 显示异常任务名锁定原因与「去处理」按钮 |
| 8 | [`08-save-conflict.png`](../screenshots/stage6/08-save-conflict.png) | `#11-save-conflict` | `没有保存`、冲突文件、关联已保存任务、项目与成果状态、双按钮与展开的两侧改动片段对比（无命令原文、无覆盖保存） |
| 9 | [`09-history.png`](../screenshots/stage6/09-history.png) | `#12-history` | 倒序记录（未检查无脚本+确认时间、「项目外的改动」、检查通过），仅最新一条带「撤销…」与「查看任务」 |
| 10 | [`10-history-undo-confirm.png`](../screenshots/stage6/10-history-undo-confirm.png) | `#12-history` | 点「撤销…」后确认框完整展示撤销目标、恢复目标状态、新增提交说明与已知局限 |
| 11 | [`11-history-after-undo.png`](../screenshots/stage6/11-history-after-undo.png) | `#12-history` | 撤销后顶部新增「撤销了…」、原记录带「已撤销」且无撤销入口，倒数第二次按 `undoCheck` 如实提示被后续保存挡住 |

---

## 9. 全量验证结果、遇到的问题与 CI 状态

### 本地最终全量验证（[`9160565`](https://github.com/luckyjamesriver/ai-solo-studio/commit/9160565)）
- `npm run typecheck`：退出码 `0`
- `npx vitest run --maxWorkers=4`：**33 个测试文件通过，12 个真实环境集成测试按条件跳过（共 45 个文件）；606 个用例通过，38 个集成用例跳过（共 644 个），0 失败**（耗时 `101.13s`；其中 [`tests/stage6-save-ui.test.ts`](../../tests/stage6-save-ui.test.ts) 8 项、[`tests/security.test.ts`](../../tests/security.test.ts) 57 项、[`tests/b4-2-controller.test.ts`](../../tests/b4-2-controller.test.ts) 26 项、[`tests/b4-2-view.test.ts`](../../tests/b4-2-view.test.ts) 24 项、[`tests/save-safety.test.ts`](../../tests/save-safety.test.ts) 20 项全部通过）
- `npm run build && npm run smoke`：全部 PASS（校验 `window.studio` 全部受控接口、Git 与 Codex 五层体检，退出码 `0`）
- 全量 Electron E2E（`E2E_STAGE6_SHOT_DIR=docs/screenshots/stage6 npm run test:e2e`）：**49 / 49 全部通过**（耗时 `261.69s`，0 失败、0 跳过）

### 实现过程中的真实失败与根因修复记录
1. **提交① `tests/stage6-save-ui.test.ts` 保存进度单测失败**：带 `package.json` 测试脚本的测试仓库初次未传入 `sandbox: true`，触发 `unchecked_needs_confirm`；补充 `sandbox: true` 且 `G_commit` 仅暂存目标文件（避免误暂存 `.studio/`）后通过。
2. **提交② `runner.ts` 类型报错**：`firstParentCommitsAfter` 返回 `SavePoint` 含 `.date` 而非 `.at` 且可能为 `null`；补齐空判断并改读 `c.date` 后通过。
3. **提交② `security.test.ts` 捕获 `SaveConflictPage.tsx` 注释字面量**：JSDoc 注释写了禁用短语，被无去注释全文件扫描规则命中；改为简洁注释保持规范与测试零放宽。
4. **提交② 多任务 `FakeExecutor` 复用导致冲突未触发 + `git checkout -B` 报错**：
   - `TaskController` 对同一仓库缓存单份 `TaskRunner` 及其 `Executor` 实例，单测内改用按轮次/任务分发的 `Executor` 包装后复现真实双任务冲突；
   - `G.prepareWorktreeRedoOnMain` 初版在 `wt.path` 有未提交改动时直接调用 `git checkout -B` 报错退出，改为 `git checkout -f -B` 后再 `clean -fd` 与 `read-tree --reset -u finalTree`，顺畅进入第 2 轮并保留非冲突文件修改。
5. **提交③ `TaskController.result` 掩盖了新撤销失败结果**：在 `undoFromHistory` 对已包含历史 `t.lastSave`（`reason: 'saved'`）的任务触发 `undo_refused` 时，原 `view.saveOutcome ?? r.saveOutcome` 错误返回了旧 `'saved'` 快照；修正为 `r.saveOutcome ?? view.saveOutcome`，优先呈现本次操作返回的真实结果。
6. **提交③ `edit_file` 在 `git.ts` 双处命中与 `exNoSb` 复用**：修掉 `git.ts` `savePoints` 误匹配的重复函数定义；为 `tests/stage6-save-ui.test.ts` 无沙箱分支单独构造无 `sandboxRunner` 的 `Executor`。
7. **全量 E2E 初跑触发 `.git/refs/heads/main.lock` 误落入 `abnormal`（而非 `failed_restored`）**：`git merge --ff-only` 先写工作区最后锁分支 ref，锁 `main.lock` 会留下脏工作区导致核验判定未恢复；改为在试检查末尾临时锁定 `.git/index.lock`，让 `--ff-only` 在改动工作区前立即失败且不脏工作区，真实触发 `failed_restored` 并于解琐后重试保存成功。
8. **全量 E2E 暴露两项已有前端竞态隐患**：
   - [`TaskView.stoppedInfo.token`](../../src/core/app/task-view.ts) 原拼入了 `acceptanceRev` 与 `state`，导致停下后进入 `reviewing` 的轮询刷新重新弹回 `StoppedPage`；改为按轮次稳定生成 `token` 并新增单测守卫。
   - [`SettingsPage.tsx`](../../src/renderer/SettingsPage.tsx) 原 `useEffect` 在慢速 `getAiSettings()` 返回时会把用户刚切换的角色草案重置；引入 `rolesDirtyRef` 后稳定消除竞态。

### GitHub Actions 双平台 CI（`rebuild` 分支）
- 全量代码 + 截图 + 报告首次双平台绿灯运行（[`68d7c4c`](https://github.com/luckyjamesriver/ai-solo-studio/commit/68d7c4c)）：[https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42883182130](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42883182130)
  - `test (ubuntu-latest)`：`success`（1m8s，[job 130064548010](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42883182130/job/130064548010)）
  - `test (macos-latest)`：`success`（8m57s，[job 130064548734](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42883182130/job/130064548734)，含 49 项 Electron E2E 全量通过）

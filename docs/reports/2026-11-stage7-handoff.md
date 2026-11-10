# 阶段 7 完成报告 · 交给外部工具执行、各轮代码保留与 Codex 额度调研

- 仓库：`luckyjamesriver/ai-solo-studio`（分支 `rebuild`）
- 依据文档：需求 v1.5 第 4 节（外部执行交接，正式支持）、[`docs/ui/UI_v2.1.md`](../ui/UI_v2.1.md) 第 5 节、[`ADR 0002`](../adr/0002-no-subscription-integration.md)、[`ADR 0009`](../adr/0009-antigravity-integration.md)
- 严格边界：仅交接任务说明文件并核验导入报告与任务副本真实状态；**不自动启动外部工具、不调用外部工具 CLI、不读取外部工具登录凭证**；**暂不接入 `reviewImportedReport`**；**不做 Codex 额度界面**。

---

## 1. 提交清单与内容摘要

1. **`feat(handoff): export task to external tools with confirmation`（[`0082a5e`](https://github.com/luckyjamesriver/ai-solo-studio/commit/0082a5e)）**
   - 在 `#04-plan`（[`PlanCard.tsx`](../../src/renderer/PlanCard.tsx)）增加次要按钮「交给外部工具执行」与三项风险说明确认弹框，确认后创建与内部施工相同的独立 Git worktree（未批准/标准模式沿用原权限规则），调用 `exportTask` / `renderTaskFile` 保留 `planUnreviewed` 标记与验收标准并生成 `.studio/handoff/<taskId>/task.md` 及清单（`.studio/records/manifests/<taskId>.json`）。
   - 任务进入新状态 `waiting_external`（「外部执行中（等待导入报告）」）：在侧栏/工作台显示为「外部执行中」（`running` 分组，`needsAttention: false`），**不计入「需要你决定」角标**。
   - 新增等待页 [`ExternalWaitingPage.tsx`](../../src/renderer/ExternalWaitingPage.tsx)，展示任务副本完整路径、说明文件路径、导出时间，提供「导入报告」「在访达中显示」「复制任务说明」「取消外部执行」（走现有放弃清理路径）。

2. **`feat(handoff): import report with verification into acceptance`（[`3160047`](https://github.com/luckyjamesriver/ai-solo-studio/commit/3160047)）**
   - 主进程打开系统文件选择框（`dialog.showOpenDialog`），仅允许 `.md` / `.txt`；控制器再次按扩展名校验拦截非白名单后缀文件。
   - 导入时组合执行 `importReport` 绑定核对、`saveImportRecord` 落盘留痕与任务副本 Git 实际状态检查（实际分支、实际 `HEAD`、`isAncestor(baseSha, actualHead)` 与未提交改动）；若外部工具切偏分支或回退至早于 `baseSha` 的提交，直接升级为 `mismatch`（只读禁止进入验收与保存）。
   - `bound` 报告触发工作室自建/自测自动检查，进入正常 `#07-accept`（[`Acceptance.tsx`](../../src/renderer/Acceptance.tsx)）：在「AI 自己的说法」位置展示外部报告正文，右上角标注 **「外部工具的报告，仅供参考」**；若报告声称与工作树实际存在差异，展示黄色警示条 **「报告与任务副本实际 Git 状态存在差异（已以副本实际代码为准）」**。
   - 在 `#09-rework`（[`ReworkPage.tsx`](../../src/renderer/ReworkPage.tsx)）针对外部执行任务提供双选择：**「再次交给外部工具」**（主按钮，基于同一副本继续导出下一轮任务说明）与 **「改由 Codex 继续」**（次按钮，沿用当前修改要求转回内部执行者）。

3. **`feat(review): keep each round's code with refs; redo shows previous conflict version`（[`9c7c9da`](https://github.com/luckyjamesriver/ai-solo-studio/commit/9c7c9da)）**
   - 在每次任务进入 `review`（[`TaskRunner.buildEvidence`](../../src/core/task/runner.ts)）时创建永久防回收引用 `refs/studio/rounds/<taskId>/<round>`（[`saveRoundRef`](../../src/core/git/git.ts)），将 `parent = wt.baseSha` 的基线关系与提交/引用信息一并记录到 `TaskRound`（`roundBaseSha`、`roundCommit`、`roundRef`）。
   - 改造 [`TaskController.acceptanceView`](../../src/core/app/task-controller.ts) 读取历史轮次或已保存任务的成果预览时，优先基于 `roundRef ?? roundCommit` 与 `roundBaseSha` 解析 Git 差异；即使第 2 轮冲突重做已重置 worktree 至最新主线，或任务保存并移除 worktree、运行 `git gc --prune=now`，切回「第 1 轮」仍可只读查看第 1 轮原始代码改动。
   - `reconcileTasks(now)` 自动执行 [`pruneExpiredDiscardedRoundRefs`](../../src/core/task/runner.ts) 清理超过 30 天（`ROUND_REF_RETENTION_DAYS = 30`）的已放弃任务轮次引用；已保存 / 已撤销任务保留为永久历史。
   - `prepareConflictRedo` 为冲突重做提示附带第 `N` 轮仅限冲突文件的代码参照（≤ 200 行附全文，> 200 行经 [`extractConflictSnippet`](../../src/core/acceptance/snippets.ts) 提取冲突段）与提示语「这是你上一轮的版本，与项目里新的改动冲突了，请在最新版本的基础上重新实现这部分」。

4. **`docs(research): Codex quota query feasibility`（[`ec5362d`](https://github.com/luckyjamesriver/ai-solo-studio/commit/ec5362d)）**
   - 基于本机 `codex-cli 0.166.0` 官方生成 schema（`codex app-server generate-json-schema`）、命令行实测与 OpenAI 官方文档完成调研，形成只读研究文档 [`docs/research/2026-11-codex-quota.md`](../research/2026-11-codex-quota.md)。

5. **阶段 7 E2E 闭环验证与截图报告（本提交）**
   - 在 [`e2e/shell.e2e.ts`](../../e2e/shell.e2e.ts) 新增 2 项真实 Electron E2E 测试并生成 8 张视觉核验截图 [`docs/screenshots/stage7/`](../screenshots/stage7)。

---

## 2. 关键实现决策说明

### 2.1 导入报告时对任务副本未提交改动的处理方案：**「以副本实际状态为准 + 隔离工作树内自动暂存提交」**

- **实现流程（[`TaskRunner.importExternalReport`](../../src/core/task/runner.ts) & [`G.snapshotWorktreePending`](../../src/core/git/git.ts)）**：
  1. 在写任何 git 对象前，先只读巡检 worktree 真实状态（`actualBranch`、`actualHead`、`isAncestor(baseSha, actualHead)`、工作区未提交/未跟踪改动）。
  2. 若实际分支偏离 `wt.branch`，或实际 `HEAD` 不是 `wt.baseSha` 的后代，即使报告文本声称字段一致，也立刻将导入结论判定为 `mismatch` 并阻止进入验收与保存，报告原文通过 `saveImportRecord` 只读留档。
  3. 若分支和基线合法但存在未提交改动（常见于外部工具改完文件未 `git commit`，而报告中仍写着 `baseSha` 或声称已提交）：
     - 先如实向 `realityDiscrepancies` 记录「报告声称 vs 任务副本实际未提交改动」差异；
     - 调用 `snapshotWorktreePending`（基于临时索引 `computeTree` + `commitTree` + `reset --hard`）仅把本次任务副本内的实际改动自动暂存提交到该隔离任务分支（**绝不触碰主项目工作区**）；
     - 重建 `acceptedTree` 与快照，带着真实差异警示条进入 `#07-accept` 验收页并跑通本应用自己的检查脚本。
- **取舍原因**：阶段 7 未增加额外的「先替你提交 / 忽略未提交改动」二次中断弹窗，因为 task worktree 本身就是本应用隔离给外部工具的沙箱分支，用户在验收页本来就会逐文件审查工作树真实 diff、自建/自测检查与警示条，确认并点击「验收通过并保存」后才会合并进主项目。

### 2.2 本阶段刻意不调用 `reviewImportedReport`

- 按照阶段 7 边界要求与既有协议分层考量，[`TaskRunner.importExternalReport`](../../src/core/task/runner.ts) **不调用** `src/core/thinking/handoff/import.ts` 中的 `reviewImportedReport`（并已在 [`tests/security.test.ts`](../../tests/security.test.ts) 新增回归断言守卫）：
  - 原因：导入后的质量裁决权应归属 **工作台自己的构建/测试运行结果与用户在 `#07-accept` 的逐条验收确认**，避免在导入瞬间自动触发额外 AI 规划者推理回合、外发任务摘要或意外消耗外部思考者额度；相关设计留待后续独立评审需求再接入。

### 2.3 各轮代码保留、保留期与清理规则

- **防回收策略**：每轮进入 `review` 即由 [`saveRoundRef`](../../src/core/git/git.ts) 写入 `refs/studio/rounds/<taskId>/<round>`，确保提交树及其 `baseSha` 父链路拥有可达 Git 引用，不因冲突重做重置 worktree 分支或保存后清理 worktree 及 `git gc` 而丢失。
- **保留与清理边界**：
  - **`saved`（已保存）与 `undone`（已撤销）**：其轮次引用永久保留，作为任务历史与后续溯源凭证；
  - **`discarded`（已放弃）**：按任务放弃/最后更新时间计算 **30 天保留期**（`ROUND_REF_RETENTION_DAYS = 30`），在应用启动对账 `reconcileTasks(now)` 时由 `pruneExpiredDiscardedRoundRefs` 自动调用 `deleteRoundRefs` 清理超期引用，避免长期堆积。

---

## 3. Codex 额度查询调研核心结论摘要

详尽论证与引用来源见 [`docs/research/2026-11-codex-quota.md`](../research/2026-11-codex-quota.md)，核心结论如下：

1. **CLI 与 REST API**：`codex-cli 0.166.0` 没有非交互查额度子命令；OpenAI Platform API 的 `/v1/organization/usage/...` 仅面向按量计费的 API 组织管理员，**不存在官方公开的个人 ChatGPT Plus/Pro 订阅剩余额度 REST API**。个人订阅常规查看位置为 ChatGPT Web/桌面端 `Settings → Usage`（或交互式 TUI `/status`）。
2. **`codex app-server` 官方协议能力与授权前提**：经实测生成的 v2 JSON schema 中存在只读 JSON-RPC 方法 `account/rateLimits/read` 及推送通知 `account/rateLimits/updated`（返回 5 小时/周限额窗口与精确 `resetsAt` 及 `ordinaryUsageAllowed`），不启动回合、不消耗模型推理额度；但**前提是 app-server 当前持有合法 ChatGPT 订阅授权上下文**。
3. **非官方接口禁令**：社区流传的 `/backend-api/wham/usage` 为未公开内部端点，存在接口变更与合规风控风险，**本应用严禁依赖或直接调用**。
4. **第一版（v1.0）产品建议**：在正式接入 OpenAI 官方 *Sign in with ChatGPT* 合规 OAuth 授权并完成 [`ADR 0009`](../adr/0009-antigravity-integration.md) 第 5 节待办核实之前，**第一版不做实时 Codex 额度面板**；仅在真实遇到 `quota_exhausted` 报错时提示服务端原文与 `Settings → Usage` 引导，且严格禁止本地根据历史用量推算百分比或跨过 `resetsAt` 自动判定已恢复。

---

## 4. 安全边界与测试增量（`tests/security.test.ts`）

- 严格遵守阶段 1–6 安全防线只增不减原则：
  - 受控 IPC 方法白名单从阶段 6 的 **58** 项同步更新至 **62** 项（新增登记 `exportExternalTask`、`revealHandoff`、`importExternalReport`、`reworkExternalTask` 四个带 `projectId` 校验与精确参数形态的受控方法，带 `projectId` handler 守卫同步增至 **47** 个）；[`scripts/smoke.mjs`](../../scripts/smoke.mjs) 与 [`e2e/shell.e2e.ts`](../../e2e/shell.e2e.ts) 中的 `window.studio` 全量 63 项暴露属性清单（62 个方法 + `onSaveProgress`）已同步；
  - 新增外部交接安全断言：仅允许 `.md` / `.txt` 报告文件、核心导出路径不启动外部进程（`spawn`/`exec`）、导出后任务状态转入 `waiting_external` 且 `importExternalReport` 绝不调用 `reviewImportedReport`。

---

## 5. 阶段 7 界面截图清单（`docs/screenshots/stage7/`）

全部由本地 Electron E2E 运行时真实截取并逐张核验通过：

| 序号 | 文件名 | 核验内容 |
|---|---|---|
| 1 | [`01-external-confirm-dialog.png`](../screenshots/stage7/01-external-confirm-dialog.png) | `#04-plan` 点击「交给外部工具执行」弹出的三条风险确认说明弹框 |
| 2 | [`02-external-waiting.png`](../screenshots/stage7/02-external-waiting.png) | `外部执行中（等待导入报告）` 等待页：副本完整路径、`.studio/handoff/.../task.md`、导出时间与四枚操作按钮 |
| 3 | [`03-workbench-external-badge.png`](../screenshots/stage7/03-workbench-external-badge.png) | 工作台「需要你决定（0）」不计入外部执行中任务；在「正在运行（1）」分组标注「外部执行中」 |
| 4 | [`04-import-mismatch-readonly.png`](../screenshots/stage7/04-import-mismatch-readonly.png) | 导入分支不符的 `bad-mismatch.txt` 后只读展示矛盾明细，禁止进入验收或保存，按钮变为「重新导入报告」 |
| 5 | [`05-external-acceptance.png`](../screenshots/stage7/05-external-acceptance.png) | 导入含工作树未提交改动的 `good-bound.md`：展示真实改动 diff、工作室自跑测试、「外部工具的报告，仅供参考」及「报告与任务副本实际 Git 状态存在差异（已以副本实际代码为准）」警示 |
| 6 | [`06-external-rework-choice.png`](../screenshots/stage7/06-external-rework-choice.png) | 外部执行任务在 `#09-rework` 提供「再次交给外部工具」与「改由 Codex 继续」双选择 |
| 7 | [`07-external-saved.png`](../screenshots/stage7/07-external-saved.png) | 确认验收后经过 4 步保存校验并写入主项目，完成保存 |
| 8 | [`08-round1-historical-diff.png`](../screenshots/stage7/08-round1-historical-diff.png) | 冲突任务 B 进入第 2 轮并重置 worktree 至最新主线后，切换回「第 1 轮」通过 `refs/studio/rounds` 只读查看第 1 轮原始改动 |

---

## 6. 全量验证结果与 CI 状态

### 本地全量验证（推送前实测）
- `npm run typecheck`：退出码 `0`
- `npx vitest run --maxWorkers=2`：**35 个测试文件通过，12 个真实环境集成测试按条件跳过（共 47 个文件）；613 个用例通过，38 个集成用例跳过（共 651 个），0 失败**（含 [`tests/stage7-handoff.test.ts`](../../tests/stage7-handoff.test.ts) 4 项、[`tests/stage7-rounds.test.ts`](../../tests/stage7-rounds.test.ts) 2 项、[`tests/handoff.test.ts`](../../tests/handoff.test.ts) 29 项、[`tests/security.test.ts`](../../tests/security.test.ts) 58 项）
- `npm run build && npm run smoke`：全部 PASS（`window.studio` 受控接口、Git 与 Codex 五层体检，退出码 `0`）
- `npm run test:e2e`：**51 / 51 全部通过**（`309.84s`，0 失败、0 跳过；含阶段 7 新增 2 项外部交接与多轮代码保留全流程 E2E）

### GitHub Actions 双平台 CI（`rebuild` 分支）
- 全量代码 + 截图 + 报告双平台绿灯运行（[`ca085e5`](https://github.com/luckyjamesriver/ai-solo-studio/commit/ca085e5)）：[https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42898640638](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42898640638)
  - `test (ubuntu-latest)`：`success`（1m7s，[job 130118372602](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42898640638/job/130118372602)）
  - `test (macos-latest)`：`success`（5m21s，[job 130118372160](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42898640638/job/130118372160)，含 51 项 Electron E2E 全量通过）

# 阶段 5a 完成报告 · 讨论阶段进入界面（UI v2.1 第 4 节，原型 `#03-discuss`）

- 仓库：`luckyjamesriver/ai-solo-studio`（分支 `rebuild`）
- 依据规范：[`docs/ui/UI_v2.1.md`](../ui/UI_v2.1.md)（已冻结，第 4、9 节）、[`docs/THINKING_FLOW.md`](../THINKING_FLOW.md) 与可点击原型 [`docs/ui/prototype.html`](../ui/prototype.html)（`#02-project`、`#03-discuss`、`#04-plan`）

---

## 1. 提交清单与内容摘要（大白话）

本阶段严格按要求拆为 4 个提交（随后附加报告与 CI 记录提交）：

1. **`feat(think): drive flow engine from the app with pause-and-resume UI`（`f45f27c`）**
   - 在 [`model.ts`](../../src/core/task/model.ts) 与 [`runner.ts`](../../src/core/task/runner.ts) 为任务绑定唯一思考线程字段（`threadId`、`planUnreviewed`、`approvedPlanPath`），新增 `TaskRunner.bindThread` 与 `TaskRunner.applyApprovedDiscussion`，使任务持久化仍在 `TaskRunner` 收口。
   - 在 [`flow/driver.ts`](../../src/core/thinking/flow/driver.ts) 实现可暂停恢复驱动层：`createPausedFlowUI` 在 5 个需要用户决定的节点（首次外发同意 `send_consent`、需求条目确认 `requirements_confirmation`、尝试失败 `attempt_failed`、分歧裁决 `adjudication`、方案批准 `approval`）绝不默认通过，而是落盘暂停并由 `inspectDiscussion` 还原全部只读状态（含四类依据核验原文、六字段评审记录、按次/已知金额预算和步骤列表）。
   - 新建 [`src/core/app/discussion-service.ts`](../../src/core/app/discussion-service.ts) 并在 [`task-controller.ts`](../../src/core/app/task-controller.ts)、[`main/index.ts`](../../src/main/index.ts)、[`preload/index.cts`](../../src/preload/index.cts) 与 [`renderer/api.ts`](../../src/renderer/api.ts) 接入 9 个 `discussion:*` 受控 IPC；预设选择在主进程 [`main/index.ts`](../../src/main/index.ts) 收口：产品默认仅 `codex-single`，开发者预设 `dev-personal` 仅在非打包环境下且显式设置 `STUDIO_DEV_PERSONAL_CLAUDE=1` 时可用，构造 `ClaudeCliThinker` 必传 `isPackaged`。

2. **`feat(think): discussion page with decisions, requirements and review record`（`f4c8492`）**
   - 新建 [`src/renderer/DiscussionPage.tsx`](../../src/renderer/DiscussionPage.tsx)（原型 `#03-discuss`），提供 `方案摘要` / `与首席对话` / `与复核对话`（单思考者模式下隐藏）/ `评审记录`（只读）四个页签。
   - 在 `方案摘要` 顶部优先展示待裁决卡片（含来源、首席结论、接受/驳回后果对比、驳回必填理由与逐字依据核验结论）以及外发确认、需求确认编辑、失败重试说明三种暂停卡片；在 `需求` 卡片提供「修改需求」入口；在 `方案` 卡片提供「看全文 / 收起全文」；右栏持续展示实时步骤进度、「批准方案」（存在安全问题或未裁决项时置灰并列出原因）、次要「跳过讨论，直接写计划」以及如实计量的「用量与预算」。
   - 在 [`TaskPage.tsx`](../../src/renderer/TaskPage.tsx) 与 [`App.tsx`](../../src/renderer/App.tsx) 把 `draft` / `clarifying` 状态的任务直接接入讨论页，并让 `e2e/shell.e2e.ts` 的 `newTask` 辅助函数先点击「跳过讨论，直接写计划」再进入施工计划页。

3. **`feat(think): separate per-thinker conversations with isolation`（`2482978`）**
   - 在 [`src/core/thinking/flow/chat.ts`](../../src/core/thinking/flow/chat.ts) 实现按思考者彻底隔离的独立会话：记录保存在 `.studio/threads/<threadId>/conversations/planner.json` 与 `reviewer.json`；严格只依赖 `Thinker` 接口而不引用具体实现；发给复核的上下文只含必带层、冻结需求、方案正文（不含首席原始输出、推理、`resolutions`、`item_marks` 或用户↔首席对话）以及复核本人的正式评审产物；发给首席的上下文不含用户↔复核对话。
   - 对话共享线程预算（计入 `rec.attempts` 与 `callsUsed` / `knownCostUsd`）、遵守首次资料外发同意、保持零文件/命令写权限、且不修改正式 `review.v1` 产物；复核在 `review` 产物生成后的回复一律标 `postReview: true`（界面显示「评审后的讨论 · 非独立评审」）。
   - 通过单个新 IPC `discussion:chat`（`sendDiscussionChat`）接入 [`DiscussionPage.tsx`](../../src/renderer/DiscussionPage.tsx) 的两个对话页签，输入框旁持续提醒「想改需求，请用「修改需求」」。

4. **`feat(think): approved plan becomes task plan; stage bar and board rename`（`2845981`）**
   - 在 [`task-state-view.ts`](../../src/core/app/task-state-view.ts)、[`discussion-service.ts`](../../src/core/app/discussion-service.ts)、[`task-view.ts`](../../src/core/app/task-view.ts)、[`task-controller.ts`](../../src/core/app/task-controller.ts) 与 [`open-projects.ts`](../../src/core/app/open-projects.ts) 打通实时讨论状态映射：五个暂停点（`待同意外发`、`需求待确认`、`尝试失败待选择`、`意见待裁决`、`方案待批准`）归入工作台「需要你决定」并计入侧栏角标；实时思考时归入「正在运行」（显示 `讨论中 · 首席正在拆解需求` 等）且不计入需要你决定的角标。
   - 批准讨论后确定性转换出施工计划（目标、冻结需求条目 + 方案验收小节条目作为施工验收标准、`planUnreviewed`、驳回风险写入 `Task.acceptedRisks` 并在验收页「你已知晓并接受的风险」展示）；[`PlanCard.tsx`](../../src/renderer/PlanCard.tsx) 在 `planUnreviewed` 为真时持续展示「未经独立评审」标记（同时修复预选完全信任提示判断，使通过讨论批准或跳过讨论进入的计划页都能如实提醒首次确认）。
   - 将阶段条与看板第一列统一切换为 **`1 讨论 → 2 施工 → 3 验收`** 与 **`讨论中`**（[`TaskPage.tsx`](../../src/renderer/TaskPage.tsx)、[`copy.ts`](../../src/renderer/copy.ts)），并完成全部单元与端到端测试及 9 张截图核验。

---

## 2. 流程引擎规则遵守与边界设计说明

1. **需求冻结后「修改需求」的实现方式**
   - [`FlowEngine`](../../src/core/thinking/flow/engine.ts) 规则规定：一旦需求冻结（`requirements_confirmed`），本线程前向不可变，且必须保持「一个任务只对应一个讨论线程」与「不改动 FlowEngine 规则」。
   - 因此用户在需求冻结后点击「修改需求」时，[`TaskController.modifyDiscussionRequirements`](../../src/core/app/task-controller.ts) 先安全等待并把原线程置为 `stopped`（保留全部历史尝试、正式产物和日志）、放弃原草稿任务，再以修改后的需求创建新任务并绑定全新线程，界面自动切换到新任务开始新一轮讨论。

2. **`docs/PROJECT_CONTEXT.md` 必带层门禁**
   - 未放宽 [`loadRequiredContext`](../../src/core/thinking/flow/support.ts#L41-L53) 对项目 `docs/PROJECT_CONTEXT.md`（含第 1、2、4 节）的要求；新建任务默认创建初始线程（尚未调用 AI），点击「开始讨论」若项目缺少该文件会原样报错并保留「跳过讨论，直接写计划」退路。

3. **安全与隔离基线（`tests/security.test.ts` 只增不减）**
   - 全套 [`tests/security.test.ts`](../../tests/security.test.ts) **51 项全部通过**，原有断言零删除零放宽：
     - Preload 白名单按前例扩展至 **46** 个方法、固定 `SHAPES` / `MAIN_SHAPES`；带 `projectId` 的主进程 handler 计数同步更新为 **36**（1 `projects:close` + 1 `project:status` + 11 `tasks:*` + 10 `discussion:*` + 13 `acceptance:*`），全部先经 `openProjects` 校验。
     - `flow/driver.ts` 与 `flow/chat.ts` 只导入 `Thinker` 接口类型（零具体思考者引用、`zero 'never' literal`、零 `worktree_write`），且 `chat.ts` 仅通过 `./support.js` 引用 `ConsentStore`，遵守 ADR 0006 持久化边界。
     - 渲染层 [`DiscussionPage.tsx`](../../src/renderer/DiscussionPage.tsx) 经由 [`DiscussionView`](../../src/core/app/discussion-service.ts) 读取 `neededMaterials`，源码不含 `\bevidence\b`、`rawOutput`、`currentChecks` 或禁用动作字面量；`TaskController` 仍保持仅在 `runSave` 出现一次 `.save(` 调用。
     - [`tests/construction-ui.test.ts#L404`](../../tests/construction-ui.test.ts#L404) 仅排除了新增的讨论方案批准方法 `decideDiscussionApproval`，其余施工期禁审批检查一字不变。

4. **预算展示与阶段 5b/后续留白原则**
   - [`driver.ts`](../../src/core/thinking/flow/driver.ts) 与 [`DiscussionPage.tsx`](../../src/renderer/DiscussionPage.tsx) 仅当思考者返回真实 `usage.costUsd` 时展示美元金额，Codex 等按次计数实现只显示 `callsUsed / callsMax` 与耗时，绝不虚构美元金额。
   - 不在界面放未实现功能的空占位（不含阶段 5b 的 Claude API Key 设置、设置页「AI 接入与角色」、也不含「导出给外部工具」按钮）。

---

## 3. 阶段 5a 截图清单（`docs/screenshots/stage5/`）

| 序号 | 文件名 | 对应界面与状态 | 验证要点 |
|---|---|---|---|
| 1 | [`01-confirm-requirements.png`](../screenshots/stage5/01-confirm-requirements.png) | 需求条目确认（双思考者） | 展示 R1/R2 可编辑条目、删除、添加一条、主按钮「确认并冻结需求」 |
| 2 | [`02-summary-adjudicate.png`](../screenshots/stage5/02-summary-adjudicate.png) | 方案摘要 + 裁决卡片 | 「需要你裁决（1）」置顶、`提供了依据（文件存在）`逐字展示、右栏「批准方案」置灰提示原因 |
| 3 | [`03-reject-reason.png`](../screenshots/stage5/03-reject-reason.png) | 驳回意见填写理由 | 展开必填理由输入框，提示「批准后将记录在验收页风险中」，确认驳回可点 |
| 4 | [`04-chat-planner.png`](../screenshots/stage5/04-chat-planner.png) | 与首席对话 | 仅含用户↔首席历史、右侧进度「✓ 你裁决分歧 / ● 批准方案」、提示「想改需求，请用「修改需求」」 |
| 5 | [`05-chat-reviewer.png`](../screenshots/stage5/05-chat-reviewer.png) | 与复核对话（隔离说明 + 标记） | 复核回复带「评审后的讨论 · 非独立评审」标记、顶部写明隔离范围 |
| 6 | [`06-review-record.png`](../screenshots/stage5/06-review-record.png) | 评审记录（只读） | 逐条检查（R1/R2 已覆盖）、6 字段意见与逐字依据核验、缺口资料与条目标注 |
| 7 | [`07-single-unreviewed.png`](../screenshots/stage5/07-single-unreviewed.png) | 单思考者模式总览 | 「未经独立评审」徽标、隐藏「与复核对话」页签、用量卡仅显示次数与耗时（无 `$`） |
| 8 | [`08-attempt-failed.png`](../screenshots/stage5/08-attempt-failed.png) | 步骤尝试失败停下 | 中文步骤/状态标签（「首席起草 / 调用失败」）、补充说明输入框与三种处理按钮 |
| 9 | [`09-accepted-risks.png`](../screenshots/stage5/09-accepted-risks.png) | 讨论批准 → 施工 → 验收 | 验收页「检查与证据」下方清晰显示「你已知晓并接受的风险」及驳回意见与理由 |

---

## 4. 验证结果、过程中问题修复与 CI

### 本地最终验证结果（全部在最后一次代码改动后实测通过）
- `npm run typecheck`：退出码 `0`（零错误）
- `npm run build`：`build:core` 与 `build:renderer` 全部构建通过
- 全量单元测试（`npx vitest run --maxWorkers=4`）：**30 个文件通过，11 个真机/联网集成测试文件按环境条件跳过（共 41 个文件）；579 个用例通过，37 个集成用例跳过，0 失败**（耗时 86.79s；其中 [`tests/stage5-discuss.test.ts`](../../tests/stage5-discuss.test.ts) 9 项、[`tests/security.test.ts`](../../tests/security.test.ts) 51 项全部通过）
- 全量 Electron E2E 测试（`E2E_STAGE5_SHOT_DIR=docs/screenshots/stage5 npm run test:e2e`）：**42 / 42 全部通过**（耗时 170.94s，含阶段 1–4 全部回归与阶段 5a 两条 E2E 闭环及 9 张截图生成）
- 冒烟测试（`npm run smoke`）：全部 PASS（46 个 preload API 精确核对、安全隔离与环境体检通过，退出码 `0`）

### 过程中遇到的失败及修复
1. `tests/security.test.ts:693` 在提交①初跑失败：原因是在 `TaskController` 新增讨论方法里直接调用了 4 次 `this.r().store.save(t)`，触发「整个 `TaskController` 只有 `runSave` 一处 `.save(`」门禁。将任务绑定与讨论落盘写操作移回 `TaskRunner.bindThread` 和 `TaskRunner.applyApprovedDiscussion` 后通过。
2. `tests/security.test.ts:608` 在提交③初跑失败：`chat.ts` 直接从 `../../persistence/index.js` 导入 `ConsentStore` 触发 ADR 0006 边界检查。改为从同级 `./support.js` 导入后完全遵守持久化边界。
3. `tests/construction-ui.test.ts:404` 在阶段④跑全量单测时匹配到 `decideDiscussionApproval`（以 `decide` 开头被施工期禁审批正则误伤）：补充精确排除 `decideDiscussionApproval`（保留全部施工期禁审批检测）后通过。
4. E2E 全量跑阶段④时暴露三处真实问题：
   - `PlanCard.tsx` 原条件 `!hasPlan && preferredMode === 'full_trust'` 在跳过讨论或批准讨论进入 `planned` 态后不再显示预选提示；改为 `!task.fullTrustConfirmed && preferredMode === 'full_trust' && mode === 'full_trust'`；
   - `e2e/shell.e2e.ts` `gitProject` 未递归建子目录导致写 `docs/PROJECT_CONTEXT.md` 报错；`确定性并发控制` 的 `__blockFirstList` 开关未在第一次挂起后复位导致 `skipDiscussion` 触发的第二次 `tasks:list` 也拿到空数组；两处修复后 42/42 E2E 一次全绿。
5. 初次截图视觉审阅发现 `04`/`05`/`06` 右栏进度中「你裁决分歧」在全部裁决完成后仍为 `●`（未切到 `✓` 和 `● 批准方案`），以及 `08` 失败卡与对话时间戳直接展示 `draft`/`failed` 和完整 ISO 字符串。已在 `driver.ts` 与 `DiscussionPage.tsx` 修正并重跑全套验证与复核截图。
6. 首次推送 `rebuild` 的 CI（Run [`42837836184`](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42837836184)）在 `ubuntu-latest` 全绿，在 `macos-latest` E2E 执行 `conflict-site` 偶发 `git commit` 遭遇 `.git/index.lock: File exists`（由于 `confirmOverall` 后的 `projectStatus` 触发后台只读 `git status` 未关闭可选锁引起）；在 [`src/core/git/git.ts`](../../src/core/git/git.ts) `hostGitEnv` 加入 `GIT_OPTIONAL_LOCKS: '0'` 后重新跑通全套本地单测与 E2E 并重推 CI。

### GitHub Actions CI（`rebuild` 分支）
- 等待新一次双平台 CI 完成并补充链接。

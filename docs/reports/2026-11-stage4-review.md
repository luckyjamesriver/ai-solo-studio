# 阶段 4 完成报告 · 验收页、检查依据、退回修改、多轮记录与标准模式读取说明

- 仓库：`luckyjamesriver/ai-solo-studio`（分支 `rebuild`）
- 依据规范：[`docs/ui/UI_v2.1.md`](../ui/UI_v2.1.md)（已冻结，第 6、9 节）与可点击原型 [`docs/ui/prototype.html`](../ui/prototype.html)（`#07-accept`、`#08-evidence`、`#09-rework`）

---

## 1. 提交清单与内容摘要（大白话）

本阶段严格按要求拆为 4 个提交（随后附加报告与 CI 记录提交）：

1. **`feat(review): acceptance page with pass / incomplete / failed states`（`c00ea5e`）**
   - 按原型 `#07-accept` 重做 [`Acceptance.tsx`](../../src/renderer/Acceptance.tsx)：左主区依次为「成果预览 → 检查与证据（每项带查看入口）→ AI 自己的说法（标注仅供参考，以上方事实为准）」，右栏为「验收状态 → 验收标准逐条确认（符合 / 不符合，不符合可填一句说明）→ 被拦下的操作 → 操作按钮」。
   - 在 [`card.ts`](../../src/core/acceptance/card.ts)、[`model.ts`](../../src/core/task/model.ts)、[`runner.ts`](../../src/core/task/runner.ts) 与 [`view.ts`](../../src/core/acceptance/view.ts) 新增 `CriterionState.note`、`overallDecision`、`overallNote` 与预留字段 `acceptedRisks`；核心层 `computeAcceptanceStatus` 严格只输出三种状态之一：**验收通过**（全部「符合」→「验收通过并保存」为主按钮）、**验收未完成**（尚有未确认项 → 保存置灰并写原因）、**验收未通过**（任意一条「不符合」→ 主按钮变为「退回修改」，隐藏保存按钮）。不存在「部分通过」。
   - 新增 `acceptance:rejectCriterion`（[`task-controller.ts`](../../src/core/app/task-controller.ts)、[`main/index.ts`](../../src/main/index.ts)、[`preload/index.cts`](../../src/preload/index.cts)），让「不符合」及可选说明受同一验收版本保护。

2. **`feat(review): evidence page with round binding and filtered details`（`862a0e3`）**
   - 在 [`runner.ts`](../../src/core/task/runner.ts) 持久化每次构建/测试检查的结构化记录 `currentChecks: StoredCheckProof[]`（本地任务记录保留 `rawOutput`）。
   - 新建 [`src/core/acceptance/proof.ts`](../../src/core/acceptance/proof.ts)，构建面向界面的 `TaskProofView`：每项证据绑定第几轮、运行时间、运行环境（沙箱环境 / 本机环境）和「由本应用运行，不是 AI 自报」，解析逐条测试用例名称（无法解析时退回通过/失败数量），并在发送至渲染层前执行 `filterProofOutput` 脱敏。没有自动检查时如实显示「未检查：这个项目没有自动检查」或「未检查：这个项目没有构建检查」，绝不标「通过」。
   - 新建 [`src/renderer/CheckProofPage.tsx`](../../src/renderer/CheckProofPage.tsx)（原型 `#08-evidence`，含「自动测试 / 构建检查 / 被拦下的操作 / 改动的文件」四标签页、「详细记录」默认折叠 `<details>`）并从验收页各事实行接入「查看依据 / 查看影响 / 查看改动」。

3. **`feat(review): send back for rework with per-round records`（`b4c4c07`）**
   - 在 [`model.ts`](../../src/core/task/model.ts) 与 [`runner.ts`](../../src/core/task/runner.ts) 建立统一的多轮独立归档模型 `Task.rounds`（`TaskRound[]`）：无论是验收页「退回修改」（`reworkTask`），还是停止/中断后「继续执行」（`continueTask`）与「修改权限后重启」（`editReworkPermissions`），都在**同一个 `worktree` 副本**上开启第 `N` 轮，且旧轮次的验收卡、检查明细、被拦操作、确认结果与 AI 说明保持独立不被覆盖。
   - 在 [`view.ts`](../../src/core/acceptance/view.ts) 下发 `currentRound`、`rounds: RoundSnapshotView[]`（各轮独立摘要、Diff 预览与 `proof`）以及 `rework` 上下文；在 [`Acceptance.tsx`](../../src/renderer/Acceptance.tsx) 顶部显示「第 N 轮」与多轮切换标签（切换查看历史轮次时只读、且点「查看依据」打开对应轮次记录），并新增 [`ReworkPage.tsx`](../../src/renderer/ReworkPage.tsx)（原型 `#09-rework`：反馈输入框、自动附上不符合的标准及说明、沿用上一轮权限摘要与「修改」回计划页入口、因当前仅支持 Codex 而不显示执行者切换控件、主按钮「开始第 N 轮」）。
   - 在 [`ProjectBoard.tsx`](../../src/renderer/ProjectBoard.tsx) 任务/历史卡片、[`Workbench.tsx`](../../src/renderer/Workbench.tsx) 工作台条目与 [`TaskPage.tsx`](../../src/renderer/TaskPage.tsx) 任务页头补充「第 N 轮」（`N >= 2`）标记。

4. **`fix(copy): accurate read-access wording in standard mode`（`04d8fc7`）**
   - 在 [`src/core/executor/modes.ts`](../../src/core/executor/modes.ts) 统一导出标准模式真实读取说明 `STANDARD_READ_ACCESS_NOTE` 与 `blockedReadLocations()`（直接调用 `sensitiveFallbackList('~')` 动态生成，无手写清单），同步接入 [`permission-text.ts`](../../src/core/app/permission-text.ts)、[`task-view.ts`](../../src/core/app/task-view.ts) 与 [`copy.ts`](../../src/renderer/copy.ts)。
   - 在 [`PlanCard.tsx`](../../src/renderer/PlanCard.tsx)、[`RunView.tsx`](../../src/renderer/RunView.tsx)（仅使用 `<details>` 语义折叠元素，不增加任何 `<button>` 或交互字眼，严格保留唯一次要按钮「停止」）和 [`Acceptance.tsx`](../../src/renderer/Acceptance.tsx) 权限详情中提供「查看被挡住的敏感位置清单」折叠清单，并更新既有单测与阶段 4 E2E 验证与截图。

---

## 2. 多轮数据结构与核心流转说明

### 数据结构（[`src/core/task/model.ts`](../../src/core/task/model.ts)）

- **`Task` 顶层多轮字段**：
  - `currentRound?: number`：当前轮次编号（从 1 开始）。
  - `roundStartedAt?: string` / `roundEndedAt?: string`：当前轮起止时间。
  - `currentChecks?: StoredCheckProof[]`：当前轮自动检查原始记录（含 `name`、`status`、`ranAt`、`env`、`durationMs`、`rawOutput` 等，仅存 `.studio/records/`）。
  - `pendingFeedback?: string`：由 `prepareContinue` 写入的下一轮指令说明（例如用户输入反馈 + 自动附上的不符合验收标准；`continueTask` 固定写入 `'接着上次停下的地方继续'`；`editReworkPermissions` 后在用户重新批准开工时由 `runTask` 读取并消费）。
  - `rounds?: TaskRound[]`：按轮次归档的不可变快照数组（每轮结束生成验收卡或用户确认时经 `syncCurrentRound` 更新**当前** `roundNo` 对应条目，历史轮次 `round < currentRound` 永不改写）。
- **`TaskRound` 单轮快照结构**：
  - 包含 `round`、`startedAt`、`endedAt`、`feedback`、`capabilities`、`executorId`、`executorName`、`model`、`effectivePermissions`、`exit`、`gitBinding`、`acceptedTree`、`checksVoid`、`denied`、`deniedAcks`、`criteria: RoundCriterionSnapshot[]`（保留当轮每条标准的 `text`/`decision`/`note`）、`overallConfirmed`、`overallDecision`、`overallNote`、`checks: StoredCheckProof[]`、`card?: AcceptanceCard`、`aiMessages: string[]`。
- **视图映射（[`src/core/acceptance/view.ts`](../../src/core/acceptance/view.ts) & [`proof.ts`](../../src/core/acceptance/proof.ts)）**：
  - `toUserView` 通过 `buildRoundSnapshot` 与 `buildRoundProof` 为每一轮生成独立的 `RoundSnapshotView`（含当轮的事实列表、Git Diff 片段 `roundPreviews`、确认状态与过滤后的 `proof`）。
  - 保存校验：[`TaskRunner.save`](../../src/core/task/runner.ts) 始终基于当前 `Task`（最新一轮）冻结 `acceptedTree` 与合并保存；前端在历史轮次视图隐藏「保存 / 退回修改 / 放弃 / 确认」按钮，只提供「回到第 N 轮（当前）」。

---

## 3. 检查依据脱敏规则清单

原始检查输出 `rawOutput` 仅持久化在本机 `.studio/records/tasks/<id>.json` 中。所有发往渲染层的检查依据均在核心层由 [`filterProofOutput`](../../src/core/acceptance/proof.ts#L81-L168) 与 [`scrubAiText`](../../src/core/acceptance/texts.ts) 过滤后生成（`tests/security.test.ts` 已加断言禁止渲染层出现 `rawOutput` / `currentChecks` 字段）：

1. **私钥与跨行凭据块**：`-----BEGIN ... PRIVATE KEY----- ... -----END ... PRIVATE KEY-----` 整体替换为 `[密钥已隐去]`。
2. **工作树、仓库根与用户主目录路径替换**：
   - 当前任务副本路径替换为 `[任务副本]`，主项目路径替换为 `[项目目录]`。
   - 本机 `os.homedir()` 及任何未命中形式 `/Users/<name>`、`/home/<name>`、`C:\Users\<name>` 一律替换为 `~`（保护已脱敏的 `~/...` 路径在后续 `scrubAiText` 时保留为 `~` 相对形式，便于定位测试文件名但不泄露本机用户名）。
   - 系统临时路径 `/var/folders/...`、`/private/var/folders/...`、`/tmp/...` 替换为 `[临时路径已隐去]`；系统工具路径 `/usr/(local/)?(bin|lib|share)/...` 替换为 `[本机路径已隐去]`。
3. **整行命令行与环境变量倾倒过滤**：
   - 以 `> `、`$ `、`+ ` 开头的脚本命令行（如 `> app@1.0.0 test`、`$ vitest run`）整行替换为 `[命令行已隐去]` 并对相邻重复折叠去重。
   - 整行 `export KEY=...` 或全大写环境变量赋值行 `KEY=VALUE` 替换为 `[环境变量已隐去]`。
4. **内联密钥、环境变量与命令碎片清洗**：
   - 内联 `sk-...`、`ghp_/gho_/ghu_/ghs_/ghr_...`、`github_pat_...`、`AKIA...`、`AIza...`、`xox...-`、`eyJ...`（JWT）、`Bearer/Basic ...` 与 `api_key/secret_key/access_token/auth_token/password/client_secret=...` 全部替换为 `[密钥已隐去]`。
   - 内联全大写环境变量 `KEY=VAL` 替换为 `[环境变量已隐去]`。
   - 内联 `npm/npx/yarn/pnpm run|exec|test|build|...`、`vitest/jest/mocha/pytest/cargo test/go test ...`、`node ...` 命令行调用替换为 `[命令行已隐去]`，随后统一再经过 `scrubAiText`。
5. **输出截断**：最多保留 160 行 / 12,000 字符，防止超长原始日志撑爆界面与 IPC 消息。

---

## 4. `tests/security.test.ts` 逐条变更说明

所有既有安全基线断言**零删除、零放宽**，仅按阶段 1–3 同例增补新增 IPC 白名单/计数与阶段 4 新边界断言（`git diff 2170148..04d8fc7 -- tests/security.test.ts`）：

1. **`M3-B1` Preload API 与主进程句柄白名单（第 279–297 行）**：
   - 将精确方法名单由 33 项同步扩充至 **36 项**（新增 `reworkTask`、`editReworkPermissions`、`rejectCriterion`）；
   - `SHAPES` 与 `MAIN_SHAPES` 同步登记 `'projectId: string, id: string, feedback: string'` 与 `'projectId: string, id: string, itemId: string, version: string, reason: string'`，不含任何路径参数或宽松类型。
2. **新增 IPC 参数与主进程对应关系检查（第 469–477 行）**：
   - 在 `NEW` 精确签名表新增 `reworkTask`、`editReworkPermissions`、`rejectCriterion`，核对与主进程 `ipcMain.handle` 通道一一对应。
3. **多项目 `projectId` 归属校验计数（第 799–800 行）**：
   - 校验必须经过 `openProjects.require(projectId)` 的处理器数量由 `23` 同步更新为 **`26`**（1 `projects:close` + 1 `project:status` + 11 `tasks:*` + 13 `acceptance:*`）。
4. **新增 `describe('阶段 4：退回修改与依据边界校验（只增不减）')`（第 911–961 行）**：
   - 校验 `ctl.reworkTask` 与 `ctl.editReworkPermissions` 拒绝伪造任务 ID、超长反馈（>2000 字符）、非 `reviewing` 状态与 `manualReview` 锁定状态；
   - 校验 `src/renderer/` 全部源码文件均不包含 `\brawOutput\b` 或 `\bcurrentChecks\b`。
5. **`M3-B1` 个人路径/凭证关键词正则遵守说明**：
   - 标准模式新文案中含示例字眼 `.ssh` 且清单含 `auth.json`、`Keychains` 等目录名；为严守现有断言 [`tests/security.test.ts#L329`](../../tests/security.test.ts#L329)（禁止 `src/core/env/` 与 `src/core/app/` 出现敏感文件名正则）不改一字，本阶段将 `STANDARD_READ_ACCESS_NOTE` 与 `blockedReadLocations()` 定义在底层权限模块 [`src/core/executor/modes.ts`](../../src/core/executor/modes.ts)，`permission-text.ts` 与 `task-view.ts` 通过导入引用而非在 `app/` 中手写敏感路径字符串。

---

## 5. 与规范 / 原型不一致处及原因

1. **「你已知晓并接受的风险」数据来源**：
   - 规范 [`docs/ui/UI_v2.1.md`](../ui/UI_v2.1.md) 第 4/6 节及本阶段要求明确该块来自阶段 5「讨论阶段驳回评审意见」，现阶段尚未接讨论页；已在 [`model.ts`](../../src/core/task/model.ts)（`acceptedRisks`）、[`view.ts`](../../src/core/acceptance/view.ts) 与 [`Acceptance.tsx`](../../src/renderer/Acceptance.tsx) 预留数据结构、清洗逻辑和展示位置，任务无风险时不显示（仅在单元测试验证展示）。
2. **「退回修改」后修改权限的按钮落点**：
   - 原型 `#09-rework` 只画了静态示例 `标准 · 仅任务副本 · 可联网 [修改]`；真实实现中点击 `修改` 调用 `editReworkPermissions` 后会将已输入的反馈暂存在 `pendingFeedback` 并按状态机经 `request_fix → approved → edit_plan` 退回 `planned`（提示「修改权限后，需要重新点击『批准并开工』才能开始第 N 轮」），用户在 `PlanCard` 修改并重新点击「批准并开工」即可消费 `pendingFeedback` 启动新一轮，不会丢失先前轮次与任务副本。
3. **标准模式读取清单放进折叠列表 `<details>`（无额外 `<button>`）**：
   - 原型及既有冻结安全测试 [`tests/security.test.ts#L174-L182`](../../tests/security.test.ts#L174-L182) 要求 `RunView.tsx` 只能有唯一 `<button>`（「停止」）；为同时在计划确认页与施工中页实现「可展开查看被挡住的完整位置清单」而不破坏 `RunView` 单按钮安全约束，清单统一采用原生 `<details><summary>` 折叠（从 `sensitiveFallbackList('~')` 动态生成 16 个路径，分两列紧凑排版）。
4. **验收页不显示电脑/手机端视口切换假按钮**：
   - 原型 `#07-accept` 成果预览右上角有「电脑 / 手机」标签示例；本版遵循第 9 节，继续沿用已有真实「在浏览器中打开预览 / 在访达中显示」按钮与核心层代码块 diff 预览，不放未接入真实内嵌视口的切换占位。
5. **标准模式简要说明与细则避免连续重复**：
   - `COPY.extraDirReadableNote` 按要求原字不改地采用新版说明（`「AI 可以读取你电脑上的大部分文件。只有常见的密钥和账号凭证位置被挡住（例如 .ssh、云服务凭证）…」`）；为避免右栏紧挨着的单选副标题 `COPY.standardDesc` 与之整段文字一字不差地重复出现两遍，`standardDesc` 保留核心语义并引导至「读取范围与受保护位置见下方说明」。

---

## 6. 阶段 4 截图清单（`docs/screenshots/stage4/`）

| 序号 | 文件名 | 原型锚点 | 说明 |
|---|---|---|---|
| 1 | `01-accept-incomplete.png` | `#07-accept` | 验收未完成（尚有未确认标准、构建通过/测试未通过、各行带查看依据、「验收通过并保存」置灰并提示原因） |
| 2 | `02-accept-failed.png` | `#07-accept` | 验收未通过（第 2 条选「不符合」并保存说明、顶部提示验收未通过、隐藏保存按钮、主按钮切换为「退回修改」） |
| 3 | `03-proof-tests.png` | `#08-evidence` | 检查依据页（自动测试标签页：第 1 轮成果、运行时间、沙箱环境、「由本应用运行，不是 AI 自报」、逐条测试结果与默认折叠的「详细记录」） |
| 4 | `04-proof-details-expanded.png` | `#08-evidence` | 检查依据页展开「详细记录」：可见脱敏提示、命令行与环境变量替换为 `[命令行已隐去]` / `[环境变量已隐去]`、隐藏敏感 key 与绝对路径 |
| 5 | `05-rework.png` | `#09-rework` | 退回修改页：反馈输入框、自动附上的不符合验收标准及说明、沿用上一轮权限与「修改」、执行者 `Codex · fake`、主按钮「开始第 2 轮」 |
| 6 | `06-accept-round2-switcher.png` | `#07-accept` | 第 2 轮验收页：顶部显示「第 2 轮」标签、反馈摘要、右上「第 1 轮 / 第 2 轮（当前）」切换器及全部通过的检查结果 |
| 7 | `07-accept-passed.png` | `#07-accept` | 验收通过（全部标准已确认「符合」、顶部绿色「验收通过」、主按钮恢复为实心绿色「验收通过并保存」） |
| 8 | `08-read-access-wording.png` | `#04-plan` | 新的标准模式读取权限说明与展开的 `sensitiveFallbackList('~')` 16 处受保护敏感位置清单 |

---

## 7. 验证结果、过程中失败及修复记录、CI 链接

### 本地最终验证结果（全部在最后一次代码改动后实测通过）
- `npm run typecheck`：退出码 `0`（零错误）
- `npm run build`：`build:core` 与 `build:renderer` 全部构建通过
- 全量单元测试（`npx vitest run --maxWorkers=4`）：**29 个文件通过，11 个真机/联网集成测试文件按环境未启用条件跳过（共 40 个文件）；568 个用例通过，37 个集成用例跳过，0 失败**（耗时 80.24s；其中阶段 4 新增 [`tests/stage4-review.test.ts`](../../tests/stage4-review.test.ts) 9 个用例、`tests/security.test.ts` 49 个用例全部通过）
- 全量 Electron E2E 测试（`E2E_STAGE4_SHOT_DIR=docs/screenshots/stage4 npm run test:e2e`）：**40 / 40 全部通过**（耗时 147.97s，含阶段 4 完整多轮验收/证据脱敏/退回修改/保存闭环测试并生成全部 8 张截图）
- 冒烟测试（`npm run smoke`）：全部 PASS，退出码 `0`

### 过程中遇到的失败及修复
1. `TaskPage.tsx` 新增 `第 N 轮` 角标后初跑 `typecheck` 报 `TS2304: Cannot find name 'COPY'`：漏写 `import { COPY } from './copy.js'`，补全导入后通过。
2. `tests/stage4-review.test.ts` 构造测试样本时错写 `source: 'ai'` 触发 TS 类型错误：按 `TimelineEntry` 接口约定省略 `source`（仅宿主消息标记 `source: 'host'`）后通过。
3. `tests/stage4-review.test.ts` 第 3 节多轮测试初跑失败（第 2 轮检查预期 `'passed'` 实得 `'failed'`）：原因是 `TaskController` 缓存单个 `FakeExecutor` 实例，原先按 `callIdx++` / 静态数组构造导致第 2 轮执行仍重放第 1 轮步骤；改为 `new FakeExecutor((prompt) => ...)` 按传入 `prompt` 判断是否包含「上一次结果需要修改」后，真实完成第 1 轮写入 `round1` 失败 → 第 2 轮写入 `round2` 通过。
4. 阶段 4 E2E 初跑两次分别超时等待 `[data-testid="criteria-save"]` 与 `[data-testid="proof-back"]`：`planned` 态标准变更随 `start-button` 一并保存（仅 `approved` 态独立出现 `save-criteria-button`），而检查依据返回按钮实际 `data-testid` 为 `proof-back-button`；修正选择器后 E2E 通过。
5. 初版截图视觉审阅发现 `02-accept-failed.png` 在点击「保存说明」后因仅等待 `data-status === 'failed'`（此前点「不符合」时已为该状态），截到了 `pending-feedback` 尚未结束的瞬间，且 `08-read-access-wording.png` 的敏感路径列表单列过长被视口裁切。修正等待条件为 `!pending-feedback && !save-note-c1`、调整 `standardDesc` 避免文字重复制并把敏感清单改为紧凑两列栅格后，重跑全部 40 个 E2E 并复核 8 张截图确认无误。

### GitHub Actions CI（`rebuild` 分支）
- 验证运行（`6d75baf`，含全部 4 个代码/测试提交与 8 张截图）：[https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42819126740](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42819126740)
  - `test (macos-latest)`：`success`（[job 129839794691](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42819126740/job/129839794691)，含 `typecheck`、`npm test`、`build` 与 macOS 全部 Electron E2E）
  - `test (ubuntu-latest)`：`success`（[job 129839795080](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42819126740/job/129839795080)，含 `typecheck`、`npm test`、`build`）

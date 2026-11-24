# AISS-A1-TRUSTED-EVIDENCE-R1-001：独立复核问题逐项修复报告

- **任务**：AISS-A1-TRUSTED-EVIDENCE-R1-001（PR #7 的 R1 修订，保留 A1 有效实现，不重建架构）
- **旧候选（复核未通过）**：`6918ea590f14935c4f164185a5702c51ee9bf8c0`
- **主干基线**：`e69ca8511a17acfc4427954af13ef6d364ffb553`
- **新候选**：见本报告所在提交的 `git log -1` / PR #7 exact HEAD（最终门禁一节记录）
- **审查状态**：`CHANGES_REQUIRED` 逐项修复 → 提交独立复核（`AISS_A1_R1_READY_FOR_INDEPENDENT_REVIEW`）
- **禁止事项遵守**：未合并、未启动 A2、未接入 Reviewer Agent、未进入新手建站模式；未删除测试、未降低断言、未伪造证据、未扩大沙箱权限（TMPDIR 采用不扩大权限的替代方案）。

本报告按 ChatGPT 独立复核提出的问题**逐项**对应，不把不同问题合并成一个笼统 PASS。每项都包含：缺陷、修复、回归测试、同一探针在旧候选/新候选上的结果。

---

## 0. 结论表

| 复核问题 | 结论 | 关键证据 |
| :-- | :-- | :-- |
| §2 Git 数据完整性（已跟踪 `node_modules` 文件删除被隐藏） | **已修复** | 探针 A：旧候选 fail / 新候选 pass；`tests/r1-git-integrity.test.ts`（真实 Git：验收/试合并/保存/撤销） |
| R1-01 失败优先（真实失败不得降级为可人工放行的 unverified） | **已修复** | 探针 B；`tests/r1-trusted-evidence.test.ts` R1-01 组（报告缺失/损坏/复用 + 非零退出） |
| R1-02 测试覆盖削弱（单文件下降被抵消、内容变化被忽视、只跑部分测试） | **已修复** | 探针 C；R1-02 组 4 项（逐文件断言下降、同数量改写、辅助文件、执行范围） |
| R1-03 证据身份与统一裁决 | **已修复** | 探针 D；R1-03 组 3 项（两个真实项目跨项目拒绝、统一入口一致、旧记录不升级） |
| R1-04 范围重新确认闭环 | **已修复** | `tests/a1-evidence-chain.test.ts` R1-04 两组（完整流程 + 确认前内容变化 + 试合并范围失效硬阻断） |
| R1-05 证据恢复与完整性 | **已修复** | 探针 E；R1-05 组 5 项（build 误判、配置对称、交叉核对如实、路径逃逸、ANSI） |
| §4 真实项目 TMPDIR 兼容 | **已解决（不扩大权限）** | 标准模式 Seatbelt 沙箱内完整真实项目（749 项）build+test+保存+撤销验证 |
| §5 远程证据缺失（`*.log` 被 gitignore） | **已修复** | 证据改为 `.txt` 并附可执行复现脚本；推送后从远程逐文件读回校验 |
| §7 全部门禁 | 见 §8 | typecheck / 全量 / R1 矩阵 / E2E / 真实 Git 保存撤销 / 标准沙箱 / 双平台 CI / 远程证据 |

---

## 1. 第一优先级：Git 数据完整性（§2）

### 1.1 缺陷（旧候选 `6918ea5` 实测）

旧实现的「目录名过滤」会在内容冻结与改动清单里**无条件剔除** `.studio` 与 `node_modules` 目录下的路径，包括**项目已跟踪**的文件：

- 基线跟踪 `node_modules/fixture.js`；
- 执行体删除该文件；
- 内容 tree 与改动清单都“看不见”这个删除 → 保存后主项目仍保留该文件、试合并/撤销语义被破坏。

同一探针在旧候选上复现失败：

```
FAIL tests/probes/r1-probe.test.ts > R1 探针 A：已跟踪 node_modules 文件的删除不得被隐藏
PROBE_EXIT=1（8 failed / 1 passed）
```

日志：`probes/r1-pre-fix-old-candidate.txt`（仓库内证据包）。

### 1.2 修复

- 内容树构造：从 `HEAD` 读入临时索引 → `add -A` → **只剔除「位于内部目录下且未被 HEAD 跟踪」的条目**（`git ls-tree HEAD` 差集 + `git update-index --force-remove -z --stdin`）→ `write-tree`。已跟踪文件的修改与删除一律保留。
- 改动清单：改用**同一个内容 tree** 与基线做 `git diff-tree`（不再对工作树索引做 `add --intent-to-add`），因此：
  - 已跟踪文件的修改/删除完整展示；
  - 未跟踪的内部缓存（如 `node_modules/.vite`）不进入验收内容；
  - **不写工作树自己的索引**，不污染用户 Git 索引（测试对比 `git status` + `ls-files -s` 前后完全一致）。
- 保存后核对：合并结果中「任务改动过的路径」必须与冻结验收内容逐字节一致，否则恢复到保存前并返回 `failed_restored`（不静默保留与验收不一致的结果）。

### 1.3 回归测试（真实 Git 仓库）

`tests/r1-git-integrity.test.ts`：

1. 已跟踪 `node_modules/fixture.js` 的修改与删除进入内容 tree 与改动清单；未跟踪 `.vite`/`.studio` 缓存被排除；
2. `computeTree`/`diffSummary`/`diffTreePaths` 前后，工作树与主项目的 `git status`、`ls-files -s` 完全不变（不污染索引）；
3. **验收 → 保存 → 撤销**：已跟踪内部文件删除在验收清单可见、保存后真实生效、撤销后文件树与保存前严格一致（tree 相等且文件被恢复）；
4. **试合并**：试用合并工作树使用同一内容定义，已跟踪内部文件删除可见、未跟踪缓存不改变 tree。

同一探针在新候选上：`PROBE_EXIT=0（9 passed）`，日志 `probes/r1-post-fix-new-candidate.txt`。

---

## 2. R1-01 失败优先：真实失败不得降级

### 2.1 缺陷

旧候选对结构化测试路径先处理“报告缺失/损坏/复用/零测试/全跳过”，再判断进程退出状态；因此**真实非零退出 + 报告缺失/被删除**会得到 `unverified`（可被“仍要保存”人工确认），而不是 `failed`。

### 2.2 修复

- 自动测试裁决前先做**进程失败判定**：`timedOut` / 非 `exited`（信号、异常终止、启动失败）/ 退出码非 0 → 一律 `failed`，优先于任何报告状态；报告存在时仍作为证据附件记录。
- 真实失败在保存门禁中不可被 `saveUncheckedTask` 绕过（`failed` 永远走 `checks_failed` 分支，人工确认路径只对“未执行/无证据”开放）。
- 零测试、全部 skip、全部 todo 且退出 0 → `unverified`（非 PASS），并带结构化原因。

### 2.3 回归测试

`tests/r1-trusted-evidence.test.ts` R1-01 组：

- 真实 Vitest 断言失败 + 报告被删除 / 被写坏 / 被替换为旧时间戳报告 → 三种组合均为 `failed`（探针 B 对应“报告缺失”场景，旧候选 fail / 新候选 pass）；
- 零测试 / 全部 skip + 强制非零退出 → `failed`；
- 退出 0 的零测试 / 全跳过 → `unverified`（原因分别 `tests_not_executed` / `all_tests_skipped`）；
- `failed` 证据经统一裁决入口仍为 `failed`，不因人工确认路径变 `verified`。

---

## 3. R1-02 保守范围复核

### 3.1 缺陷

1. 旧实现只在**合计**层面判断测试块/断言是否减少：A 文件断言 -1、B 文件断言 +5 → 总数增加 → 判 `assessed_unchanged`；
2. 只比较数量与测试名，**已存在测试文件内容被改写**（例如把断言改成恒真）但数量/名称不变 → 仍 `assessed_unchanged`；
3. 辅助文件（helpers/fixtures）与“实际执行范围”未参与判定：脚本只跑 `tests/one.test.ts`（另一文件未执行）时仍可能取得可信 PASS。

### 3.2 修复

- **逐文件**比较：任一文件的测试块或断言减少、测试名删除、skip/todo 增加、出现 `.only` → `assessed_weakened`（`delta.perFileAssertionDrops` 记录明细，不能被其它文件新增抵消）。
- **内容变化保守复核**：已存在测试文件 `sha256` 变化 → `assessed_needs_review`；辅助文件（测试目录下非用例文件）新增/修改/删除 → `assessed_needs_review`；配置/运行器/锁文件/脚本变化 → `assessed_needs_review`。
- **实际执行范围**：结构化报告中的 `executedFiles` 必须覆盖当前清单的全部测试文件；缺失 → `assessed_needs_review`（记录缺失文件），防止只跑部分测试取得 PASS。
- `assessed_unchanged` 只在「清单/配置/运行器/锁文件/脚本均未变化、执行范围完整」时出现；其余一律待确认。
- **不宣称静态分析能证明测试语义未削弱**：范围评估记录 `method: conservative-static` 与“静态分析无法证明语义未削弱”的说明；无法证明安全的修改进入 `scopeReview` 待确认流程。

### 3.3 回归测试

R1-02 组 4 项 + 探针 C：

- 单文件断言减少 + 另一文件新增（总数不降）→ `assessed_weakened`，且 drops 明细正确（旧候选 fail / 新候选 pass）；
- 同名称同数量但断言内容改写 → `assessed_needs_review`（旧候选 fail / 新候选 pass）；
- 辅助文件变化 → `assessed_needs_review`；
- 脚本带过滤只执行一个文件 → `unverified` + `executedFiles` 仅 1 个 + 执行范围缺失记录。

---

## 4. R1-03 证据身份与统一裁决

### 4.1 缺陷

- 身份校验只比较任务/轮次/验收版本/被测内容，**未校验项目根身份、任务副本身份、证据类型**；两个独立项目可以互换证据。
- 验收卡（card）、证据页（proof）、保存门禁（save-rules/runner）、反馈包（task-view）各自解释 `passed`，可能不一致；保存核心门禁未主动调用身份校验，依赖 UI 阻断。

### 4.2 修复

- 新增统一裁决入口 `src/core/evidence/adjudicate.ts`：
  - `adjudicateEvidence` / `adjudicateStoredProof` / `adjudicateCheckResult` / `adjudicateTaskEvidence` / `adjudicateRoundChecks`；
  - 裁决顺序：无证据（历史未核实）→ 类型/任务/轮次/验收版本/内容/项目根/工作树身份 → 深度失效 → 自标失效 → 范围确认 → 真实失败/未执行/结构性证据 → 通过；
  - 项目根与任务副本用**统一 realpath 哈希**（`pathIdentityHash`）比较，采集与复核同算法。
- 验收卡、证据页、保存门禁、历史轮次、ChatGPT 反馈包事实全部改为消费该入口；`view.ts` 不再自行解释状态，`card.ts` 不再自行判断 `passed`。
- 保存核心门禁 `TaskRunner.evidenceSaveGate()` 主动裁决：证据失效 / 范围未确认 / 真实失败一律拦截（`previewSave` 与 `doSave` 都调用，不依赖 UI）。
- 历史轮次按 `adjudicateRoundChecks`（只按“当时是否有结构化证据”）展示；旧记录无证据 → `历史记录未核实`，旧卡片 `verified` 不升级为可信 PASS。

### 4.3 回归测试

R1-03 组 + 探针 D：

- **两个真实独立项目、相同任务 ID、相同内容 tree**：证据在 A 上下文 `verified`，在 B 上下文 `invalidated`；证据类型错配 `invalidated`；工作树不符 `invalidated`（旧候选对项目根不拒绝 → 探针 fail / 新候选 pass）；
- **统一入口一致**：同一任务记录（证据来自 A、记录属于 B）→ 验收卡 test `invalidated`、证据页 `invalidated`、保存门禁含 `evidence_invalid`、反馈包事实 `unchecked` 且说明“失效”；
- 旧记录：`saveChecksText` 无证据 id → `检查通过（历史记录未核实）`；`adjudicateStoredProof` 无证据 → `unverified/legacy_unverified`。

---

## 5. R1-04 测试范围重新确认闭环

### 5.1 缺陷

旧实现写入 `scopeReconfirmed` 后**保存链路不消费**；确认不绑定用户实际查看的内容；确认后旧验收决定未清空；试合并范围校验缺失。

### 5.2 修复

- `Task.scopeReview = { kind, reasons, scopeFingerprint, contentFingerprint, acceptanceVersion, detectedAt, confirmedAt? }`：
  - `scopeFingerprint` = 测试清单 + 配置 + 运行器指纹；`contentFingerprint` = 检测时冻结内容 tree；`acceptanceVersion` = 检测时版本。
- `confirmScopeChange(id, version)`：
  1. 版本必须一致；
  2. 重新计算当前内容 tree，必须等于 `acceptedTree` 且等于确认绑定的 `contentFingerprint`（**确认前内容变化 → 拒绝旧确认**）；
  3. 重新计算当前范围指纹，必须等于 `scopeFingerprint`（**确认前范围变化 → 拒绝**）；
  4. **清空旧验收决定**（criteria 决定/说明、预览、整体确认、被拒操作确认、未检查确认、上次保存/试检查记录）；
  5. 按当前范围重新生成证据（`acceptCurrentScope` 仅由该用户动作传入），绑定**新验收版本 + 新内容指纹 + 已核对范围指纹**。
- 保存/试合并消费确认：
  - `evidenceSaveGate` 中 `needsScopeConfirm`（未确认或确认绑定失效）→ 硬阻断保存；
  - 试检查传入 `expectedScopeFingerprint`：合并后的范围指纹必须等于已确认范围，否则 `unverified/test_scope_changed` 并**硬阻断**（不能用“仍要保存”绕过）；没有确认时仍然对原始基线做范围校验（不无条件跳过）。
- 保存成功后清理 `scopeReview`。

### 5.3 回归测试（真实任务完整流程）

`tests/a1-evidence-chain.test.ts`：

1. **范围变化 → 用户确认 → 重新检查 → 用户验收 → 试合并 → 正式保存**：执行体删除已有测试 → 自动通过阻断 + 保存被核心门禁拒绝 → `confirmScopeChange` 成功（内容/范围/版本绑定、旧验收决定清空）→ 重新确认验收 → 保存成功 `checked=true`，保存后 `scopeReview` 清除；
2. **确认前内容变化**：检测后、确认前改写任务副本文件 → 确认被拒绝（`内容或测试范围又发生了变化…`）；
3. **保存前试合并范围失效**：确认后主项目新增测试文件 → 试合并范围指纹不一致 → 保存硬阻断（`saveUncheckedTask` 同样失败）。

卡片在确认后必须显示 `verified` 并继续走完保存链路（测试不以“卡片 verified”结束）。

---

## 6. R1-05 证据恢复与完整性

| 缺陷 | 修复 | 测试 |
| :-- | :-- | :-- |
| build 证据与测试运行器身份错误比较 → 重启复核误判失效 | `configFingerprintProblems` 只对 `ev.kind==='test'` 比较运行器入口/依赖；build 只比较脚本/配置/锁文件 | R1-05「build 证据不因运行器身份误判」（探针 E 对应项：旧候选 fail / 新候选 pass） |
| 配置文件只检测修改/删除，漏掉新增 | 对称比较：修改、删除、新增都报告 | R1-05「配置变化对称检测」 |
| 实际运行器入口/报告器/关联依赖未纳入完整性 | 指纹新增 `runnerEntry{pathHash,sha256}`（`vitest.mjs`）与 `deps`（vite / @vitest/runner 的版本+package.json 摘要），重启复核与试检查都校验 | 同上 + 保存链路 |
| 报告采集把未发生的校验当成功 | `readVitestReport` 逐项记录 `checks`（普通文件/非符号链接/无硬链接/大小/运行窗口/startTime 窗口/计数自洽/success 自洽/testResults 数组）；`buildReportEvidence` 如实设置 `producedDuringRun`/`startTimeWithinRun`，交叉核对记录 `performed/agrees` 与 `integrity.checks`；**stdout 摘要不可解析 → performed=false 且 integrity.ok=false**；ANSI 颜色先剥离再解析 | R1-05「交叉核对未发生必须如实标为未通过」+「ANSI」 |
| 报告目录父路径符号链接/路径逃逸/清理边界 | 报告路径必须是 `<worktree realpath>/.studio/evidence/<nonce>/vitest-report.json` 的真实路径；目录非符号链接；文件路径逃逸 → invalid；清理只删本次 nonce 目录 | R1-05「报告目录逃逸/符号链接」+「清理边界」 |
| 旧证据/无法核实的历史证据被卡片/反馈包/保存记录重新变成可信 PASS | 统一裁决入口对无证据记录返回 `legacy_unverified`；反馈包事实来自裁决；保存记录新增 `evidenceIds`，无结构化证据的历史保存记录显示“检查通过（历史记录未核实）”，不再显示可信“检查通过” | R1-03 旧记录组；探针 F（旧候选 fail / 新候选 pass） |

---

## 7. 标准模式受限沙箱内完整真实项目检查与保存（§4 TMPDIR）

### 7.1 问题

旧候选/旧设计把检查进程的 `TMPDIR` 放在工作树内 `.studio/tmp`（沙箱只允许写工作树）。这会让依赖“临时目录在仓库之外”的项目测试在自检时失败（例如本仓库 `tests/git.test.ts` 的 `isRepo(tmpDir())`）。A1 的真实项目验证曾用宿主运行器替代产品路径——**R1 不再接受这种验证方式**。

### 7.2 不扩大权限的替代方案

检查进程额外设置 `GIT_CEILING_DIRECTORIES=<worktree>/.studio`：从工作树根或更浅位置仍能找到 `.git`；从 `.studio/tmp` 向上探测时停止，不会把临时目录误认为项目仓库。**没有扩大沙箱写权限、没有修改沙箱策略**。

### 7.3 验证

`docs/reviews/AISS-A1-TRUSTED-EVIDENCE-R1-001/repro/real-project-sandbox-verify.mjs`：把本仓库完整副本（真实 `npm run build` + 真实 `npm test` 749 项）交给**产品自带的独立 Seatbelt 沙箱运行器**执行验收与试检查，然后真实保存并撤销，断言：

- `evidence.run.env === 'sandbox'` 且 `sandboxKind === 'seatbelt'`（**不是宿主运行器**）；
- 结构化报告真实通过数量、完整性/交叉核对通过；
- 保存 `checked=true`；撤销后 `HEAD^{tree}` 与保存前**严格相等**、标记文件被移除。

运行结果见 `probes/r1-standard-sandbox-full-project.txt`（仓库内证据包）与本地完整日志。

---

## 8. 最终门禁

| 门禁 | 命令 | 结果 |
| :-- | :-- | :-- |
| TypeScript | `npm run typecheck` | **通过（exit 0，0 错误）** |
| 全量单元+集成 | `npm test` | **772 tests / 734 passed / 0 failed / 38 skipped（exit 0）**（A1 749 项 + R1 新增 23 项） |
| A1 + R1 专项反向矩阵 | `npx vitest run tests/a1-trusted-evidence.test.ts tests/a1-evidence-chain.test.ts tests/r1-trusted-evidence.test.ts tests/r1-git-integrity.test.ts` | **57 passed / 0 failed（20+16+4+17）** |
| 修复前后对照探针（同一文件） | 旧候选 `6918ea5` / 新候选 | **旧候选：8 failed / 1 passed，exit 1；新候选：9 passed，exit 0**（同一探针 SHA-256 `bdcb7275…`） |
| 构建 | `npm run build` | **通过（core tsc + renderer vite build，exit 0）** |
| Electron E2E | `npx vitest run -c vitest.e2e.config.ts` | **56 passed / 0 failed（exit 0）**（真实 Electron 窗口；含真实标准沙箱 + 真实 Vitest 场景；日志 `probes/e2e-excerpt.txt`） |
| 真实 Git 保存与撤销 | R1 git 完整性测试 + 标准沙箱验证脚本 | **通过**：已跟踪 `node_modules/fixture.js` 删除在验收/保存/撤销全链路正确；撤销后文件树与保存前严格一致 |
| 标准模式沙箱完整项目 | `repro/real-project-sandbox-verify.mjs` | **通过**：产品自带独立 Seatbelt 沙箱运行真实项目 `tsc build` + Vitest 25 项，`runEnv=sandbox`/`sandboxKind=seatbelt`、报告完整性/交叉核对全 true、范围 `assessed_unchanged`、保存 `checked=true`、任务内容完整应用、撤销后 `HEAD^{tree}` 与保存前严格相等 |
| 远程证据完整性 | 推送后从 `raw.githubusercontent.com` 逐文件读回并与本地 SHA-256 比对 | **全部 OK**：R1 证据包 27 个文件逐字节一致 + A1 证据包此前缺失的 3 个文件（`pre-fix-baseline-probe.txt`、`post-fix-a1-probe.txt`、`real-project-verify.txt`）均 OK（详见 `probes/` 与 `gates.md`） |
| 原工作区 8 文件 / A0 工作树保护 | SHA-256 / HEAD / status / diff 哈希 | **8/8 SHA-256 与开工前完全一致**；原主工作区 HEAD `8dfcfc1…`、`git diff` 哈希 `8b80fb4c…`、暂存区空；A0 审计工作树 HEAD `a8561a9…` 未变；A0 远程交付分支 `a54fefb…` 未变（`workspace-protection-after.txt`） |
| 新 PR exact-HEAD 双平台 CI | GitHub Actions | **全绿**：代码提交 `6349f38a469ad88fac52c6742a3140a1153811f0` 的 run [45355056920](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/45355056920) —— Ubuntu job：typecheck + `npm test` **772 项 / 732 passed / 40 skipped / 0 failed**（Linux 按设计跳过 2 个 macOS 专属用例）+ `npm run build`；macOS job：**772 项 / 734 passed / 38 skipped / 0 failed** + Electron E2E **56 passed**。本报告的最终更新提交为 docs-only，其 exact-HEAD CI 结果见 [PR checks](https://github.com/luckyjamesriver/ai-solo-studio/pull/7/checks) |

---

## 9. 已知限制与 OPEN（不虚构）

1. 第一阶段只完整支持 Vitest 结构化证据；其他框架只记录命令结果并显示“未核实”。
2. 静态分析无法绝对证明测试语义未削弱：本阶段采用「保守启发式 + 用户显式确认 + 试合并复核」，并如实声明，不宣称形式化证明。
3. 完全信任模式下执行体可修改运行器；信任边界与完整性检查见 A1 报告 §7。
4. A0 的 OPEN 项继续按 OPEN 登记（真实服务集成测试按设计跳过等）。
5. A2–A6 未实现、未预登记。

---

## 10. 独立复核指引

```bash
git fetch origin && git worktree add /tmp/r1-review feat/aiss-a1-trusted-evidence-001
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm ci && npm run typecheck && npm test && npm run build
npx vitest run tests/r1-git-integrity.test.ts tests/r1-trusted-evidence.test.ts tests/a1-trusted-evidence.test.ts tests/a1-evidence-chain.test.ts
npx vitest run -c vitest.e2e.config.ts           # 需要真实显示环境（macOS）
node docs/reviews/AISS-A1-TRUSTED-EVIDENCE-R1-001/repro/real-project-sandbox-verify.mjs   # 需先 npm run build:core
# 修复前后对照：同一探针
cp docs/reviews/AISS-A1-TRUSTED-EVIDENCE-R1-001/repro/r1-probe.probe.ts.txt <checkout>/tests/probes/
npx vitest run tests/probes/r1-probe.test.ts    # 旧候选 → 8 failed / exit 1；新候选 → 9 passed / exit 0
```

`AISS_A1_R1_READY_FOR_INDEPENDENT_REVIEW`

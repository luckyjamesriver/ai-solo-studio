# AISS-A1-TRUSTED-EVIDENCE-001：可信宿主证据修复与验收报告

- **任务**：AISS-A1-TRUSTED-EVIDENCE-001（自主反馈闭环 A1 阶段：可信证据与防作弊门禁）
- **仓库 / 目标分支**：`luckyjamesriver/ai-solo-studio` / `rebuild`
- **交付方式**：独立产品 PR（基于独立工作树），不合并审计原型、不启动 A2
- **基线与核验**：`origin/rebuild` = `e69ca8511a17acfc4427954af13ef6d364ffb553`（与独立核验基线一致）
- **本报告生成时间**：2026-11-24（Asia/Singapore）
- **状态声明**：`AISS_A1_TRUSTED_EVIDENCE_READY_FOR_INDEPENDENT_REVIEW`

---

## 0. 结论摘要

| 项目 | 结论 |
| :-- | :-- |
| P0-1 命令成功被误判为测试成功 | **已修复**：`test` 只有取得结构化测试证据才是 `passed`；echo/零测试/全跳过/伪造摘要/吞掉失败退出码全部非 PASS |
| P0-2 虚构测试通过数量 | **已修复**：解析不出数量时 `counts=null`，界面显示“测试数量未知（未取得有效测试证据）”；历史兼容路径不再显示“1 项通过” |
| P0-3 验收卡与证据状态混淆 | **已修复**：区分 `verified`/`failed`/`not_checked`/`unverified`/`invalidated`/`user_confirmed`；人工确认不转成自动通过 |
| 统一证据模型 | **已建立**：`src/core/evidence/`（身份、运行、配置指纹、结构化报告、范围评估、有效性与失效原因），复用既有 TaskRunner/PersistenceService 链路 |
| 可信测试证据采集 | **已建立**（完整支持 Vitest）：宿主注入 JSON 报告器 + 随机路径 + 窗口校验 + 计数自洽 + stdout 交叉核对 |
| 防操纵门禁 | **已建立**：删除测试/减少断言/加 skip·only/改配置·运行器·锁文件 → 自动通过被阻断，需用户显式重新确认；伪造/复用报告 → 非 PASS |
| 全链路接入 | **7 条路径全部统一语义**（见 §5） |
| 反向测试矩阵 | **34 项新增专项测试 + 全部既有回归**（真实进程/真实 Vitest），修复前/后对照探针可复现 |
| 工程文档修正 | webBridge 真实能力、虚构组件与函数签名、CRG 三段式登记、代码地图增量更新 |
| 门禁 | typecheck / 全量单测+集成 / 反向矩阵 / Electron E2E / 真实项目工作树执行 / 旧记录兼容 / 8 文件保护 / Ubuntu+macOS CI（exact HEAD）见 §11 |

**核心不变量**：AI 可以报告成功，但验收结论只由真实、有效、与当前任务版本绑定的宿主证据决定；无法取得证据时显示“未取得有效证据/测试数量未知”，绝不显示为通过。

---

## 1. 基线与工作区保护

### 1.1 基线核验

| 项 | 值 |
| :-- | :-- |
| 仓库 | `https://github.com/luckyjamesriver/ai-solo-studio.git` |
| 目标分支 | `rebuild` |
| 独立核验基线 | `e69ca8511a17acfc4427954af13ef6d364ffb553` |
| 实际最新 `origin/rebuild`（开工时 `git fetch` 后） | `e69ca8511a17acfc4427954af13ef6d364ffb553`（一致） |
| A1 工作树 | `/Users/jamesho/ai-solo-studio-a1`（`git worktree add -b feat/aiss-a1-trusted-evidence-001 ... e69ca85`） |
| A1 工作树 HEAD（开工） | `e69ca8511a17acfc4427954af13ef6d364ffb553`，工作区干净 |

### 1.2 原主工作区 8 个在研文件保护（开工/收工 SHA-256 一致）

原主工作区 `/Users/jamesho/ai-solo-studio-rebuild`（HEAD `8dfcfc19daf9ba890142be0075f9e869b6353731`）在开工前记录、收工后再次核验，**8/8 文件 SHA-256 完全一致，Git HEAD、暂存区、未暂存差异哈希均未变化**：

| 序号 | 文件 | SHA-256 | 状态 |
| :-- | :-- | :-- | :-- |
| 1 | `e2e/shell.e2e.ts` | `1059d524c53412f1b3ad5f7bde13c4b70e31ee7b026d684bb10426d3ad5aa93a` | M |
| 2 | `src/core/app/task-controller.ts` | `40873cc12089ef94db563824b60135a56425c91ea6a4b42bc7e43ff990118881` | M |
| 3 | `src/core/thinking/index.ts` | `cd4b5dd264b069bf558571916367e068f036496dc86da3c35466be5e43e9ecb5` | M |
| 4 | `src/renderer/App.tsx` | `0127d93ce23138b099b3d66771d85666c257548e9186155799649385f33b9c30` | M |
| 5 | `src/renderer/SettingsPage.tsx` | `c0ee540629549ef39fc87f6b07778aa4350955746f86e13b13d5e55821a70765` | M |
| 6 | `src/core/app/autonomous-feedback-loop.ts` | `d5067b3fe176984f0115751f9fa5690d02b4dc121119bfb82981b83439424428` | ?? |
| 7 | `src/core/thinking/chatgpt-devkit.ts` | `49f3cfce392320c4b399e05bddec19695f7d4bc78fa17acdc6f2471efdf49f35` | ?? |
| 8 | `tests/autonomous-feedback-loop.test.ts` | `caad1b563d77eac30fa4af96165bfc767c837fc2954d622b0cef0f75dc94eae3` | ?? |

- 原始快照：`/Users/jamesho/a1-evidence/BASELINE-ORIGINAL-WORKSPACE.txt`（含 `git status --porcelain`、`git diff | sha256=8b80fb4c…`、`git diff --cached | sha256=e3b0c442…`）
- 原审计工作树 `/Users/jamesho/ai-solo-studio-audit`（HEAD `a8561a9b…`）全程只读，未修改、未覆盖、未退役。

### 1.3 A0 独立复核材料（远程可读）

A0 审计材料已整理为**只含文档/证据**的独立审计交付分支并推送（不与产品 PR 混合、不合入 `rebuild`）：

- **分支**：`audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001-delivery`
- **远程 HEAD（已验证）**：`a54fefbd152464a93ca3782faa130dd2582cdcf9`
- **内容**：审计报告、原型 8 文件差异及未跟踪源码、隔离集成补丁、反向审计探针、原始测试日志及退出码、677/94/9 三项测试的源码身份、文件指纹与审计环境清单、安全扫描记录、OPEN 登记。
- **本次复核**：`gh api …/branches/audit/…-delivery` 返回 `a54fefbd152464a93ca3782faa130dd2582cdcf9`（`protected: false`），匿名 raw 可读；与 A1 产品分支完全隔离。
- **隔离性**：相对 `e69ca85` 仅 `docs/reviews/**` 有新增文件；`src`/`tests`/`e2e`/`scripts`/`spikes`/`.github` 与根配置文件树哈希完全一致；未对 `rebuild` 推送、未开 PR。
- **A0 未完成项**：以 OPEN 登记（未伪造通过），例如 12 个真实服务集成测试按设计跳过、Electron E2E 未在 A0 执行、审计报告中“58 文件全部通过”表述不精确（677 通过 / 38 跳过）等。A0 的 OPEN 不阻塞 A1。

> A0 OPEN #9（报告 §6.1/6.2/6.3 治理声明未复核）已在本 PR 的工程文档修正中一并处理（见 §9）。

---

## 2. P0-1：命令成功被误判为测试成功（已修复）

### 2.1 缺陷（基线实测）

基线 `src/core/checks/scripts.ts` 的 `runCheck()` 用 `outcome.kind === 'exited' && outcome.code === 0` 判定 `passed`。修复前用**同一组断言**在基线 `e69ca85` 上运行对照探针，5/5 失败：

- 证据：`/Users/jamesho/a1-evidence/logs/pre-fix-baseline-probe.log`（`PROBE_EXIT=1`，`Test Files 1 failed`，`Tests 5 failed (5)`）

覆盖的失败场景：`test` 脚本只 `echo "Tests 5 passed"`、只打印伪造成功摘要、退出 0 但没有真实测试、零测试、全部跳过。

### 2.2 修复

`runCheck()` 对 `test` 分为两条路径：

1. **受支持的可信采集（Vitest）**：`package.json` 的 `test` 脚本是可安全追加参数的真实 Vitest 调用（无 `&&`/`||`/`;`/管道/重定向）时：
   - 宿主追加 `--reporter=default --reporter=json --outputFile.json=<worktree>/.studio/evidence/<nonce>/vitest-report.json`；
   - 运行前清空目录；运行后校验：普通文件、非符号/硬链接、大小合理、mtime 落在本次运行窗口、JSON 结构、计数自洽（`total = passed+failed+skipped+todo`、逐条 `assertionResults` 聚合一致）、`success` 与失败数一致、`startTime` 落在窗口内、与进程 stdout 摘要交叉核对；
   - **结论顺序（报告是权威事实）**：真实失败 > 报告完整性 > 零测试 > 全部跳过 > 非 0 退出 > 范围削弱 > `passed`。
2. **未适配的框架**：只记录命令执行结果——退出 0 → `unverified`（`unsupported_test_runner`/`no_structured_evidence`），退出非 0 → `failed`；绝不冒充测试用例证据。

`build` 保持“真实进程退出码 0 即成功”的正确语义，并同样记录宿主证据（运行身份、配置指纹、退出状态）。

### 2.3 验证

- 修复后同一对照探针在 A1 上 **5/5 通过**：`/Users/jamesho/a1-evidence/logs/post-fix-a1-probe.log`（`PROBE_EXIT=0`）
- 专项测试（真实进程 + 真实 Vitest）：`tests/a1-trusted-evidence.test.ts`
  - 真实全部通过 → 可信 PASS，数量来自结构化报告；
  - 真实断言失败 → FAIL；
  - `echo` 只输出成功摘要 → `unverified`；
  - 零测试（`passWithNoTests`）→ `unverified`/`tests_not_executed`；
  - 全部跳过 → `unverified`/`all_tests_skipped`；
  - 伪造终端成功摘要 → `unverified`；
  - 测试失败但外层脚本 `|| true` 吞掉退出码 → 非 PASS。

---

## 3. P0-2：虚构测试通过数量（已修复）

### 3.1 缺陷

- `parseTestCases()` 在解析不出数量时：`passedCount: summaryPassed ?? (checkStatus === 'passed' ? 1 : 0)` —— 按检查状态兜底生成“1 项通过”；
- `buildSingleCheckProof()` 的旧验收卡兼容路径直接写 `summaryText: '1 项通过 · 0 项失败'`。

### 3.2 修复

- `parseTestCases()` 只在 stdout 出现**显式数字摘要**时返回 `counts`，否则 `counts = null`；
- 数量来源优先级：`structured_report`（宿主结构化报告）> `stdout_summary`（显式数字）> `unknown`；
- `SingleCheckProof.counts: {passed,failed,skipped,total} | null`，删除 `passedCount`/`failedCount` 兜底；
- 界面（`CheckProofPage.tsx`）在 `counts === null` 时显示“**测试数量未知（未取得有效测试证据）**”；
- 历史兼容路径：只有旧验收卡条目、没有结构化证据时显示“**测试数量未知（历史记录未核实）**”，绝不显示“1 项通过”。

### 3.3 验证

- 修复前探针断言“解析不出数量时不得生成 1 项通过”在基线**失败**、在 A1 **通过**（同上两份日志）；
- `tests/a1-trusted-evidence.test.ts` / `tests/a1-evidence-chain.test.ts` 断言 `counts === null` 且文案不含 `N 项通过`；
- `tests/stage4-review.test.ts` 的解析用例改为断言 `counts` 精确值 / `null`。

---

## 4. P0-3：验收卡与证据状态混淆（已修复）

### 4.1 修复后的状态语义

`src/core/acceptance/card.ts`：

| 状态 | 含义 | 产生条件 |
| :-- | :-- | :-- |
| `verified` | 可信通过 | 构建：真实进程退出 0；测试：结构化报告证明真实执行且全部通过、完整性 ok、范围未削弱 |
| `failed` | 真实失败 | 真实进程失败 / 结构化报告存在失败用例 |
| `not_checked` | 未执行 | 无脚本 / 无受限环境 / 未授权 / 脚本变化需重新授权 |
| `unverified` | **缺乏有效证据** | 命令结束但无结构化测试证据、零测试、全跳过、报告缺失/损坏/复用/不自洽、范围削弱、未适配框架 |
| `invalidated` | **证据失效** | 检查期间源码变化、身份（任务/轮次/验收版本/被测内容）不一致、重启复核发现配置漂移 |
| `user_confirmed` | 用户明确确认 | 用户操作（确认验收标准 / 接受未检查风险 / 确认范围变化），**不转成自动检查通过** |

- `readyToSave` 在存在 `invalidated` 时为 false；`unverified` 不显示为通过，保存必须走既有的“明确接受未检查风险”确认流程并记录 `checked=false`。
- `computeAcceptanceStatus`：存在 `unverified` 时返回“验收未完成（不能算通过）”，绝不返回“验收通过”。
- 人工确认（`confirm()`）用**存储的宿主证据重建**验收卡，不再按卡片状态反向构造“自动通过”。

### 4.2 验证

- 修复前探针断言“没有结构化测试证据时 test 条目不得是 verified”在基线**失败**、A1 **通过**；
- `tests/acceptance.test.ts`、`tests/a1-*`、`tests/stage6-save-ui.test.ts`、`tests/security.test.ts` 均有对应断言。

---

## 5. 统一证据模型与全链路接入

### 5.1 模型（`src/core/evidence/`）

| 文件 | 内容 |
| :-- | :-- |
| `model.ts` | `HostCheckEvidence`：`identity`（项目哈希/任务/轮次/验收版本/被测 tree/副本哈希/evidenceId）、`run`（运行身份与真实退出）、`config`（脚本/锁文件/运行器/测试配置/测试清单指纹/报告器/采集器版本）、`report`（结构化报告 sha/字节/窗口/计数/失败名/完整性/交叉核对）、`scope`（相对基线提交的范围评估）、`valid` + `invalidReason` |
| `inventory.ts` | 测试清单扫描（逐文件 sha256/测试块/断言/skip/only/todo/测试名）、配置与锁文件指纹、运行器身份解析、`assessScopeChange()`、批准时基线采集 |
| `vitest.ts` | `prepareVitestRun()`（随机路径、清空）、`readVitestReport()`（严格校验）、`parseStdoutSummary()`、`buildReportEvidence()` |
| `validate.ts` | `evidenceIdentityProblem()`、`hasTrustedTestPass()`/`hasTrustedBuildPass()`、`configFingerprintProblems()` |

复用（未另建状态机/持久化）：`TaskRunner.buildEvidence()`、`runCheck()`/`runProjectChecks()`、`StoredCheckProof`、`acceptedTree`、`acceptanceRev`、`checkAuth`、历史轮次、`PersistenceService`/`RecordStore`。`StoredCheckProof` 扩展 `status: 'unverified'` 与 `evidence`；旧记录读取为历史未核实，不补造、不改写。

### 5.2 七条路径

1. **任务结束 `buildEvidence()`**：先算被测 tree → 构造身份 → 逐项 `runCheck`（带身份与基线提交）→ 检查后再算 tree（变化即作废）→ 写 `currentChecks`/`checks`、冻结 `acceptedTree`、生成验收卡；测试范围削弱写入 `scopeChange`。
2. **重新检查 `recheck()`**：清空全部确认、`acceptanceRev + 1`、重新采集证据；旧证据与旧“未检查确认”一律失效（`tests/a1-evidence-chain.test.ts` 覆盖）。
3. **保存前试合并 `runProjectChecks()`**：试合并 worktree 用同一枚举/同一证据语义；检查前后 tree 比对；与原验收证据不一致 → `acceptance_inconsistent` 阻断保存（实测覆盖）。
4. **验收卡与证据详情页**：新状态语义 + 证据事实（报告来源/完整性/范围核对/运行器身份）；无数量显示“数量未知”；证据失效时详情页与卡片一致显示“证据失效”。
5. **历史任务与历史轮次**：旧记录/旧轮次按“历史未核实”读取，数量未知；历史轮次不参与当前身份复核。
6. **ChatGPT 反馈包宿主事实**：`buildTaskView().result.facts` 使用同一状态语义（`unverified`/`invalidated` 显示“未取得可信证据/证据失效”），反馈包明确“不可视为已通过”，与 AI 自述分区。
7. **异常重启后的证据恢复**：`reconcileTasks()` 增加 `revalidateStoredEvidence()`：身份不一致或脚本/配置/运行器/锁文件在验收后变化 → `evidenceInvalid`（只记录事实，不改写历史轮次），界面显示“证据失效”并阻断保存；有效证据不被误判失效（`tests/a1-evidence-chain.test.ts` 覆盖）。

### 5.3 人工接受未检查风险（保留并收紧）

- 真实检查失败 → 保存直接 `checks_failed`，`saveUncheckedTask` 同样失败（不能被“未检查确认”绕过）；
- 未执行 / 缺乏证据 → 首次保存返回 `unchecked_needs_confirm`，需用户显式确认；保存记录 `checked=false`、`uncheckedKind=none|unavailable|unverified`、`uncheckedConfirmedAt`；
- 卡片在用户确认后仍是“缺乏有效证据/未检查”，绝不变成 PASS；
- 验收版本变化后旧确认自动失效（`uncheckedConfirm.version` 比对）；
- 自动反馈闭环不得调用确认（本阶段无自动确认路径；范围重新确认方法只由用户 IPC 触发）。

---

## 6. 防止验收规则被执行者操纵

| 场景 | 检测方式 | 结果 |
| :-- | :-- | :-- |
| 删除已有测试文件/测试用例 | 当前测试清单 vs **任务基线提交**清单（路径、测试名、测试块、断言数） | `assessed_weakened` → `unverified`/`test_scope_weakened`，自动通过被阻断 |
| 减少断言/测试块 | 同上（逐文件比较） | 同上 |
| 增加 `skip`/`todo`/`.only` | skip/only/todo 标记计数 + 报告 skipped 计数 | 同上 |
| 修改测试/构建脚本 | `scriptsDigest` vs 批准摘要 | 授权失效 → `not_available`（未检查） |
| 替换测试运行器 / 修改测试配置 / 改锁文件 | 运行器包身份 + 配置指纹 + 锁文件摘要 vs 基线 | `test_scope_weakened` → 需重新确认 |
| 伪造/复用旧报告 | 随机路径 + 运行前清空 + mtime/startTime 窗口 + 完整性/自洽校验 | `report_missing`/`report_reused`/`report_invalid` → 非 PASS |
| 吞掉失败退出码 | 结构化报告仍列出真实失败 | `failed` |
| 检查期间修改被测源码 | 检查前后内容 tree 比对 | 证据作废（`source_changed_during_check`） |
| 修改已经批准的验收标准 | 计划编辑清除 `checkAuth` 并要求重新批准（既有机制）；证据绑定当前验收版本 | 旧证据/旧确认失效 |

**合法新增与修订测试**：相对基线新增文件/测试块/断言、减少 skip → `assessed_stronger`，照常通过，不阻断。

**明确的重新确认流程**：`scopeChange` 存在时，验收页显示“测试范围变化需要你确认”面板（原因逐条列出）；用户点击后调用 `TaskController.confirmScopeChange(id, version)`（preload → IPC `acceptance:confirm-scope-change`）→ 以当前范围重新生成证据，确认绑定 `acceptanceVersion` 与范围指纹；验收版本或范围再变化即失效。该动作只能由用户主动触发。

---

## 7. 信任边界（如实声明）

宿主采集退出码与结构化报告**不等于绝对不可伪造的证据**。执行体可修改测试文件与配置，完全信任模式下甚至可修改运行器。本阶段的边界与缓解：

1. 报告由宿主注入的 CLI 报告器写入宿主生成的随机路径，运行前清空，运行后强制“本次产生”校验（拒绝复用/预置/符号链接/硬链接/空文件）；
2. 报告内部计数必须自洽，`success` 与失败数一致，并与 stdout 摘要交叉核对；
3. 检查脚本、锁文件、测试配置、运行器包、测试清单纳入指纹；批准后变化 → 授权/证据失效；
4. 运行前后两次内容 tree，运行期间变化即作废；
5. 标准模式下运行器位于主项目 `node_modules`，沙箱禁止执行体写入；完全信任模式在计划与风险确认中已如实告知；
6. `node_modules/` 与 `.studio/` 永不进入验收内容 tree 或改动清单（测试器会写 `node_modules/.vite` 等缓存），避免工具缓存被误判成“检查改动了文件”。

---

## 8. 反向测试矩阵（任务书第 9 节逐项对照）

| # | 场景 | 预期 | 覆盖测试 | 结果 |
| :-- | :-- | :-- | :-- | :-- |
| 1 | 真实测试全部通过 | 可信 PASS | `a1-trusted-evidence`「真实测试全部通过」 | PASS |
| 2 | 实际测试失败 | FAIL | 「实际测试失败」 | PASS |
| 3 | 退出码 0 但没有执行测试 | 非 PASS | 「退出码 0，但测试脚本只执行 echo」 | PASS |
| 4 | 零测试 / 全部跳过 | 非 PASS | 「零测试」「全部测试被跳过」 | PASS |
| 5 | 伪造终端成功摘要 | 非 PASS | 「输出伪造的测试成功摘要」 | PASS |
| 6 | 测试失败但脚本返回 0 | 非 PASS | 「吞掉失败退出码（\|\| true）」 | PASS |
| 7 | 缺失/损坏/重复使用报告 | 非 PASS | 「缺失 / 损坏 / 复用 / 计数矛盾」 | PASS |
| 8 | 使用其他项目的证据 | 拒绝 | 「证据身份：其他项目」 | PASS |
| 9 | 使用其他任务/轮次的证据 | 拒绝 | 「证据身份：其他任务/轮次」 | PASS |
| 10 | 使用旧工作树内容的证据 | 失效 | 「证据身份：被测内容不一致」+ A1 view 失效显示 | PASS |
| 11 | 检查期间修改源码 | 失效 | `buildEvidence` tree 前后比对；`b4-save`「检查改动了文件」 | PASS |
| 12 | 擅自削弱测试范围/验收规则 | 阻断自动通过 | 「删除已有测试」「增加 skip」「替换配置」+ 重新确认流程 | PASS |
| 13 | 沙箱不可用 | 明确未检查 | 既有 sandbox 不可用测试 + `runProjectChecks` 四态 | PASS |
| 14 | 无测试框架适配 | 明确未核实 | 「node --test → unverified」 | PASS |
| 15 | 历史记录缺乏结构化证据 | 不虚构数量 | 「历史任务与历史轮次」+ 修复前探针 | PASS |
| 16 | 用户确认未检查风险 | 仅记录人工确认 | 「缺乏可信测试证据时保存需确认」 | PASS |
| 17 | 真实测试失败后尝试确认未检查 | 仍然阻断 | 「试合并真实失败 → saveUncheckedTask 同样失败」 | PASS |
| 18 | 保存前试合并结果与原验收不一致 | 阻断保存/重新验收 | 「试合并结果与原验收不一致 → 阻断」 | PASS |

关键场景均使用**真实进程与真实 Vitest**，未以 Mock 替代“通过”结论。修复前失败证据与修复后通过证据见 §2.1/§2.3。

---

## 9. 工程文档修正

| 问题 | 修正 |
| :-- | :-- |
| webBridge 被描述为可“DOM 文本安全提取” | 如实登记：主窗口 `webviewTag: false`、`#chatgpt-webview` 不是真实 `<webview>`；独立伴侣 `BrowserWindow` 的 DOM **不可跨窗口读取**；实际交付路径是**人工导入/粘贴 + 诚实降级提示**；无剪贴板窃取 |
| 虚构组件 `ChatGPTPlanConfirmDialog` / `ChatGPTFeedbackModal` | 源码中不存在这两个组件（仅为 `ChatGPTView.tsx` / `TaskPage.tsx` 内联 JSX）；CODE_MAP 只登记真实导出符号 |
| `buildChatGPTFeedbackPacket({task, acceptanceView, envHealth, ...})` 签名错误 | 更正为 `buildChatGPTFeedbackPacket(task: TaskView, projectName?: string, options?: FeedbackReviewOptions): string`，并核对 `sanitizeFeedbackText` / `extractMarkdownCodeBlocks` 真实签名 |
| CRG 状态过度声明 `VALID` / `head_matches_build: true` | `CURRENT_BASELINE.md` 改为三段式：`build_sha = 9ce89e2…`、`source_equivalence: true`（`git diff --stat 9ce89e2..e69ca85` 仅 3 个文档文件）、`exact_head_match: false`；状态 `STALE_PENDING_SYNC`；本地索引实时复核登记为 **OPEN**（本工作树无索引库） |
| 代码地图未登记 A1 | `CODE_MAP.md` v1.7 增量登记 `src/core/evidence/*`、`checks/scripts.ts` 新语义、`acceptance/proof-status.ts`、A1 证据链路图；未登记 A2–A6 未实现能力 |

相关文件：`docs/engineering/CODE_MAP.md`、`docs/CURRENT_BASELINE.md`、`docs/engineering/INDEX_PILOT_EVALUATION.md`、`docs/reports/2026-11-stage9-webcodex-deepseek.md`、`docs/reports/2026-11-24-final-baseline-sync-evidence.md`、`docs/reports/2026-11-24-chatgpt-interaction-final-delta.md`。

---

## 10. 代码与测试变更规模

- 变更文件：39 个已跟踪文件 + 新增 9 个文件（`src/core/evidence/*` 4 个、`src/core/acceptance/proof-status.ts`、2 个 A1 专项测试、1 份设计文档、1 份本报告）。
- 新增专项测试：`tests/a1-trusted-evidence.test.ts`（20 项）、`tests/a1-evidence-chain.test.ts`（14 项），合计 34 项全部通过。
- 既有测试迁移：把依赖“退出码 0 = 测试通过”旧语义的夹具迁移为**真实 Vitest**（`tests/helpers.ts` 新增 `realVitestScript` / `useRealVitest`），或改为断言新语义；**未删除任何测试、未降低断言**（安全基线断言保持严格，仅按 A1 新增 API/模块登记扩充固定清单）。

---

## 11. 门禁结果

| 门禁 | 命令 | 结果 |
| :-- | :-- | :-- |
| TypeScript typecheck | `npm run typecheck` | **通过，0 错误** |
| 全量单元 + 集成测试 | `npm test` | **749 tests / 711 passed / 0 failed / 38 skipped（exit 0）**；基线为 715/677/0/38，新增 34 项 A1 专项测试；日志 `logs/full-suite-final.json` |
| 可信证据专项反向测试 | `npx vitest run tests/a1-trusted-evidence.test.ts tests/a1-evidence-chain.test.ts` | **34 passed / 0 failed（exit 0）** |
| 构建 | `npm run build` | **通过**（core tsc + renderer vite build） |
| Electron 原生 E2E | `npx vitest run -c vitest.e2e.config.ts` | **56 passed / 0 failed（exit 0）**，含真实独立 Seatbelt 沙箱 + 真实 Vitest 场景；日志 `/Users/jamesho/a1-evidence/logs/e2e-run2.log` |
| 真实项目工作树执行 | `/Users/jamesho/a1-evidence/real-project-verify.mjs` | **通过**：临时 clone 本仓库提交 `503179f` → 验收真实运行 `npm run build`（passed）+ `npm test`（结构化报告 749 项 / 711 通过 / 0 失败 / 38 跳过，integrity ok，range `assessed_unchanged`）→ 卡片 `build/test = verified` → 真实保存 `checked=true`，`mergeCommit=1b0c93c…`；日志 `logs/real-project-verify.log` |
| 旧任务记录兼容 | `tests/a1-evidence-chain.test.ts`「历史任务与历史轮次」+ 既有 persistence/legacy 测试 | **通过** |
| 保存前试检查 | `tests/a1-evidence-chain.test.ts` 保存三条 + `tests/save-safety.test.ts` | **通过** |
| 原工作区 8 文件保护 | SHA-256 / HEAD / status / diff 哈希 | **8/8 一致，未修改** |
| 独立产品 PR | `feat/aiss-a1-trusted-evidence-001` → `rebuild` | **PR #7**：https://github.com/luckyjamesriver/ai-solo-studio/pull/7 |
| CI（exact HEAD，Ubuntu + macOS） | GitHub Actions `CI` workflow（PR #7） | **全绿**：代码提交 `503179f8b1079b998352c0aac76d5469535592d7` 的运行 [45325957236](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/45325957236) —— Ubuntu job：typecheck + `npm test` **749 项 / 709 passed / 40 skipped / 0 failed**（Linux 按设计跳过 2 个 macOS 专属用例）+ `npm run build`；macOS job：**749 项 / 711 passed / 38 skipped / 0 failed** + Electron E2E **56 passed**。本报告的最终更新提交为 docs-only，其 exact-HEAD CI 结果见 [PR checks](https://github.com/luckyjamesriver/ai-solo-studio/pull/7/checks) |

修复前后对照证据：

| 证据 | 文件 |
| :-- | :-- |
| 基线 typecheck / 全量测试（修复前基线绿，证明缺陷由测试缺口而非构建失败掩盖） | `/Users/jamesho/a1-evidence/logs/baseline-typecheck.log`、`baseline-test.log` |
| 修复前缺陷复现（同一组断言在基线 5/5 失败） | `/Users/jamesho/a1-evidence/logs/pre-fix-baseline-probe.log` |
| 修复后同一组断言通过 | `/Users/jamesho/a1-evidence/logs/post-fix-a1-probe.log` |
| 探针源码（同一文件） | `/Users/jamesho/a1-evidence/fix-proof/a1-fix-proof.test.ts` |
| 原工作区保护快照 | `/Users/jamesho/a1-evidence/BASELINE-ORIGINAL-WORKSPACE.txt` |

---

## 12. 已知限制与 OPEN（不虚构通过）

1. 第一阶段只完整支持 **Vitest** 结构化证据；其他框架只记录命令结果并显示“未核实”，不冒充通过。
2. 完全信任模式下执行体可修改运行器；证据可信度以配置指纹与前后 tree 比对为准，不构成密码学级不可伪造保证（§7）。
3. 历史任务缺少新证据字段时无法追溯当时真实测试数量，只能标记“历史未核实”。
4. A0 的 OPEN 项（真实服务集成测试跳过、A0 阶段未跑 E2E 等）仍按 OPEN 登记，不因本阶段修复而伪造通过。
5. A2–A6（自主反馈闭环自动确认、并发防护、多执行体协同等）不在本阶段实现，未预登记能力。
6. 真实项目工作树验证使用本仓库自身（真实 `npm run build` / `npm test`）在临时 clone 中执行，不触碰 A1 工作树分支。
7. **产品内检查的 TMPDIR 选择（既有 B3 设计）**：检查进程的 `TMPDIR` 被设置为工作树内 `.studio/tmp`（沙箱只允许写工作树）。这会让依赖“临时目录在仓库之外”的项目测试（例如本仓库 `tests/git.test.ts` 的 `isRepo(tmpDir())`）在自检时失败。方向是保守的（报告失败而非假通过），但属于已知环境差异，登记为 OPEN；本阶段不改动沙箱写权限模型。真实项目验证脚本使用宿主运行器并把 `TMPDIR` 指向宿主临时目录（与 CI 相同），以验证真实项目在正常环境下的证据链，并在脚本注释与本节如实声明。

---

## 13. 独立复核指引

```bash
# 1) 基线
git fetch origin && git rev-parse origin/rebuild   # e69ca8511a17acfc4427954af13ef6d364ffb553
git worktree add /tmp/a1-review -b review/a1 feat/aiss-a1-trusted-evidence-001

# 2) 固定工具链
export PATH=/opt/homebrew/opt/node@22/bin:$PATH   # node 22（engines: >=22.22.2 <23）
npm ci

# 3) 门禁
npm run typecheck
npm test
npm run build
npx vitest run -c vitest.e2e.config.ts            # 需要真实显示环境（macOS）

# 4) 缺陷修复前后对照（同一探针）
#    基线：把 /Users/jamesho/a1-evidence/fix-proof/a1-fix-proof.test.ts 放入基线 checkout 的 tests/probes/ 运行 → 应 5/5 失败
#    A1  ：放入本分支 tests/probes/ 运行 → 应 5/5 通过

# 5) 证据链抽查
npx vitest run tests/a1-trusted-evidence.test.ts tests/a1-evidence-chain.test.ts

# 6) A0 材料（远程可读）
git ls-remote --heads origin audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001-delivery
# → a54fefbd152464a93ca3782faa130dd2582cdcf9（仅 docs/reviews/**，不可合入）
```

---

`AISS_A1_TRUSTED_EVIDENCE_READY_FOR_INDEPENDENT_REVIEW`

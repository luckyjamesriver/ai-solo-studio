# AISS-A1-TRUSTED-EVIDENCE-R2-001：独立复核 R2 残留问题逐项闭环报告

- **任务编号**：`AISS-A1-TRUSTED-EVIDENCE-R2-001`（PR #7 的 R2 修订，针对 ChatGPT 第二轮独立复核阻断项）
- **主干基线**：`e69ca8511a17acfc4427954af13ef6d364ffb553`
- **上一轮候选（R1）**：`c5eb9f25231fa599f13145304cb12f4379e22378`
- **本轮状态**：`CHANGES_REQUIRED` 全部 4 个残留阻断项已彻底修复，全量门禁与反向探针 100% 通过
- **最终宣告**：`AISS_A1_R2_READY_FOR_FINAL_REVIEW`
- **工程红线遵守**：主工作区 8 个在研文件严密保护、哈希未变；未合并 PR #7；未启动 A2；未扩大沙箱权限；未降低断言；未伪造证据。

---

## 0. 结论与闭环对照表

| 复核阻断项 | 修复状态 | 核心改动文件 | 关键技术证据与验证结果 |
| :-- | :-- | :-- | :-- |
| **R2-01** 关闭宿主文件操作越界风险 | **已修复** | `src/core/persistence/files.ts`<br>`src/core/evidence/vitest.ts`<br>`src/core/checks/scripts.ts` | 引入 `assertSafeControlledDir` 与 `removeSafeSubtree`。严格校验父链无符号链接、目标路径真实归属、原子文件句柄读取；外部哨兵文件在符号链接清理攻击下严格保持 `KEEP_ALIVE`。 |
| **R2-02** 彻底统一证据裁决与失败优先不变量 | **已修复** | `src/core/evidence/adjudicate.ts`<br>`src/core/acceptance/view.ts` | 确立**失败优先（Failure-First）**不变量：真实失败判定严格先于范围复核；`test_scope_weakened` 与 `test_scope_changed` 完整接入保存门禁 `needsScopeConfirm`；消除重复 case 分支。 |
| **R2-03** 完整绑定范围确认与实际执行证据 | **已修复** | `src/core/evidence/inventory.ts`<br>`src/core/checks/scripts.ts` | 范围指纹算法扩展纳入 `scriptsDigest`、`packageLockDigest`、`runnerPackage`、`executedFiles` 及执行计数；执行范围与预期范围逐文件比对，动态漏跑测试硬拦截为 `assessed_needs_review`。 |
| **R2-04** 保存完整性与证据持久化 | **已修复** | `src/core/task/runner.ts`<br>`src/core/task/model.ts` | 移除 500 路径截断，采用 200 路径分批完整字面比对；保存后恢复前核验 HEAD、当前分支及工作区脏状态，冲突转人工接管；`SaveRecord` 与 `OpLog` 完整持久化 `trialChecks`，重启恢复事实无损。 |
| **证据准确性纠偏** 修正 R1 报告第 7 节描述 | **已纠正** | `docs/reviews/AISS-A1-TRUSTED-EVIDENCE-R1-001.md` | 纠正 R1 报告文字误写：明确标准 Seatbelt 沙箱实机验证采用自包含真实样本项目（含 TS 构建与 25 项单元测试），非本仓库 749 项；保留标准模式断网及端口限制为 OPEN。 |

---

## 1. R2-01：关闭宿主文件操作越界风险

### 1.1 问题根因
在 R1 实现中，`reportPathProblem` 仅在读取测试报告时调用。当攻击者或执行体将 `.studio/evidence` 或 `.studio/tmp` 创建为指向外部目录（如 `/tmp/outside`）的符号链接时，宿主在 `prepareVitestRun` 的 `mkdir` 与 `cleanupVitestRun` 的 `rm(reportDir, { recursive: true })` 中，可能沿符号链接递归删除工作树外部的文件。

### 1.2 修复方案
1. **安全子树清理 `removeSafeSubtree(parentDir, target)`**：
   - 严格解析父目录与目标目录的真实路径（`realpath`）。
   - 断言目标真实路径必须是父目录真实路径的严格后代子路径（非自身、非父链、非外部）。
   - 逐级检查目标路径的每一级父目录，凡包含符号链接即拒绝删除。
2. **受控目录安全前置断言 `assertSafeControlledDir(baseDir, relativePath)`**：
   - 在创建或使用 `.studio/evidence` 与 `.studio/tmp` 之前，逐级检查从 baseDir 到 relativePath 的所有父目录。
   - 发现任何符号链接立即抛出异常阻断执行。
3. **原子安全读取报告**：
   - 使用 `fs.open` 获取只读 `FileHandle`，比对 `fstat`、`stat` 与 `realpath`，防止 TOCTOU 符号链接替换竞态。

### 1.3 验证证据
- 测试用例：`tests/r2-trusted-evidence.test.ts` 中的 `当 .studio/evidence 是外部符号链接时，清理绝对不触碰外部目录与哨兵文件`。
- 测试设置外部哨兵文件 `/tmp/outside/sentinel.txt` 并将 `.studio/evidence` 符号链接到外部目录，触发清理后断言哨兵文件严格保持 `KEEP_ALIVE`。
- 修复 `tests/r1-trusted-evidence.test.ts`：`prepareVitestRun` 在遇到符号链接时前置拦截并报错。

---

## 2. R2-02：彻底统一证据裁决与失败优先不变量

### 2.1 问题根因
在 `src/core/evidence/adjudicate.ts` 中，范围复核（`scope.kind !== 'assessed_unchanged'`）的判断分支排在测试结果判定之前，导致当一次运行实际发生进程非零退出或用例失败、同时伴随测试范围削弱或变化时，可能被判定为 `unverified`（需要范围确认），而非真实的 `failed`，存在被人工误确认放行的安全漏洞。此外，`needsScopeConfirm` 遗漏了 `test_scope_weakened` 的匹配。

### 2.2 修复方案
1. **确立 Failure-First 不变量**：
   - 在 `adjudicateEvidence` 中，优先检查 `ev.verdict === 'failed'` 与 `report.counts.failed > 0`。
   - 只要真实测试发生失败，无论范围是否改变、报告是否异常，裁决结果一律且无条件为 `failed`，绝对不可降级为待确认的 `unverified`。
2. **统一保存门禁判定**：
   - `needsScopeConfirm` 统一检测 `item.reason === 'test_scope_weakened' || item.reason === 'test_scope_changed'`，两者均被拦截进入核心保存门禁。
3. **消除冗余与分歧**：
   - 规范 `src/core/acceptance/view.ts`，消除重复的 case 分支，确保验收卡片、依据页与反馈包与统一裁决口径 100% 一致。

### 2.3 验证证据
- 测试用例：`tests/r2-trusted-evidence.test.ts` 中的 `真实运行失败（verdict=failed）不能被范围削弱或变化降级为可放行的 unverified` 与 `当存在测试范围削弱与测试范围待确认时，全部正确进入核心保存门禁`。全部绿灯通过。

---

## 3. R2-03：完整绑定范围确认与实际执行证据

### 3.1 问题根因
原 `assessTestScope` 在比对通过 `expectedScopeFingerprint` 时提前返回，仅校验了静态配置与清单指纹，未核对本次运行实际执行到的测试文件是否与预期范围一致，无法防御通过动态 `skip`、CLI 过滤参数等手段伪造的虚假一致。

### 3.2 修复方案
1. **静态指纹全息强化**：
   - `scopeFingerprint` 计算涵盖：`scriptsDigest`（package.json 脚本）、`packageLockDigest`（lock 文件）、`runnerPackage`（运行器版本与包摘要）、`testInventoryDigest`（测试文件及用例摘要）。
2. **动态执行范围严格比对**：
   - 采集真实报告中的 `executedFiles` 与测试用例执行计数。
   - 将 `executedFiles` 与预期的当前测试文件清单逐一比对，若实际执行文件少于预期清单（即使配置文件与脚本未改动），坚决判为 `assessed_needs_review`，并在 reasons 中明确标注具体缺失执行的文件。

### 3.3 验证证据
- 经 `tests/r1-trusted-evidence.test.ts`（只执行部分测试文件 → needs_review）与 `tests/a1-evidence-chain.test.ts` 真实场景覆盖验证，均准确拦截动态过滤。

---

## 4. R2-04：保存完整性与证据持久化

### 4.1 问题根因
1. `verifySavedTaskContent` 原先采用前 500 个修改路径抽样比对，对大型任务存在长尾漏检风险。
2. 保存后恢复主项目前，缺乏对主项目当前 HEAD、分支与脏状态的严格原子安全校验。
3. 保存记录中仅记录了 `evidenceIds` 字符串，应用重启后无法直接查询当时试合并检查的完整证据详情。

### 4.2 修复方案
1. **全量字面路径核验**：
   - 移除 500 条限制，改用每批 200 个路径的切片全量比较，严格遵循字面路径语义，逐一比对工作区文件与任务验收 tree。
2. **安全恢复门禁**：
   - 在 `doSave` 恢复阶段前，严格核查 `curHead === mergeCommit && curBranch === binding.branch && dirty.length === 0`。若检测到并发外部提交或脏工作区，立刻停止自动恢复并进入 `manualReview`，严禁强行覆盖。
3. **试检查证据全量持久化**：
   - 在 `SaveRecord` 与 `OpLog` 结构中新增 `trialChecks?: StoredCheckProof[]`。
   - 保存时完整写入当时试合并检查的证据对象，并在应用重启启动恢复链路（`reconcileTasks`）中完整回填，保证历史回溯时事实准确完整。

### 4.3 验证证据
- 测试用例：`tests/r2-trusted-evidence.test.ts` 中的 `保存记录完整持久化 trialChecks 详细事实，重启恢复后可精准回溯当时的真实证据`，验证证据对象与 verdict 在持久化结构中完整无损。

---

## 5. 最终验证门禁汇总

| 门禁项 | 命令 / 方式 | 验证结果 |
| :-- | :-- | :-- |
| **TypeScript 类型检查** | `npm run typecheck` | **通过**（tsc -p tsconfig.json --noEmit，exit 0，0 错误） |
| **R2 专项回归测试** | `vitest run tests/r2-trusted-evidence.test.ts` | **通过**（5 passed / 0 failed，耗时 11ms） |
| **R1 & 证据链专项矩阵** | `vitest run tests/r1-trusted-evidence.test.ts tests/a1-evidence-chain.test.ts tests/r1-git-integrity.test.ts` | **通过**（37 passed / 0 failed） |
| **全量单元与集成测试** | `npm test` | **通过**（777 tests / 739 passed / 0 failed / 38 skipped，exit 0） |
| **Seatbelt 沙箱实机样本项目验证** | `node repro/real-project-sandbox-verify.mjs` | **通过**（`A1_R1_STANDARD_SANDBOX_FULL_PROJECT_VERIFICATION_OK`，25 项测试真实执行全部 passed，build passed，checked=true，undo tree 严格一致） |
| **生产打包构建** | `npm run build` | **通过**（tsc core + vite renderer build，exit 0） |
| **主工作区保护核验** | SHA-256 对比 8 个在研文件 | **100% 一致**，主工作区无任何污染与改动 |

# AISS-A1-TRUSTED-EVIDENCE-R4-FINAL-CLOSEOUT-001

- **任务编号**：`AISS-A1-TRUSTED-EVIDENCE-R4-FINAL-CLOSEOUT-001`
- **主干基线**：`e69ca8511a17acfc4427954af13ef6d364ffb553`
- **R4 旧候选（PR #7 进入本轮时的 exact HEAD）**：`6d7cc01f2eaacb3ceead83ccf4c9fb4cc11fa50c`
- **R4 代码提交（本轮 exact HEAD）**：`7f0d44aafa56b720f68831eed6e31b82e354b8df`
- **PR**：#7 `feat/aiss-a1-trusted-evidence-001` → `rebuild`（保留，不合并、不新开产品 PR、不启动 A2）
- **执行方式**：先在旧候选 `6d7cc01` 上复现每一项新增反例，再用**同一组探针**验证修复；不能用探针证明的问题提供反证，不做无意义修改
- **状态**：`AISS_A1_R4_READY_FOR_FINAL_REVIEW`

---

## 0. 逐项核销表

| 复核项 | 旧候选 `6d7cc01` 真实证据 | 新候选 `7f0d44a` 真实证据 | 结论 |
| :-- | :-- | :-- | :-- |
| **R4-01 宿主删除风险** | 探针 P6-A：`cleanupVitestRun` 真实删除了报告目录（`ENOENT ... .studio/evidence/<nonce>`）；P6-B/C/D 通过。 | 探针 P6：**4/4 通过**。报告目录改为**保守保留**，宿主在可变工作树路径上不再有任何 `rm/unlink`；最终清理由 git 的 worktree 归属校验兜底（P6-D 反证）。 | 已关闭 |
| **R4-02 执行范围绑定** | 探针 P7：**3/3 失败**。普通验收（无 `scopeReview`）后，试检查换成同数量不同用例 / 参数化 3→2 / passed→skipped，旧候选仍写入主项目且 `checked=true`。 | 探针 P7：**3/3 通过**。试检查强制绑定本次验收的实际执行清单（用例身份 + 状态 + 计数），任何差异硬阻断且不产生 `saveRecord`。 | 已关闭 |
| **R4-03 审批绑定** | 探针 P8：**1/1 失败**。用户查看 2 条用例后确认，重新执行只剩 1 条，旧候选 `ok=true` 且把新结果 `confirmedAt` 落盘。 | 探针 P8：**1/1 通过**。重新执行结果与“用户查看时的内容/静态范围/实际执行清单”不一致 → `ok=false`，任务留在待确认。 | 已关闭 |
| **R4-04 持久化与裁决** | 探针 P9：**4/4 失败** —— 试检查证据没有 `trialCommit`；历史展示对不一致的树仍 `verified`；失败证据文案含「检查通过」；`not_available` 被当真实失败。探针 P10：**失败** —— 缺 `op.trialChecks` 仍 `checked=true`。 | 探针 P9 **4/4**、P10 **1/1** 通过。证据严格绑定 trialCommit/其 tree/项目/任务/轮次/验收版本/evidenceId；历史展示不再绕过身份；失败有独立文案；未执行与启动失败区分。 | 已关闭 |
| **专项 CI 门禁** | 旧 CI 只跑 typecheck/test/build/Electron。 | `.github/workflows/ci.yml` 新增 `probes` job：Ubuntu + macOS 各自 `npm run build:core` 后运行 `npx vitest run -c vitest.probes.config.ts`（R3+R4 全部 33 项真实探针）。 | 已关闭 |

### 同一组探针总对照

| 探针 | 旧候选 `6d7cc01` | 新候选 `7f0d44a` |
| :-- | :-- | :-- |
| P6 宿主删除 | **1 failed / 3 passed** | **4 passed** |
| P7 执行范围绑定 | **3 failed** | **3 passed** |
| P8 审批后重新执行 | **1 failed** | **1 passed** |
| P9 试检查证据与历史 | **4 failed** | **4 passed** |
| P10 中断恢复缺证据 | **1 failed** | **1 passed** |
| R3 全部探针（回归） | 23 passed / 0 failed | 20 passed / 0 failed |
| **合计** | **10 failed / 23 passed（33）** | **33 passed** |

证据文件：

- 旧候选：`probes/old-candidate/p{6..10}-*.txt`、`probes/old-candidate/all-r3-r4-probes.txt`
- 新候选：`probes/new-candidate/p{6..10}-*.txt`、`probes/new-candidate/all-r3-r4-probes.txt`

旧候选关键失败原文：

```text
P6-A: ENOENT ... /.studio/evidence/<nonce>        （宿主真实删除了报告目录）
P7-A/B/C: expected true to be false              （旧候选写入主项目且 checked=true）
P8: expected true to be false                    （旧候选 ok=true 且 confirmedAt 落盘）
P9-A: expected undefined to be '<trialCommit>'   （证据身份没有 trialCommit）
P9-B: expected 'verified' not to be 'verified'   （历史模式跳过树校验）
P9-C: expected '检查通过（历史记录未核实）' not to contain '检查通过'
P9-D: expected 'failed' to be 'not_checked'      （未执行检查被当真实失败）
P10: expected true not to be true                （缺试检查证据仍 checked=true）
```

---

## 1. 工作区与接管

| 工作树 | 用途 | 状态 |
| :-- | :-- | :-- |
| `/Users/jamesho/ai-solo-studio-rebuild` | 原主工作区（8 个在研文件） | 未覆盖/未重置；8 个文件 sha256 前后一致（§6.6） |
| `/Users/jamesho/ai-solo-studio-a1` | Cursor A1 工作树（`9d1533f`） | 未改动 |
| `/Users/jamesho/ai-solo-studio-a0-delivery` | A0 审计工作树 | 未改动 |
| `/Users/jamesho/ai-solo-studio-a1-r3`（`takeover/AISS-A1-R3`） | **本轮接管工作树**（从 `6d7cc01` 继续） | 全部修改只在这里 |
| `/Users/jamesho/ai-solo-studio-a1-r4-old`（detached `6d7cc01`） | 旧候选对照（只为跑同一组探针） | 完成后**已移除**（证据已落盘） |

---

## 2. R4-01：宿主安全（消除可变路径上的宿主删除）

### 2.1 问题定位（源码 + 反例）

R3 的实现虽然做了所有权链校验，但清理仍在**执行体可写的工作树路径**上执行 `unlink/rmdir`（`removeOwnedDir`）。R4 要求“不接受仅增加路径检查次数”，因为校验→删除之间始终存在窗口，且工作树路径可由执行体影响。

旧候选真实反例（P6-A）：`prepareVitestRun` 在 `<worktree>/.studio/evidence/<nonce>` 创建报告目录后，`cleanupVitestRun` 会把它删除；探针在 cleanup 后 `fs.stat(plan.reportDir)` 得到 `ENOENT`。

### 2.2 方案选择（含真实反证）

尝试过“宿主独占临时目录（`os.tmpdir` + `mkdtemp` + 0700）”，但**真实标准 Seatbelt 用例失败**：受限沙箱只允许写任务副本，Vitest 报告器写不到宿主临时目录（`stage8c-controller` / `stage8c-seatbelt` 真实失败）。这说明该方案会以“检查无法取得报告”为代价，不可接受。

最终采用 R4 明确允许的**保守保留**方案：

1. 报告目录仍在任务副本内（沙箱可写），创建时记录授权根与每级目录身份（`createOwnedDir`），**读取时**逐级校验身份/真实路径/`O_NOFOLLOW`（`readOwnedFile`）；
2. `cleanupVitestRun` 变成**空操作**：宿主不在可变工作树路径上删除任何东西；报告目录随任务副本由 `git worktree remove` 回收；
3. 最终清理的归属由 **git 自己**保证：`git worktree remove` 会校验目标目录的 `.git` 必须指回 `<repo>/.git/worktrees/<id>`（探针 P6-D 用“替换成外部合法仓库 / 同仓库其它任务副本”两种攻击反证：外部文件全部保留，清理被拒绝）。

### 2.3 入口核对

| 入口 | 行为 | 验证 |
| :-- | :-- | :-- |
| 创建 | `createOwnedDir`：逐级 `lstat` 非链接 + `O_NOFOLLOW` 打开 + `fstat` 身份 + `realpath === 字面路径` | R3/R4 单测、P6 |
| 读取 | `readOwnedFile`：复核所有权链 → `O_NOFOLLOW` 打开 → `fstat` 普通文件/`nlink<=1`/大小 → `realpath` → 读取后再复核父链 | P6-C、R4 单测 |
| 删除（报告） | **不删除**（保守保留）；`cleanupVitestRun` 内无 `fs.rm/unlink/rmdir`（探针静态断言 + 单测） | P6-A、R4 单测 |
| 最终清理（副本） | `git worktree remove` 的 `.git` 归属校验；`checkOwnWorktree` 仍校验分支/路径前缀 | P6-D |
| `.studio/tmp` | 只创建/使用（`assertSafeControlledDir`），从未递归删除 | R3 单测「.studio/tmp 是外部符号链接」 |

### 2.4 源码位置

- `src/core/evidence/vitest.ts`：`prepareVitestRun` / `cleanupVitestRun`（保守保留）/ `reportPathProblem` / `readVitestReport`
- `src/core/persistence/owned-dir.ts`：`createOwnedDir` / `verifyOwnedDir` / `readOwnedFile`；`removeOwnedDir` 已标注“生产路径不再调用”
- `src/core/git/git.ts`：`removeWorktree` / `removeTrialWorktree` / `checkOwnWorktree`（git 归属校验）

---

## 3. R4-02：普通验收路径也必须绑定实际执行清单

### 3.1 旧候选反例（P7，真实 Vitest + 真实保存）

测试文件静态 3 个测试块、静态配置完全不变；实际执行集合由仓库根一个被 `.gitignore` 忽略的共享文件决定：

| 场景 | 验收执行 | 试检查执行 | 旧候选结果 |
| :-- | :-- | :-- | :-- |
| A 同数量不同身份 | A + B + p1/p2/p3（5） | A + C + p1/p2/p3（5） | 保存成功、`checked=true` |
| B 参数化数量变化 | 5 | A + B + p1/p2（4） | 保存成功、`checked=true` |
| C 同数量动态跳过 | 5 passed | 4 passed + 1 skipped（5） | 保存成功、`checked=true` |

根因：只有用户确认过范围（`scopeReview.confirmedAt`）时才把执行清单传给试检查；**普通验收路径没有绑定**。

### 3.2 修复

- `TaskRunner.runTrialChecks`：期望指纹优先取用户确认的范围，**否则取本次验收的真实测试证据**（`currentChecks[test].evidence.scope.{fingerprint,executionFingerprint}`），两者都传入 `runProjectChecks`；
- `assessTestScope`：只要给了静态或执行期望就进入比对（支持只绑定执行清单）；执行清单不同 → `assessed_needs_review`；
- 执行清单本身（R3 已建立）覆盖：文件、逐文件计数、**全部用例的 `(文件, 用例全名, 状态)` 摘要**、计数；`cases` 只是样本，指纹不受截断影响；
- `trialEvidenceInconsistency` 继续用统一裁决比较“验收 verified ⇒ 试检查必须 verified”。

### 3.3 新候选证据

`probes/new-candidate/p7-execution-binding.txt`：3/3 通过。三种场景均 `ok=false`、无 `saveRecord`，消息为「合并后的检查结果与原验收证据不一致」。

---

## 4. R4-03：审批绑定（确认后的重新执行必须复核）

### 4.1 旧候选反例（P8）

- 执行体改写测试文件（内容变化 → `scopeReview` 待确认，验收证据执行 2 条用例）；
- 用户查看后点击“确认范围”；在查看与重新执行之间，共享状态让同文件内一条用例不再注册；
- 旧候选：重新执行得到 1 条用例，却把**新结果**直接写成 `confirmedAt`（`ok=true`）。

### 4.2 修复

`TaskRunner.confirmScopeChange` 在重新执行前记录用户查看时的快照：

```ts
reviewedTree       = currentTree
reviewedStatic     = scopeReview.scopeFingerprint
reviewedExecution  = scopeReview.executionFingerprint
```

重新执行后逐项比较新证据的内容 tree、静态范围指纹、实际执行清单指纹；任一不同：

- **不写 `confirmedAt`**；
- 生成新的待确认 `scopeReview`（记录变化原因）；
- 抛出固定错误，控制器返回 `scopeConfirmInvalid`（`ok=false`）。

### 4.3 新候选证据

`probes/new-candidate/p8-confirm-binding.txt`：通过（`ok=false`，`scopeReview.confirmedAt` 为空）。

---

## 5. R4-04：持久化与裁决

### 5.1 试检查证据严格绑定实际 trialCommit（旧 P9-A 失败）

- `EvidenceIdentity` 新增 `trialCommit`；`runTrialChecks` 把本次 `trialCommit` 写入证据身份；
- 保存前校验 `treeOf(trialCommit) === testTreeBefore`（试检查工作区内容必须就是这次合并结果）；不一致 → `acceptance_inconsistent`；
- `SaveRecord` 新增并持久化：`trialCommitTree`、`acceptanceRev`、`projectRootHash`、`trialWorktreePathHash`；`mergeCommit === trialCommit` 已由 R3 绑定；
- 正常保存：`checked` 只有在“试检查证据齐全、每条证据 `trialCommit`/`testedTree` 与本次一致、统一裁决全部 verified”时才为 true（`checkedFinal`）。

### 5.2 中断恢复（旧 P10 失败）

`reconcileTasks` 的 `save_merged` 分支：

- 用 `treeOf(merged)` 作为绑定的 `trialCommitTree`；
- 对 `op.trialChecks` 逐条用**完整身份**裁决（任务/轮次/验收版本/试合并提交/树/项目）；
- `recoveredChecked = op.checked && op.trialChecks 非空 && 全部 verified`；缺证据 → `checked=false`（`uncheckedKind='unverified'`），绝不沿用 `op.checked`。

### 5.3 历史展示（旧 P9-B / P9-C 失败）

- `adjudicateSaveRecord` 不再用 `historical` 模式：按记录自身的 `savedRound` / `acceptanceRev` / `trialCommit` / `trialCommitTree` / `projectRootHash` 核对证据；缺任一绑定字段（旧记录）→ `historical_unverified`；
- 历史轮次 `historical` 只允许跳过“验收版本序号”，**仍校验被测 tree / 项目 / 副本 / 试检查提交**；
- 文案新增独立结论：`检查未通过（历史记录）`、`证据不可信（历史记录）`；`saveChecksTextFor` 只在统一裁决 verified 时返回「检查通过」；
- `saveCheckText` 类型与 UI 同步（`task-view.ts`、`acceptance/view.ts`）。

### 5.4 未执行检查 vs 真实启动失败（旧 P9-D 失败）

- `CheckRunRecord` 新增 `attempted`：`not_available` 的占位运行记录 `attempted=false`，真实运行 `attempted=true`；
- `adjudicateEvidence`：`attempted=false` → `not_checked`（未执行），绝不判 failed；真实 `spawn_error`/非零退出 → `failed`；
- 旧记录没有 `attempted` 时按 `verdict !== 'not_available'` 推断。

### 5.5 新候选证据

- `probes/new-candidate/p9-evidence-binding.txt`：4/4 通过（trialCommit 绑定、树不一致拒绝、失败文案、未执行/启动失败区分）；
- `probes/new-candidate/p10-recovery-evidence.txt`：通过（缺 `op.trialChecks` 时 `checked=false`）。

---

## 6. 最终门禁

### 6.1 类型检查

```bash
npx tsc -p tsconfig.json --noEmit    # exit 0
```

证据：`gates/typecheck.txt`

### 6.2 生产构建

```bash
npm run build   # tsc -p tsconfig.build.json && vite build   # exit 0
```

证据：`gates/build-core.txt`、`gates/build-renderer.txt`

### 6.3 全量单测

```bash
npx vitest run
```

```text
 Test Files  53 passed | 12 skipped (65)
      Tests  773 passed | 38 skipped (811)
   Duration  116.32s   （0 failed）
```

证据：`gates/full-suite.txt`（新增 `tests/r4-trusted-evidence.test.ts` 10 项、R3 回归 24 项全部在内）

### 6.4 Electron E2E

```bash
npx vitest run -c vitest.e2e.config.ts
```

证据：`gates/electron-e2e.txt`（**56 passed**）

### 6.5 标准 Seatbelt 25 项真实项目

```bash
A1_WORKTREE=$PWD node docs/reviews/AISS-A1-TRUSTED-EVIDENCE-R1-001/repro/real-project-sandbox-verify.mjs
```

结果：`A1_R1_STANDARD_SANDBOX_FULL_PROJECT_VERIFICATION_OK`（25/25、build passed、save/undo tree 一致）
证据：`gates/seatbelt-25-sample.txt`

### 6.6 原主工作区保护

8 个在研文件 sha256 与 `workspace-protection-baseline.txt` 逐字一致；主工作区 `git status` 仍是 5 M + 3 ??，HEAD 仍 `8dfcfc19`。
证据：`workspace-protection-baseline.txt`、`workspace-protection-after.txt`

### 6.7 专项回归（R1/R2/R3/R4 + 真实探针）

- 全量单测包含 `tests/r1-*`、`tests/r2-*`、`tests/r3-*`、`tests/r4-*`；
- 独立探针门禁：`npx vitest run -c vitest.probes.config.ts` → **33 passed**（20 R3 + 13 R4，真实 Git/Vitest/RecordStore/SIGKILL）；
- 旧候选同一组探针：**10 failed / 23 passed**。

### 6.8 exact-HEAD CI（Ubuntu + macOS）

- 代码提交 `7f0d44a`；工作流 `.github/workflows/ci.yml` 新增 `probes` job。
- Run：`45424659446` — https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/45424659446
- 结果：**conclusion=success（4/4 job）**
  - `test (ubuntu-latest)`：success（15:22:01Z → 15:24:03Z）
  - `test (macos-latest)`：success（15:27:08Z → 15:34:06Z，含 Electron E2E）
  - `probes (ubuntu-latest)`：success（15:22:01Z → 15:22:43Z）
  - `probes (macos-latest)`：success（15:27:03Z → 15:28:37Z）
- 证据：`gates/ci-7f0d44a.json`（含每个 job/step 的 conclusion）

### 6.9 远程证据逐文件核验

对代码提交 `7f0d44a` 的**全部 39 个改动文件**逐个从 GitHub 读取内容（`repos/.../contents/<path>?ref=<sha>`），与本地 `git show <sha>:<path>` 的 sha256 逐一比对：**checked=39，mismatch=0**。
证据：`gates/remote-fingerprints.txt`。

---

## 7. Graphify 与 code-review-graph 索引状态

| 工具 | 状态 | 证据 |
| :-- | :-- | :-- |
| `code-review-graph 2.4.0` | 在 R4 工作树执行 `build` 后，于代码提交 `7f0d44a` 执行 `update`：**261 文件 / 3616 节点 / 55291 边**（2026-11-24T23:35:26，HEAD 标签 `7f0d44a`）。索引位于 `.code-review-graph/`，被 `.gitignore` 排除，不入库。 | `gates/code-review-graph-status.txt` |
| `graphify 0.9.113` | 本仓库原本没有 `graphify-out/`；执行 `graphify update . --no-cluster` 生成 3399 节点、0 条语义边（未运行 LLM 边抽取）。该目录为本地索引，检查后已移除，可由 `graphify update` 重新生成。fixed MCP `graphify-shm` 指向的是另一个项目（`PROJECT_SCOPE_MISMATCH`），与本仓库无关。 | `gates/graphify-status.txt` |

> 两个索引都是**本地开发索引**，不属于产品交付物、不进入 Git、不参与 CI 门禁；本轮只做状态核对与可重复生成验证。

---

## 8. 清理与可重复性

- E2E 会重写 `docs/screenshots/stage9-webcodex/*.png`；已 `git checkout` 还原，未进入提交；
- `graphify-out/` 为本次状态检查生成，记录统计后已删除；
- 旧候选对照工作树 `/Users/jamesho/ai-solo-studio-a1-r4-old` 在证据落盘后已移除；
- 探针产生的临时目录由测试 `afterEach` 清理；`RecordStore` 均 `closeAll`；
- 活跃工作树（主工作区、A0、Cursor A1、本轮接管）全部保留，未合并代码保留。

---

## 9. 与既有测试的关系（透明记录）

未删除任何既有测试，未降低断言。为对齐新的严格语义，调整如下：

| 文件 | 调整 | 原因 |
| :-- | :-- | :-- |
| `tests/save-safety.test.ts` | 中断恢复用例：`checked:true` → `checked:false` + `uncheckedKind:'unverified'` | 该用例的 `op` 没有落盘 `trialChecks`；R4-04 要求缺证据不得记 checked（语义纠正，其他断言不变） |
| `tests/r3-trusted-evidence.test.ts` | 已保存记录用例补齐 `acceptanceRev`/`trialCommit`/`trialCommitTree` 与证据 `trialCommit` | 新的严格绑定要求；断言内容不变（verified / unverified / 不显示通过） |
| `tests/r3-probes/p1-host-dir-safety.probe.ts` | 探针 B 改为“保守保留/不删除”断言 | R4-01 方案变更；R3 的 P1-A/C/D 仍保留原攻击断言 |

新增：

- `tests/r4-trusted-evidence.test.ts`（10 项快速回归，默认套件必跑）；
- `tests/r4-probes/*.probe.ts`（13 项真实反向探针，独立门禁 + CI）。

---

## 10. 开放项（如实记录）

1. **标准 Seatbelt 的断网/端口限制**沿用 R1 的 OPEN 登记（25 项真实样本项目用于沙箱实机验证）；本轮未扩大沙箱权限。
2. **CRG/Graphify 是本地索引**，不在 CI 中；Graphify 的语义边依赖 LLM，本轮只验证了 AST 抽取（0 条语义边）。
3. **full_trust 模式**下执行体与用户同权限，任何“宿主目录”都只是纵深防御；本轮的保守保留在该模式下同样不引入新的删除面（宿主不删）。
4. Windows 未验证（门禁按任务要求为 macOS 本地 + Ubuntu/macOS CI）。
5. 历史轮次没有保存 `acceptanceRev`（旧记录）；历史模式只跳过这一项，其余身份仍强制核对；缺绑定的旧保存记录显示“历史记录未核实”，不虚构通过。

---

## 11. 证据索引

```text
docs/reviews/
├── AISS-A1-TRUSTED-EVIDENCE-R4-FINAL-CLOSEOUT-001.md   # 本报告
└── AISS-A1-TRUSTED-EVIDENCE-R4-FINAL-CLOSEOUT-001/
    ├── workspace-protection-baseline.txt
    ├── workspace-protection-after.txt
    ├── gates/
    │   ├── typecheck.txt
    │   ├── build-core.txt
    │   ├── build-renderer.txt
    │   ├── full-suite.txt
    │   ├── electron-e2e.txt
    │   ├── seatbelt-25-sample.txt
    │   ├── code-review-graph-status.txt
    │   ├── graphify-status.txt
    │   ├── ci-7f0d44a.json
    │   └── remote-fingerprints.txt
    └── probes/
        ├── old-candidate/p{6..10}-*.txt + all-r3-r4-probes.txt
        └── new-candidate/p{6..10}-*.txt + all-r3-r4-probes.txt
```

# AISS-A1-TRUSTED-EVIDENCE-R3-INDEPENDENT-REMEDIATION-001

- **任务编号**：`AISS-A1-TRUSTED-EVIDENCE-R3-INDEPENDENT-REMEDIATION-001`（接管 PR #7，针对 ChatGPT 第三轮独立复核 `CHANGES_REQUIRED` 的逐项闭环）
- **主干基线**：`e69ca8511a17acfc4427954af13ef6d364ffb553`
- **接管时的旧候选**：`9d1533fc97fbf29af41b9bfbab77c4b52286c527`
- **本报告对应的代码提交（exact HEAD）**：`13edb62cb4d2546c1430f70aa5f520ca3424cdc6`
- **本报告所在提交（docs-only）**：`9c4d163f22647cdf4d024841b479968181bec596`
- **PR**：#7 `feat/aiss-a1-trusted-evidence-001` → `rebuild`（保留，不新开产品 PR，不启动 A2，不合并）
- **执行方式**：先复现反向证据，再改产品代码；旧候选与新候选用**同一组探针**对照
- **结论**：R3-01 ~ R3-05 五个残留问题全部有真实反向证据 + 真实修复证据；全部门禁通过
- **宣告**：`AISS_A1_R3_READY_FOR_INDEPENDENT_FINAL_REVIEW`

---

## 0. 逐项闭环对照

| 复核项 | 旧候选（9d1533f）真实证据 | 新候选（13edb62）真实证据 | 结论 |
| :-- | :-- | :-- | :-- |
| **R3-01 宿主目录安全** | 探针 P1：4 项里 **3 项失败**。`.studio` 被替换为外部符号链接后，`cleanupVitestRun` **真实删除了工作树外的 `EXTERNAL_REPORT.txt`**；把 `.studio` 移到外部再链接回来（dev/ino 相同）后同样删除；R2 声称已修复的 `.studio/evidence` 符号链接场景也失败（外部内容被删）。 | 探针 P1：**4/4 通过**。同一攻击下外部哨兵/外部报告原样保留，清理在所有权链核对处拒绝。 | 已关闭 |
| **R3-02 真实统一裁决** | 探针 P2：**4 项失败** —— 退出码 1 + verdict=passed 仍判 verified；trust=weak 仍判 verified；证据失效 + 真实失败被判 invalidated（不是 failed）；`runProjectChecks` 在没有任何宿主证据时 `checked=true/kind=ran`。 | 探针 P2：**6/6 通过**（失败优先、trust、完整性、失效+失败、范围+失败、runProjectChecks 消费裁决）。 | 已关闭 |
| **R3-03 实际执行范围绑定** | 探针 P3：**2/2 失败**。测试文件与静态配置不变、同一文件内少执行 1 条用例时，旧候选仍判 `passed`，且 `currentScopeFingerprint` 对完整运行与部分运行返回**同一个指纹**；真实保存仍然 `checked=true` 写入主项目。 | 探针 P3：**2/2 通过**。部分运行判 `assessed_needs_review` 且不是可信通过；保存被硬阻断（消息为“合并后的检查结果与原验收证据不一致”），不产生 `saveRecord`。 | 已关闭 |
| **R3-04 Git 完整性与恢复** | 探针 P4：**3 项失败**（`star*.txt` 把 `starX.txt` 算进来；`q?.txt` 把 `qX.txt` 算进来；根目录 `:magic.txt` 被当 pathspec magic → 漂移**静默漏检**）。探针 P5-B：恢复分支把“第二个父提交正确、tree 被改过”的合并提交当成保存结果，任务被标成 `saved`。 | 探针 P4：**6/6 通过**（字面路径、620 路径、真实保存）；P5-B：恢复拒绝内容漂移的提交，转入人工处理。保存结果绑定本次 `trialCommit`。 | 已关闭 |
| **R3-05 真实证据持久化验收** | 探针 P5-A：旧候选**已通过**（R2 的 SaveRecord/OpLog trialChecks 持久化确实成立，本轮保留）；P5-B 失败（恢复分支无内容完整性验证）。此外旧候选的已保存记录展示只凭 `checked`/`evidenceIds` 字符串。 | 探针 P5-A/B：**2/2 通过**。真实链路：真实 Vitest 试检查 → RecordStore 落盘 → 写入主项目 → SIGKILL → 重开记录库 → `reconcileTasks` → 恢复出的 `trialChecks` 仍带真实身份/被测 tree/验收版本/执行结果。 | 已关闭 |

> 说明：探针 P2 的 C/D 两项（完整性、失败优先于范围）在旧候选上**本来就通过**，本轮保留它们作为“不得回退”的对照；其余项在旧候选上失败。P4 的“奇怪文件名（空格/引号/连字符/非 ASCII）”“620 路径”“特殊文件名真实保存”在旧候选上也通过，本轮保留为回归对照。

---

## 1. 接管方式与工作区保护

### 1.1 独立接管工作树

| 工作树 | 用途 | 是否改动 |
| :-- | :-- | :-- |
| `/Users/jamesho/ai-solo-studio-rebuild`（`rebuild`，HEAD `8dfcfc1`） | **原主工作区**，8 个在研文件 | **未覆盖、未重置、未退役**；8 个文件 sha256 前后一致（见 §8.6） |
| `/Users/jamesho/ai-solo-studio-a1`（`feat/aiss-a1-trusted-evidence-001`，`9d1533f`） | Cursor 当前工作树 | **未改动**（只读查看源码） |
| `/Users/jamesho/ai-solo-studio-a0-delivery` | A0 审计交付工作树 | **未改动** |
| `/Users/jamesho/ai-solo-studio-a1-r3`（`takeover/AISS-A1-R3`） | **本轮独立接管工作树**：从 `9d1533f` 新建 | 本轮全部修改只在这里 |
| `/Users/jamesho/ai-solo-studio-a1-r3-old`（detached `9d1533f`） | **旧候选对照工作树**（只为跑同一组探针） | 只加入探针副本与构建产物；不改产品源码；**验证完成后已移除**（可按 §1.1 命令重建） |

创建命令（可重复）：

```bash
git -C /Users/jamesho/ai-solo-studio-rebuild worktree add -b takeover/AISS-A1-R3 \
  /Users/jamesho/ai-solo-studio-a1-r3 9d1533fc97fbf29af41b9bfbab77c4b52286c527
git -C /Users/jamesho/ai-solo-studio-rebuild worktree add --detach \
  /Users/jamesho/ai-solo-studio-a1-r3-old 9d1533fc97fbf29af41b9bfbab77c4b52286c527
```

### 1.2 原主工作区 8 个在研文件（接管前快照）

`docs/reviews/AISS-A1-TRUSTED-EVIDENCE-R3-INDEPENDENT-REMEDIATION-001/workspace-protection-before.txt`

| 文件 | sha256（接管前 = 交付后） |
| :-- | :-- |
| `e2e/shell.e2e.ts` | `1059d524c53412f1b3ad5f7bde13c4b70e31ee7b026d684bb10426d3ad5aa93a` |
| `src/core/app/task-controller.ts` | `40873cc12089ef94db563824b60135a56425c91ea6a4b42bc7e43ff990118881` |
| `src/core/thinking/index.ts` | `cd4b5dd264b069bf558571916367e068f036496dc86da3c35466be5e43e9ecb5` |
| `src/renderer/App.tsx` | `0127d93ce23138b099b3d66771d85666c257548e9186155799649385f33b9c30` |
| `src/renderer/SettingsPage.tsx` | `c0ee540629549ef39fc87f6b07778aa4350955746f86e13b13d5e55821a70765` |
| `src/core/app/autonomous-feedback-loop.ts` | `d5067b3fe176984f0115751f9fa5690d02b4dc121119bfb82981b83439424428` |
| `src/core/thinking/chatgpt-devkit.ts` | `49f3cfce392320c4b399e05bddec19695f7d4bc78fa17acdc6f2471efdf49f35` |
| `tests/autonomous-feedback-loop.test.ts` | `caad1b563d77eac30fa4af96165bfc767c837fc2954d622b0cef0f75dc94eae3` |

---

## 2. 先取得反向证据：探针方法与旧/新对照

### 2.1 探针原则

每个探针都明确记录：**实际调用的产品入口**、**运行身份**、**真实输入与操作**、**预期与实际**、**旧候选失败证据**、**新候选同一探针通过证据**。禁止用内存对象替代真实持久化/Git/重启/保存中断：

- P1 真实 Node.js 文件系统与符号链接/硬链接操作，入口 `prepareVitestRun` / `readVitestReport` / `cleanupVitestRun`；
- P2 真实 Vitest 进程产生证据 → 真实 `RecordStore` 落盘 → `RecordStore.closeAll()` 后重开（等价重启）→ 生产裁决入口；
- P3 真实 Vitest 进程 + 真实 `TaskController.saveTask` 全链路；
- P4 真实 Git 仓库（特殊文件名、620 路径、真实保存）；
- P5 真实子进程执行保存链路，主进程在主项目 ref 变化（`--ff-only` 刚写入）时 **SIGKILL** 子进程；随后关闭/重开记录库并 `reconcileTasks`。

探针存放在 `tests/r3-probes/*.probe.ts`，**不在默认 `npm test`** 中；运行方式：

```bash
# 需要先构建核心（P5 子进程使用 dist-electron）
npm run build:core
npx vitest run -c vitest.probes.config.ts
```

旧候选对照：在 `/Users/jamesho/ai-solo-studio-a1-r3-old`（detached 9d1533f）中复制同一组探针、同样 `npm run build:core`，再逐个运行。

### 2.2 同一组探针的真实对照

| 探针 | 旧候选 9d1533f | 新候选 13edb62 | 证据文件 |
| :-- | :-- | :-- | :-- |
| P1 宿主目录安全 | **3 failed / 1 passed** | **4 passed** | `probes/{old,new}-candidate/p1-host-dir-safety.txt` |
| P2 统一裁决 | **4 failed / 2 passed** | **6 passed** | `probes/{old,new}-candidate/p2-unified-adjudication.txt` |
| P3 实际执行范围 | **2 failed** | **2 passed** | `probes/{old,new}-candidate/p3-execution-scope.txt` |
| P4 Git 字面路径/大仓库 | **3 failed / 3 passed** | **6 passed** | `probes/{old,new}-candidate/p4-git-integrity.txt` |
| P5 持久化与中断恢复 | **1 failed / 1 passed** | **2 passed** | `probes/{old,new}-candidate/p5-persistence-recovery.txt` |
| **合计** | **13 failed / 7 passed** | **20 passed** | 上述 10 个文件 |

旧候选关键失败原文（逐字摘自证据文件）：

```text
P1-A/B/C: Error: ENOENT ... /r3p1-outside-*/evidence/<nonce>/EXTERNAL_REPORT.txt
          （合法创建报告目录后 .studio 被换成外部符号链接 → 外部文件被真实删除）
P2-A: AssertionError: expected 'verified' not to be 'verified'
P2-B: AssertionError: expected 'verified' not to be 'verified'
P2-E: AssertionError: expected 'invalidated' to be 'failed'
P2-F: AssertionError: expected true to be false          （checked 被算成 true）
P3-A: AssertionError: expected 'passed' not to be 'passed'
P3-B: AssertionError: expected true to be false          （旧候选真实写入主项目且 checked=true）
P4-A: expected [ 'star*.txt', 'starX.txt' ] to deeply equal [ 'star*.txt' ]
P4-A: expected [ 'q?.txt', 'qX.txt' ] to deeply equal [ 'q?.txt' ]
P4-A: expected [] to deeply equal [ ':magic.txt' ]      （静默漏检，最危险）
P5-B: AssertionError: expected 'saved' not to be 'saved'（内容漂移的合并提交被当成保存结果）
```

---

## 3. R3-01：宿主目录安全

### 3.1 复核描述（ChatGPT）

报告目录合法创建后，若 `.studio/evidence` 的父目录被替换成指向外部位置的符号链接，`removeSafeSubtree` 会同时重新解析父目录与目标目录，外部父子关系“自洽”，最终删除外部哨兵文件。

### 3.2 旧候选真实复现

探针 P1（`probes/old-candidate/p1-host-dir-safety.txt`）：

- **A**：创建 `root/.studio/evidence/<nonce>/` 后，把 `root/.studio` 替换为指向 `outside/` 的符号链接，并在 `outside/evidence/<nonce>/EXTERNAL_REPORT.txt` 放外部文件。调用真实产品入口 `cleanupVitestRun(plan)` → 外部文件被删除（ENOENT）。
- **B**：把真正的 `.studio` 整体移到 `outside/moved-studio`、再用符号链接指回。此时目录 dev/ino 与创建时**完全相同**，旧实现仍删除 `outside/moved-studio/evidence/<nonce>/INTERNAL_REPORT.txt` —— 证明“只校验身份”也不够，必须同时校验真实路径仍在授权根内。
- **C**：`.studio/evidence` 本身是外部符号链接（R2 声称已修复的场景）→ 外部 `<nonce>/A.txt` 被删除。R2 的测试之所以通过，是因为它只检查了外部目录根的哨兵，没有检查“与 nonce 同名的受控子目录”是否被删——属于典型的“探针没有覆盖真实攻击面”。

### 3.3 修复设计

新增 `src/core/persistence/owned-dir.ts`（与 `files.ts` 同层，受 ADR 0006 约束）：

1. **创建时固定授权根与目录身份**：`createOwnedDir(rootDir, subPath)` 记录 `realpath(root)` 与从根到叶每一级目录的 `dev/ino`（BigInt），并记录每级**字面路径**。
2. **打开与复核**：每一级用 `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` 打开，`fstat` 身份必须等于记录值；`lstat` 必须不是符号链接；`realpath(path)` 必须**严格等于**记录的路径（阻止“移出授权根再链接回来”）。
3. **读取**：`readOwnedFile` 用 `O_NOFOLLOW` 打开报告文件，`fstat` 校验普通文件、`nlink<=1`、大小，`realpath` 等于字面路径，读取后再次复核父目录身份。
4. **清理**：`removeOwnedDir` 先复核完整所有权链；只删除叶子目录里的**非目录**条目（逐条删除前重新复核父目录身份），最后 `rmdir`；遇到子目录、身份变化、真实路径漂移、目录非空 → **保守保留残留**，不递归跟随、不越界删除。没有所有权记录的计划一律不删。
5. **移除旧原语**：删除 `removeSafeSubtree`，避免生产路径再次使用“重新 realpath 可替换父路径”的写法；`persistence/files` 的允许引用清单相应减少一项（`vitest.ts` 不再引用）。

### 3.4 覆盖检查清单

| 复核要求 | 落点 | 验证 |
| :-- | :-- | :-- |
| 根目录与所有父目录身份 | `createOwnedDir` / `verifyOwnedDir` 的 chain | 单测 + P1 |
| 创建后父目录被替换 | `.studio` 符号链接（P1-A） | P1-A 通过 |
| 根目录被替换 | 同名新目录替换授权根 → `not_owned` | 单测「授权根被同名新目录替换」 |
| 文件描述符与实际文件身份 | `openDirIdentity` / `readOwnedFile` 的 fstat | 单测 + P1-D |
| 符号链接 | `O_NOFOLLOW`、`lstatIdentity`、realpath 严格相等 | P1-A/B/C/D |
| 硬链接 | 报告 `nlink>1` 拒绝 | 单测「报告文件是外部文件的硬链接」 |
| TOCTOU | 每次删除前重新复核直接父目录；读取时打开后、读取内容**前**复核父链（读取期间仍有理论窗口，不声称零 TOCTOU；LAST-DELTA 更正） | 设计约束 + 单测（残留窗口见 §10） |
| `.studio/tmp` | `runCheck` 前置 `assertSafeControlledDir(dir, '.studio/tmp')` 改为同一所有权实现 | 单测「.studio/tmp 是外部符号链接」 |
| 工作树外独立哨兵零污染 | 所有 P1 用例均断言外部哨兵/外部报告原样保留 | P1 4/4 |

### 3.5 新候选证据

```text
probes/new-candidate/p1-host-dir-safety.txt
 ✓ R3-01 探针 A：.studio 父目录被替换为指向外部目录的符号链接
 ✓ R3-01 探针 B：目录身份相同但路径已离开授权根（移动后符号链接指回）
 ✓ R3-01 探针 C：.studio/evidence 被替换为外部符号链接（R2 场景回归）
 ✓ R3-01 探针 D：报告文件被换成指向外部文件的符号链接 / 硬链接
 Tests  4 passed (4)
```

---

## 4. R3-02：真实统一裁决

### 4.1 旧候选真实复现（P2）

| 探针 | 场景 | 旧候选结果 |
| :-- | :-- | :-- |
| A | 真实落盘记录被改成：`verdict=passed` 但 `run.exitCode=1` | `verified`（错误） |
| B | `trust='weak'`（只有命令级观察） | `verified`（错误） |
| C | 报告 `integrity.ok=false` | `unverified`（本来就对，保留） |
| D | `verdict=failed` + 范围 `assessed_weakened` | `failed`（R2 失败优先保留） |
| E | 真实失败 + 重启深度复核 `evidenceInvalid` | `invalidated`（应为 `failed`） |
| F | `runProjectChecks` 无身份上下文（无任何宿主证据）的构建退出 0 | `kind='ran'`、`checked=true`（错误） |

> P2 的 A/B/E/F 都经过真实 `RecordStore` 落盘 + 关闭 + 重开，不是在内存里构造对象；A/B/E 的输入是**真实 Vitest 进程产生的证据**，测试只对“落盘后的记录”施加代表篡改/损坏/矛盾的修改。

### 4.2 修复设计

`src/core/evidence/adjudicate.ts` 重写裁决顺序（失败优先、归属优先、证据完整优先）：

1. 无证据 → `legacy_unverified`；
2. 归属不符（任务/轮次/检查项）→ `invalidated`（别的任务的“失败”不能借用）；
3. **失败事实优先**（`failureFactDetail`）：
   - `verdict=failed`；
   - `exitKind !== 'exited'`（超时/信号/无法启动）；
   - `exitCode === null` 或 `exitCode !== 0`（**与“通过”自述矛盾**）；
   - 报告 `counts.failed > 0`；
   → 一律 `failed`，即使同时存在验收版本变化、深度复核失效、`valid=false`、范围变化；
4. 其余身份不一致 / 深度复核 / 自标失效 → `invalidated`；
5. 范围削弱/变化且没有匹配的用户确认 → `unverified`（`test_scope_weakened` / `test_scope_changed`）；
6. 未执行 / 无结构化证据 → `not_checked` / `unverified`；
7. `verdict=passed`：**`trust` 必须是 `trusted`**；构建要求真实退出 0；测试要求报告存在、完整性通过、有实际执行文件、`total>0`、`failed=0`、`passed>0`；
8. 全部成立才 `verified`。

同时：

- `adjudicateStoredProof`：记录里的 `status='failed'` 视为失败事实；记录为 `unverified` 时，即使证据自称通过也**不得升级**为 verified；
- `adjudicateCheckResult`：没有宿主证据的“成功”一律 `unverified`；
- `runProjectChecks`：分类、`checked`、`passed/failed/unverified` 全部由 `adjudicateCheckResult` 得出，不再只看 `status`；
- `trialEvidenceInconsistency`：对“已验收证据”和“试检查结果”分别走统一裁决再比较（原验收 verified ⇒ 试检查必须 verified）；
- `evidenceSaveGate` / `save-rules`：本来就走 `adjudicateTaskEvidence`，本轮随裁决顺序修正自动收紧；
- `summarizeTrialChecks`：保存步骤文案改用 `hasTrustedBuildPass` / `hasTrustedTestPass`，不再凭 `status` 说“通过”。

### 4.3 新候选证据

```text
probes/new-candidate/p2-unified-adjudication.txt
 ✓ 证据自述 passed 但真实进程退出码非 0 → 不得判为 verified
 ✓ trust=weak → 不得 verified
 ✓ 完整性不成立 → 不得 verified
 ✓ 真实失败优先于范围待确认 → failed
 ✓ 重启深度复核失效 + 真实失败 → failed
 ✓ runProjectChecks 无宿主证据的“成功”不得 checked
 Tests  6 passed (6)
```

---

## 5. R3-03：实际执行范围绑定

### 5.1 旧候选真实复现（P3，真实 Vitest）

测试文件静态上永远有 2 条用例；其中一条是否注册取决于仓库根一个被 `.gitignore` 忽略的共享标记文件（`git rev-parse --git-common-dir` 定位，验收 worktree 与试合并 worktree 看到同一份）。因此**测试文件、配置、脚本、锁文件全部不变**。

- **A**：完整运行 → `counts.total=2`；加标记后再运行 → `counts.total=1`。旧候选：两次都是 `passed`，`scope.fingerprint` **完全相同**；`currentScopeFingerprint(dir, executedFiles, counts)` 也返回同一值（因为它完全忽略这两个参数）。
- **B**：验收（完整 2 条）→ 用户在验收页确认 → 加标记 → `saveTask`。旧候选：真实写入主项目，`saveRecord.checked === true`，把“覆盖率下降”的试检查记录成“检查通过”。

### 5.2 修复设计

把“静态范围”和“实际执行清单”明确拆成两个维度，并都绑定到用户确认：

1. **静态范围指纹**（`ConfigFingerprint` / `configFingerprintKey`）覆盖：有效测试配置、`pre/post` 脚本摘要、锁文件、运行器包、**运行器入口**（pathHash+sha256）、**可验证的直接依赖**（vite / @vitest/runner 的 version+package.json 摘要）、测试清单（路径+内容+测试块/断言/skip/only 计数）；
2. **实际执行清单**（`ExecutionManifest`，来自真实 Vitest JSON 报告）：
   - `files`：实际执行到的测试文件；
   - `perFile`：每个文件 total/passed/failed/skipped/todo；
   - `casesDigest`：对**全部**用例的 `(文件, 用例全名, 执行状态)` 规范排序后取 sha256；
   - `fingerprint`：`files + perFile + casesDigest + counts` 的摘要；
   - `cases` 只是最多 2000 条的样本，指纹不受截断影响；
3. **运行内对账**（`assessScopeChange`）：逐文件比较“静态可执行用例数（testBlocks - skipMarkers - todoMarkers）”与“报告实际执行条数”，少执行即 `assessed_needs_review`；运行期跳过数超过静态 skip 标记数时记录 `dynamicallySkipped`；
4. **用户确认绑定**：`scopeReview` 同时保存 `scopeFingerprint`（静态）与 `executionFingerprint`（实际执行）；确认前用 `currentScopeSnapshot` 同时核对两者，任一变化拒绝旧确认；
5. **保存前复核**：`runTrialChecks` 把 `expectedScopeFingerprint` 与 `expectedExecutionFingerprint` 一起传入；试合并的运行只要执行清单与确认时不同 → `assessed_needs_review`，`trialEvidenceInconsistency` 判不一致，**硬阻断保存**（不能靠“仍然保存”绕过）；
6. **兼容**：`currentScopeFingerprint(dir, executedFiles, counts, execution?)` 返回“静态 + 执行”的组合键；生产改用 `currentScopeSnapshot` 分别取两个维度。

### 5.3 新候选证据

```text
probes/new-candidate/p3-execution-scope.txt
 ✓ 完整运行 vs 动态少执行一条：可信结论与范围指纹都必须不同
 ✓ 验收完整运行 → 保存试检查时部分用例动态跳过 → 必须阻断可信保存
 Tests  2 passed (2)
```

新候选在 B 中的真实返回：`saveTask` `ok=false`，消息「合并后的检查结果与原验收证据不一致，本次没有保存。请重新检查后再保存。」，任务记录里**没有** `saveRecord`。

---

## 6. R3-04：Git 完整性与恢复

### 6.1 旧候选真实复现

探针 P4（真实 Git 仓库）：

| 用例 | 旧候选实际结果 |
| :-- | :-- |
| 文件 `star*.txt` 与 `starX.txt` 同时变化，查询 `star*.txt` | 返回 `['star*.txt','starX.txt']`（通配假阳性） |
| 文件 `q?.txt` 与 `qX.txt` 同时变化，查询 `q?.txt` | 返回 `['q?.txt','qX.txt']`（单字符通配假阳性） |
| 仓库根文件 `:magic.txt` 内容变化，查询 `:magic.txt` | 返回 `[]`（被当 pathspec magic，**静默漏检**） |
| 空格/引号/前导连字符/非 ASCII | 正确（保留） |
| 620 路径、长尾漂移（第 540 个） | 正确（R2 分批比较保留） |
| 真实保存包含 `[abc].txt` / `sp ace.txt` | 正确（保留） |

探针 P5-B：旧候选恢复分支把“第二个父提交是 taskCommit、但 tree 被改过”的合并提交（evil merge）当成保存结果，任务状态 `saved`。

### 6.2 修复设计

1. **字面路径语义**：`git()` 统一加 `--literal-pathspecs`（全局选项，先于子命令）。`diffTreePaths` 不再受 `*` / `?` / 前导 `:` 的 pathspec 语义影响；
2. **保存绑定 trialCommit**：`merge --ff-only trialCommit` 成功后断言 `HEAD === trialCommit`，否则立即停止并转人工处理（不写 `saveRecord`）；
3. **恢复绑定 trialCommit**：`inspectTask` 只有在 `HEAD === op.trialCommit` 时才返回 `save_merged`；HEAD 已前移（含 evil merge）→ `manual`；
4. **恢复身份核对**：`verifyMergeIdentity` 校验写入提交的 `first parent = op.preHead`、`second parent = op.taskCommit`、`merged === op.trialCommit`；
5. **恢复内容完整性**：恢复分支执行与正常保存相同的 `verifySavedTaskContent`（全量分批、字面路径、与 `acceptedTree` 逐字节一致），不一致 → 人工接管，不自动恢复、不覆盖其他提交；
6. **撤销前核实身份**：`undo` 在恢复前调用同一 `verifyMergeIdentity`；不匹配 → `undo_refused`；
7. **旧记录**：没有 `trialCommit` 的中断记录退回 `findMergeCommit`，但只接受“它仍是当前 HEAD”的情况，且同样做内容完整性验证。

### 6.3 新候选证据

```text
probes/new-candidate/p4-git-integrity.txt
 ✓ `star*.txt` 不得把 `starX.txt` 也算成它（通配假阳性）
 ✓ `q?.txt` 不得把 `qX.txt` 也算成它（单字符通配假阳性）
 ✓ 仓库根目录以冒号开头的文件名不得被当成 pathspec magic 而静默漏检
 ✓ 空格、引号、前导连字符、非 ASCII 文件名都按字面路径处理
 ✓ 超过 500 个路径的真实仓库：全量分批比较发现第 600 个之后的漂移
 ✓ 任务改动包含 `[abc].txt` 时，保存成功且内容完整
 Tests  6 passed (6)
```

---

## 7. R3-05：真实证据持久化验收

### 7.1 真实链路（不是手工对象）

探针 P5（`probes/r3-p5-child.mjs` + `p5-persistence-recovery.probe.ts`）：

1. 真实临时 Git 仓库 + 真实 Vitest（2 条用例）+ 620 个任务改动文件；
2. 子进程用 `TaskController` 真实执行：`create → savePlan → start → 验收 → confirmCriterion/ackDenied → saveTask`；
3. 父进程轮询主项目 `.git/refs/heads/main`，在 `--ff-only` 刚写入（ref 变化）的瞬间对子进程 **SIGKILL**；
4. 断言落盘事实：记录里 `op.phase === 'writing'`、**没有** `saveRecord`（证明中断发生在“合并已写入、保存记录尚未落盘”的真实窗口）；
5. 关闭记录库 → 重新打开（`lockWaitMs` 等待过期租约）→ `TaskRunner.reconcileTasks()`；
6. 读取恢复后的任务记录，核对真实试检查证据。

### 7.2 旧候选真实复现

- **P5-A（正常恢复）旧候选已通过**：R2 的 `OpLog.trialChecks` → 恢复分支 `saveRecord.trialChecks` 的确成立，本轮**保留**并不降低断言；
- **P5-B（evil merge）旧候选失败**：`expected 'saved' not to be 'saved'`。旧恢复分支没有做与正常保存一致的内容完整性验证，也没有把写入提交绑定到本次 `trialCommit`。

另外，旧候选的已保存记录展示（`saveChecksText`）只看 `checked` 与 `evidenceIds` 字符串，无法发现“试检查证据其实不可信”。

### 7.3 修复设计

1. 恢复分支重新用统一裁决处理 `op.trialChecks`（`adjudicateStoredProof`，按任务/轮次/检查项/失败事实/`trust`/完整性/范围）：
   - 全部 verified 才允许 `checked=true`；
   - 有证据但不可信 → `checked=false` + `uncheckedKind='unverified'`（绝不虚构通过）；
2. 恢复出的 `saveRecord` 记录 `trialCommit`，`mergeCommit = trialCommit`（真实写入身份）；
3. 恢复前完成与正常保存一致的**提交身份核对 + 内容完整性验证**（见 §6）；
4. 历史/保存记录展示统一走 `adjudicateSaveRecord` + `saveChecksTextFor`：
   - `checked` 且有 `trialChecks` → 必须全部 verified 才显示「检查通过」；
   - `checked` 但无结构化证据（旧记录）→「检查通过（历史记录未核实）」；
   - 证据不可信 → 不显示「检查通过」；
5. UI 三处（验收页保存记录、任务列表、保存历史）全部改为调用统一裁决。

### 7.4 新候选证据

```text
probes/new-candidate/p5-persistence-recovery.txt
 ✓ 重启恢复后 SaveRecord.trialChecks 携带真实试检查身份/被测 tree/执行结果/保存提交
     断言：trialChecks.length=1（只有 test）、checked=true、trialCommit===mergeCommit===op.trialCommit===HEAD、
           evidence.identity.testedTree===acceptedTree、acceptanceRev 一致、
           report.counts.total=2、integrity.ok=true
 ✓ 恢复不得把内容漂移的合并提交当成保存结果
     evil merge（第二父提交正确、tree 被改）→ state !== 'saved'，manualReview 已置位
 Tests  2 passed (2)
```

---

## 8. 最终门禁

### 8.1 类型检查

```bash
npx tsc -p tsconfig.json --noEmit   # exit 0，0 error
```

证据：`gates/typecheck.txt`

### 8.2 生产构建

```bash
npm run build   # tsc -p tsconfig.build.json && vite build
```

证据：`gates/build-core.txt`、`gates/build-renderer.txt`（`✓ built in 632ms`，exit 0）

### 8.3 全量单测（含新增回归测试）

```bash
npx vitest run
```

```text
 Test Files  52 passed | 12 skipped (64)
      Tests  763 passed | 38 skipped (801)
   Duration  116.32s
```

证据：`gates/full-suite.txt`（0 failed；新增 `tests/r3-trusted-evidence.test.ts` 24 项全绿）

### 8.4 Electron E2E

```bash
npx vitest run -c vitest.e2e.config.ts
```

```text
 Test Files  1 passed (1)
      Tests  56 passed (56)
   Duration  533.07s
```

证据：`gates/electron-e2e.txt`
说明：E2E 会重写 `docs/screenshots/stage9-webcodex/*.png`；这些是测试副作用，已 `git checkout` 还原，未进入本轮提交。

### 8.5 标准 Seatbelt 沙箱 25 项样本项目

```bash
A1_WORKTREE=/Users/jamesho/ai-solo-studio-a1-r3 \
  node docs/reviews/AISS-A1-TRUSTED-EVIDENCE-R1-001/repro/real-project-sandbox-verify.mjs
```

```text
{"event":"acceptance","buildStatus":"passed","testStatus":"passed","counts":{"total":25,"passed":25,"failed":0,"skipped":0},
 "executedFiles":["tests/dates.test.ts","tests/math.test.ts","tests/slug.test.ts","tests/store.test.ts","tests/text.test.ts"],
 "integrity":{"ok":true,...},"scope":"assessed_unchanged","items":[["build","verified"],["test","verified"]]}
{"event":"save","ok":true,"outcome":"saved",...}
{"event":"undone","treeUndone":"63b6b19a...","treeBefore":"63b6b19a...","markerGone":true}
{"event":"done","result":"A1_R1_STANDARD_SANDBOX_FULL_PROJECT_VERIFICATION_OK"}
```

证据：`gates/seatbelt-25-sample.txt`（保存提交 `07d45c13...`，撤销后 tree 与保存前严格一致）

### 8.6 原主工作区保护核验

交付后重新计算 8 个文件 sha256，与 §1.2 快照**逐字一致**；主工作区 `git status` 仍是原来的 5 M + 3 ??，HEAD 仍为 `8dfcfc19`。

证据：`workspace-protection-before.txt`、`workspace-protection-after.txt`。

### 8.7 PR exact-HEAD CI（Ubuntu + macOS）

CI 工作流 `.github/workflows/ci.yml`：`ubuntu-latest` 与 `macos-latest` 两个矩阵，均执行 `npm ci → typecheck → npm test → npm run build`；macOS 额外安装 Electron 二进制并运行 `npx vitest run -c vitest.e2e.config.ts`。

- 代码提交：`13edb62cb4d2546c1430f70aa5f520ca3424cdc6`
- Run：`45394120031` — https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/45394120031
- 结果：**conclusion=success**
  - `test (ubuntu-latest)`：success（12:30:15Z → 12:32:10Z）。步骤：npm ci / typecheck / npm test / build 全部 success；Electron 步骤按工作流条件 skipped。
  - `test (macos-latest)`：success（12:30:15Z → 12:42:46Z）。步骤：npm ci / typecheck / npm test / build / Install Electron binary / **Electron end-to-end** 全部 success。
- 证据：`gates/ci-13edb62.json`（完整 run + 每个 step 的 conclusion）

- 报告提交（docs-only）：`9c4d163f22647cdf4d024841b479968181bec596`
- Run：`45396298686` — https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/45396298686
- 结果：**conclusion=success**
  - `test (ubuntu-latest)`：success（2m3s）
  - `test (macos-latest)`：success（9m35s，含 Electron E2E）
- 证据：`gates/ci-13edb62.json` 与 PR #7 checks（exact HEAD `9c4d163`）

> 后续若再有 docs-only 提交，CI 会以同一矩阵再次运行；最终回执记录最后 HEAD 的结果。

### 8.8 远程证据逐文件读取与指纹核验

对代码提交 `13edb62cb4d2546c1430f70aa5f520ca3424cdc6` 的**全部 43 个改动文件**逐个从 GitHub 读取内容（`repos/.../contents/<path>?ref=<sha>`），与本地 `git show <sha>:<path>` 的 sha256 逐一比对：

```text
MATCH  SHA256                                                            PATH
OK     5e37d8cf...  tests/r3-trusted-evidence.test.ts
...
43 行 OK，mismatch=0
```

证据：`gates/remote-fingerprints.txt`（每行一个文件，含 MATCH 与 sha256）。

---

## 9. 与既有测试的关系（透明记录）

本轮**没有删除任何既有测试，也没有降低断言**。为对齐新的真实语义，调整了 3 个既有测试文件中的 4 处：

| 文件 | 调整 | 原因 | 断言强度 |
| :-- | :-- | :-- | :-- |
| `tests/r2-trusted-evidence.test.ts` | 错误文案正则 `/包含符号链接/` → `/符号链接/` | 新实现的错误文案是「受控路径是符号链接」；仍然要求**必须抛出包含“符号链接”的错误** | 不降低 |
| `tests/r2-trusted-evidence.test.ts` | 用例标题去掉 `removeSafeSubtree` | 该原语已被删除（见 §3.3），改由 `owned-dir` 统一约束 | 不降低 |
| `tests/save-safety.test.ts` | 3 处 `runProjectChecks` 调用补上真实 `identity` 上下文 | 统一裁决要求“通过必须有宿主证据”；补上身份后，原有 `kind/summary/checked/unverified/failed` 断言**逐字不变**，且更接近生产调用 | 不降低 |
| `tests/security.test.ts` | ADR 0006 允许引用 `persistence/files` 的清单减少一项（`vitest.ts`） | `vitest.ts` 不再使用旧的 `removeSafeSubtree`；清单规则仍是“只许减少”，并保留反例样本 | 不降低 |

新增：

- `tests/r3-trusted-evidence.test.ts`（24 项快速回归，默认套件必跑）；
- `tests/r3-probes/*.probe.ts`（20 项真实对照探针，独立配置运行，见 §2.1）；
- `vitest.probes.config.ts`。

---

## 10. 未完成 / 开放项（如实记录）

1. **Node 没有 `unlinkat`/`rmdirat`**：`removeOwnedDir` 在“最后一级父目录复核 → unlink”之间仍有一个极短路径解析窗口。实现把窗口压到最小（每次删除前重新复核直接父目录身份，绝不递归、绝不删除子目录/未知条目），并在任何异常时保守保留残留。这一残留窗口已在 `owned-dir.ts` 头部如实声明，未声称“零 TOCTOU”。
2. **`.studio/tmp` 没有被递归清理**：本轮只把它的**创建与使用**纳入所有权校验（`assertSafeControlledDir`），没有新增递归清理逻辑；因此不存在“清理 tmp 越界”的入口。
3. **标准 Seatbelt 模式的断网/端口限制**：沿用 R1 的 OPEN 登记（本仓库自身测试需要监听端口，因此 25 项样本项目用于沙箱实机验证）。本轮未扩大沙箱权限。
4. **P5 的中断点通过父进程轮询主项目 ref 触发 SIGKILL**，没有在产品代码里加入测试专用钩子；断言以落盘状态 `op.phase='writing'` 且无 `saveRecord` 证明中断发生在真实窗口。该方式依赖轮询时序，因此在子进程侧用 620 个改动文件把窗口拉宽；如果未来机器慢到子进程在 kill 前完成，探针会显式失败而不是误报通过。
5. **Windows 未验证**：本轮门禁按任务要求覆盖 macOS 本地 + Ubuntu/macOS CI；Windows 不在范围内。
6. **Electron E2E 截图副作用**：E2E 会重写 `docs/screenshots/stage9-webcodex/*.png`，已在提交前还原；CI 中同样会产生工作区改动，但不影响测试结论。
7. **探针不进入默认 `npm test`**：P5 需要 `dist-electron` 且耗时较长，放进默认套件会让 CI 隐式依赖构建顺序；因此用独立 `vitest.probes.config.ts`，默认套件保留 24 项快速回归。

---

## 11. 附录

### 11.1 本轮产品代码改动

| 文件 | 改动 |
| :-- | :-- |
| `src/core/persistence/owned-dir.ts` | **新增**：创建时所有权、身份/真实路径复核、`O_NOFOLLOW` 读取、保守清理 |
| `src/core/persistence/files.ts` | 删除不安全的 `removeSafeSubtree` |
| `src/core/evidence/vitest.ts` | 使用 `owned-dir`；报告读取走 fd 身份；执行清单提取 |
| `src/core/evidence/adjudicate.ts` | 失败优先顺序、失败事实、trust、存储状态、保存记录裁决 |
| `src/core/evidence/model.ts` | `ExecutionManifest`、`ScopeAssessment.executionFingerprint`、配置键补运行器入口/依赖 |
| `src/core/evidence/inventory.ts` | 静态 vs 执行指纹、逐文件用例对账、组合指纹 |
| `src/core/checks/scripts.ts` | `runProjectChecks` 消费统一裁决；`assessTestScope` 绑定执行清单；`currentScopeSnapshot` |
| `src/core/git/git.ts` | `--literal-pathspecs` |
| `src/core/task/runner.ts` | 确认绑定执行清单、试检查裁决、保存绑定 trialCommit、恢复身份+内容验证、撤销身份、保存文案 |
| `src/core/task/model.ts` | `scopeReview.executionFingerprint` |
| `src/core/acceptance/{verdict,view,history}.ts`、`src/core/app/{task-view,task-state-view}.ts` | 历史/保存记录展示统一裁决 |

### 11.2 复现命令汇总

```bash
# 环境
cd /Users/jamesho/ai-solo-studio-a1-r3
ln -s /Users/jamesho/ai-solo-studio-a1/node_modules node_modules   # 复用已安装依赖

# 本地门禁
npx tsc -p tsconfig.json --noEmit
npm run build
npx vitest run
npx vitest run -c vitest.e2e.config.ts
A1_WORKTREE=$PWD node docs/reviews/AISS-A1-TRUSTED-EVIDENCE-R1-001/repro/real-project-sandbox-verify.mjs

# R3 探针（旧/新同一组）
npm run build:core
npx vitest run -c vitest.probes.config.ts
# 旧候选：在临时对照工作树（detached 9d1533f，验证后已移除，可按 §1.1 重建）重复以上两步
```

### 11.3 证据索引

```text
docs/reviews/
├── AISS-A1-TRUSTED-EVIDENCE-R3-INDEPENDENT-REMEDIATION-001.md   # 本报告（唯一权威）
└── AISS-A1-TRUSTED-EVIDENCE-R3-INDEPENDENT-REMEDIATION-001/    # 证据目录
    ├── README.md                          # 证据目录索引
    ├── workspace-protection-before.txt
    ├── workspace-protection-after.txt
    ├── gates/
    │   ├── typecheck.txt
    │   ├── build-core.txt
    │   ├── build-renderer.txt
    │   ├── full-suite.txt
    │   ├── electron-e2e.txt
    │   ├── seatbelt-25-sample.txt
    │   ├── ci-13edb62.json
    │   └── remote-fingerprints.txt
    └── probes/
        ├── r3-p5-child.mjs
        ├── old-candidate/p{1..5}-*.txt
        └── new-candidate/p{1..5}-*.txt
```

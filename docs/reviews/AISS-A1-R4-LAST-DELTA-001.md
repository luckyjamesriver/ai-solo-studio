# AISS-A1-R4-LAST-DELTA-001

- **任务定位**：A1 R4 最后一次限定范围的差异收尾（不启动 R5、不重设计 A1）
- **BASE_HEAD**：`3d70bda2bee70f190f7eeba9106fa4e05affcc51`
- **本轮代码提交（exact HEAD）**：`ef6700575a1e36363a69300d7cb6db5c426a827c`
- **PR**：#7 `feat/aiss-a1-trusted-evidence-001` → `rebuild`（保留，不合并）
- **目标状态**：`AISS_A1_LAST_DELTA_READY_FOR_MERGE_REVIEW`

> 本报告只记录本轮差异、反向探针、修复结果、完整 HEAD、CI 身份与剩余风险；前四轮完整报告不作重复。

---

## 0. 本轮核销表

| 本轮要求 | 旧候选 `3d70bda` 真实反例 | 新候选 `ef67005` 同一探针 | 结论 |
| :-- | :-- | :-- | :-- |
| **§1 保存证据集合完整性** | P11（历史）：部分证据丢失、evidenceId 错配、副本身份错配、缺项+重复，**仍 `verified`/“检查通过”**；P12（SIGKILL 恢复）：三种破坏均 `checked=true` | P11 **1/1**、P12 **3/3** 通过：统一证据集合校验拒绝；缺必要绑定的旧记录降级为“历史记录未核实” | 已关闭 |
| **§2 统一裁决失败优先** | P13：证据显示已尝试且失败（spawn_error / 非零退出），但外围 `status=not_available` → 被降级为 `not_checked` | P13 **1/1** 通过：真实未执行 → `not_checked`；真实启动失败/非零退出 → `failed`（即使外围状态矛盾） | 已关闭 |
| **§3.1 完整用例名参与哈希** | P14：前 300 字符相同、尾部不同的参数化用例，试检查仍被当作与验收一致并保存 | P14 **1/1** 通过：完整名称参与 `casesDigest`，试检查被阻断 | 已关闭 |
| **§3.2 确认后重新执行缺证据** | P15：重新执行时沙箱不可用（无执行清单），旧指纹回填并登记 `confirmedAt` | P15 **1/1** 通过：保持待确认，`ok=false` | 已关闭 |
| **§4 非阻断收尾** | — | 已更正 R3/R4 报告中“读取后再复核”“报告目录数量有界”的不准确描述；保留 33 项探针并把新增 7 项纳入同一 probes CI；未重新引入主动删除、未扩大沙箱权限、未做原生模块研究 | 已关闭 |

### 同一组探针（本轮新增 7 项）

| 探针 | 旧候选 `3d70bda` | 新候选 `ef67005` |
| :-- | :-- | :-- |
| P11 证据集合（历史） | **1 failed** | **1 passed** |
| P12 证据集合（SIGKILL 恢复） | **3 failed** | **3 passed** |
| P13 失败优先 | **1 failed** | **1 passed** |
| P14 用例名尾部 | **1 failed** | **1 passed** |
| P15 确认后缺证据 | **1 failed** | **1 passed** |
| 既有 R3/R4 探针（33 项） | 33 passed | 33 passed |
| **合计（40 项）** | **7 failed / 33 passed** | **40 passed** |

旧候选失败原文：

```text
P11: expected 'verified' not to be 'verified'           （部分证据丢失后仍可信通过）
P12: expected true not to be true (×3)                  （恢复后 checked=true）
P13: expected 'not_checked' to be 'failed'              （真实失败被 not_available 降级）
P14: expected true to be false                          （截断后哈希相同，保存成功）
P15: expected true to be false                          （缺新证据仍 confirmedAt）
```

证据：
`probes/old-candidate/p{11..15}-*.txt`、`probes/new-candidate/p{11..15}-*.txt`、
`probes/new-candidate/all-probes.txt`（40/40）。

---

## 1. §1 保存证据集合完整性

### 1.1 唯一校验入口

新增 `adjudicateTrialEvidenceSet`（`src/core/evidence/adjudicate.ts`），正常保存、启动恢复、历史展示共同消费：

- `trialCommit` / `mergeCommit` 必须为 40 位提交号且二者相等；
- `trialCommitTree` 必须存在，且每条证据的 `identity.testedTree` 与它一致；
- `projectRootHash` / `trialWorktreePathHash` 必须与每条证据的 `projectRootHash` / `worktreePathHash` 一致；
- `taskId` / `round` / `acceptanceRev` 与证据身份一致；
- `evidenceIds` 必须与每条证据的 `identity.evidenceId` 一一相等，且不含应执行集合之外的多余项；
- **应执行检查项集合 = 实际证据集合**：不缺项、不重复、不越项、不错配；
- 每条证据仍走统一裁决（`adjudicateStoredProof`）判断 failed / verified；
- 缺少必要身份绑定（旧记录）→ `legacy_unverified`，显式降级，不补造。

### 1.2 接入点

| 场景 | 接入 | 结果 |
| :-- | :-- | :-- |
| 正常保存 | `TaskRunner.doSave`：声明集合取 `detectScripts(trialPath)`；`checkedFinal = checked && set.ok` | 证据集合不完整 → `checked=false` |
| 保存持久化 | `SaveRecord.expectedChecks`、`OpLog.expectedChecks` 随记录落盘 | 恢复/历史可复核 |
| 启动恢复 | `reconcileTasks` 的 `save_merged`：用 `op.trialChecks` + `op.expectedChecks` + `op.trialEvidenceIds` + `treeOf(merged)` 走同一入口 | 任一破坏 → `checked=false` |
| 历史展示 | `adjudicateSaveRecord` → `adjudicateTrialEvidenceSet` | 破坏/旧记录 → 非“检查通过” |

### 1.3 真实探针

- **P11（历史）**：真实保存（build + 真实 Vitest test 均通过）后，通过真实 `TaskStore` 落盘四种破坏：
  1. 删除 test 证据（部分丢失）；
  2. `evidenceIds.test` 改成错误 ID；
  3. test 证据的 `worktreePathHash` 改成别的副本；
  4. 用重复 build 顶替 test（缺项+重复）。
  旧候选全部仍 `verified`；新候选全部非 verified。
- **P12（SIGKILL 恢复）**：真实子进程保存 → 主进程在写入瞬间 SIGKILL → 在真实记录库上分别施加上述 1/2/3，再 `reconcileTasks`。旧候选 `checked=true`；新候选 `checked=false`。

---

## 2. §2 统一裁决失败优先

`adjudicateStoredProof` / `adjudicateCheckResult` 改为**有宿主证据时以证据为准**：

- 证据显示 `attempted=true` 且失败（spawn_error / 非零退出 / verdict=failed / 报告失败）→ `failed`，不再被外围 `status=not_available` 降级；
- 真实未执行（`attempted=false`）→ `not_checked`；
- 证据显示成功但外围状态矛盾（如记录为未检查/未核实）→ 不升级为 verified；
- 无宿主证据时才退回 status 语义（旧记录）。

P13 用真实 `runCheck` 覆盖三种情形：真实未执行、真实启动失败、真实非零退出；并把失败证据挂到 `status='not_available'` 的 proof/result 上验证失败优先。

---

## 3. §3 两项局部修订

### 3.1 完整用例名参与执行清单哈希

`buildExecutionManifest`（`src/core/evidence/vitest.ts`）：

- `casesDigest` 使用**完整** `fullName`（或 `title`）；
- 只有 `cases` 展示样本截断到 300 字符。

P14：两个参数化用例名称前缀 320+ 字符相同、仅尾部不同。旧候选截断后 `casesDigest` 相同 → 保存成功；新候选完整名称不同 → 执行指纹不同 → 硬阻断。

### 3.2 确认后重新执行缺少有效新证据

`TaskRunner.confirmScopeChange`：

- 重新执行后必须拿到有效的 test 证据、静态范围指纹与**实际执行清单指纹**；
- 任一缺失或与用户查看时的快照不一致 → 保持待确认（`confirmedAt` 不写），抛错返回 `ok=false`；
- 不再用确认前的旧指纹回填。

P15：验收 2 条用例后进入待确认；用户确认时第二次检查的沙箱不可用（`not_available`、无执行清单）。旧候选回填旧指纹并 `confirmedAt`；新候选保持待确认。

---

## 4. §4 非阻断收尾

- **报告更正**：
  - R3/R4 报告中的“读取后再复核父目录身份”改为准确表述：打开后、**读取内容前**复核父链；读取内容期间仍有理论窗口，不声称零 TOCTOU；
  - R4 报告补充更正：报告目录数量**不是严格有界**——同一任务副本内按检查次数增长、不设上限，只是随任务副本生命周期回收；
- **方案边界**：保守保留方案已被接受，本轮未重新引入主动删除、未扩大沙箱权限、未开展原生模块研究；
- **探针与 CI**：既有 33 项探针全部保留，新增 7 项纳入同一 `tests/r4-probes/` 与现有 `probes` CI job（Ubuntu + macOS），总 40 项。

---

## 5. 门禁（本轮代码提交 `ef67005`）

| 门禁 | 结果 | 证据 |
| :-- | :-- | :-- |
| typecheck | exit 0 | `gates/typecheck.txt` |
| build（core + renderer） | exit 0 | `gates/build-core.txt`、`gates/build-renderer.txt` |
| 全量单测 | **773 passed / 38 skipped / 0 failed（811）** | `gates/full-suite.txt` |
| Electron E2E | **56 passed** | `gates/electron-e2e.txt` |
| 标准 Seatbelt 25 项真实项目 | **25/25，build passed，save/undo tree 一致**（`A1_R1_STANDARD_SANDBOX_FULL_PROJECT_VERIFICATION_OK`） | `gates/seatbelt-25-sample.txt` |
| 真实反向探针 | **40 passed**（33 既有 + 7 新增） | `gates/probes.txt` / `probes/new-candidate/all-probes.txt` |
| exact-HEAD CI（Ubuntu + macOS，test + probes） | **Run `45435817397`：4/4 job success** | `gates/ci-ef67005.json` |
| 远程证据逐文件核验 | **11/11 文件 sha256 一致** | `gates/remote-fingerprints.txt` |
| 原主工作区保护 | 8 个在研文件 sha256 与基线一致；HEAD 仍 `8dfcfc19` | `workspace-protection-before.txt` / `workspace-protection-after.txt` |

### 5.1 CI 身份与重跑说明

- 代码提交 `ef67005`，Run `45435817397` — https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/45435817397
  - `test (ubuntu-latest)`：success（16:19:42Z → 16:21:42Z）
  - `test (macos-latest)`：success（16:45:04Z → 16:57:59Z，含 Electron E2E）
  - `probes (ubuntu-latest)`：success（16:19:41Z → 16:20:27Z，40 项探针）
  - `probes (macos-latest)`：success（16:40:04Z → 16:42:00Z）
- 首次触发时两个 macOS job 在**任何 step 开始前**被 GitHub 侧取消（`steps: []`，排队约 15 分钟后 `cancelled`），Ubuntu 两 job 已 success；随后 `gh run rerun --failed` 重跑 macOS 两 job，均 success。这是 runner 容量/排队问题，不是代码失败；最终结论以重跑后的同一 run 为准。

### 5.2 远程证据

对代码提交 `ef67005` 的全部 **11 个改动文件**逐个从 GitHub 读取并与本地 `git show` 的 sha256 比对：**checked=11，mismatch=0**。

---

## 6. 索引状态（如实登记）

| 工具 | 本轮状态 |
| :-- | :-- |
| `code-review-graph 2.4.0` | 在 BASE_HEAD `3d70bda` 上已有索引（261 文件 / 3616 节点 / 55291 边）；本轮提交后执行 `update` 对齐（状态见 `gates/code-review-graph-status.txt`）。索引在 `.code-review-graph/`，被 `.gitignore` 排除。 |
| `graphify 0.9.113` | 本仓库没有已提交的语义图；先前 `update . --no-cluster` 只得到 AST 抽取（约 3399 节点、**0 条语义边**，未运行 LLM 边抽取）。本轮不把 AST 抽取冒充语义索引完成；`graphify-out/` 不入库。 |

---

## 7. 清理

- 旧候选对照工作树 `/Users/jamesho/ai-solo-studio-lastdelta-old` 在证据落盘后移除；
- E2E 会重写 `docs/screenshots/stage9-webcodex/*.png`，已在提交前还原；
- 探针临时目录由测试清理；`RecordStore` 均关闭；
- 所有活跃工作树（主工作区、A0、Cursor A1、本轮接管）保留，未合并代码保留。

---

## 8. 剩余风险

1. 报告目录保守保留：同一任务副本内按检查次数增长、不设上限（随副本回收）；这是已接受的方案。
2. 标准 Seatbelt 断网/端口限制沿用 R1 的 OPEN 登记；本轮未扩大沙箱权限。
3. CRG/Graphify 是本地索引，不参与 CI；Graphify 语义边未生成。
4. `full_trust` 模式下执行体与用户同权限；保守保留不新增删除面，但不构成对同权限攻击的隔离保证。
5. Windows 未验证（门禁为 macOS 本地 + Ubuntu/macOS CI）。
6. 历史轮次缺少 `acceptanceRev` 时只允许跳过该一项；版本/树/项目/副本/试合并提交仍强制核对。

---

## 9. 证据索引

```text
docs/reviews/
├── AISS-A1-R4-LAST-DELTA-001.md          # 本报告
└── AISS-A1-LAST-DELTA-001/
    ├── gates/
    │   ├── typecheck.txt
    │   ├── build-core.txt
    │   ├── build-renderer.txt
    │   ├── full-suite.txt
    │   ├── electron-e2e.txt
    │   ├── seatbelt-25-sample.txt
    │   ├── probes.txt
    │   ├── ci-ef67005.json
    │   ├── remote-fingerprints.txt
    │   └── code-review-graph-status.txt
    ├── probes/
    │   ├── old-candidate/p{11..15}-*.txt
    │   └── new-candidate/p{11..15}-*.txt + all-probes.txt
    ├── workspace-protection-before.txt
    └── workspace-protection-after.txt
```

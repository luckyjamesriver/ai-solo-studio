# AISS-A1-PREMERGE-GATE-CLOSEOUT-001

- **任务编号**：`AISS-A1-PREMERGE-GATE-CLOSEOUT-001`
- **BASE / 旧候选**：`2dff160023da920f84ac3c5c45bde0a1fd64edcf`
- **本轮代码提交（新候选）**：`a739d024233cd0a099ab63ef2b1cbceddcd38db1`
- **PR**：#7 `feat/aiss-a1-trusted-evidence-001` → `rebuild`（**保持 OPEN，不合并**）
- **性质**：只做独立复核提出的两处限定边界修订；**不是 R5，不重写 A1，不启动新一轮全面审计**；此前已核销事项与已接受风险不重新打开
- **结果状态**：`AISS_A1_PREMERGE_GATE_READY_FOR_APPROVAL`

---

## 0. 核销表

| 修订 | 旧候选 `2dff160` 真实反例 | 新候选 `a739d02` 同一探针 | 结论 |
| :-- | :-- | :-- | :-- |
| **修订一：证据集合裁决前移到主项目写入之前** | P16（正常保存入口）：试检查通过后、写入前把试合并副本的真实路径身份改掉 → 旧候选**先把 `merge --ff-only` 写进主项目**（HEAD `34088abd…` → `0a8c2768…`），之后集合裁决才失败，结果被静默降级为“未检查”，而调用方**从未做过未检查确认**。P17（用户已确认未检查）：`saveUncheckedTask` 同样照样写入主项目（HEAD `491bd512…` → `6dca6426…`）。 | P16 **1/1 通过**：集合裁决在写入前执行，保存被 `evidence_invalid` 阻断；**HEAD / tree / 工作区完全不变**，不落 `saveRecord`。P17 **1/1 通过**：身份失效是硬阻断，`confirmUnchecked` 不能绕过，主项目保持原样。 | 已关闭 |
| **修订二：确认重跑必须取得有效的新证据** | P18（真实 Vitest）：用户确认后重跑的执行清单与查看时**完全相同**，但 stdout 摘要缺失 / 与报告不一致 → `report.integrity.ok=false`。旧候选只比较“evidence/静态指纹/执行指纹存在且相等”，于是 `ok=true` 并把 `confirmedAt` 落盘，自动解除范围门禁。 | P18 **2/2 反向通过**：`ok=false`，保持待确认（`confirmedAt` 不写），范围门禁继续阻断 `saveTask`。P18 **1/1 正向通过**：正常有效重跑仍然可以确认。 | 已关闭 |

### 同一组探针总对照

| 探针 | 旧候选 `2dff160` | 新候选 `a739d02` |
| :-- | :-- | :-- |
| P16 集合裁决必须在写入前（正常保存入口） | **failed**（主项目 HEAD 被改写） | **passed** |
| P17 未检查确认不得绕过硬阻断 | **failed**（主项目 HEAD 被改写） | **passed** |
| P18 重跑 stdout 摘要缺失 | **failed**（`confirmedAt` 落盘） | **passed** |
| P18 重跑 stdout 摘要不一致 | **failed**（`confirmedAt` 落盘） | **passed** |
| P18 正向：正常有效重跑 | passed | **passed** |
| 既有 40 项反向探针（R3 + R4） | 40 passed（本轮未改） | **40 passed** |
| **合计** | 新增 5 项：**4 failed / 1 passed** | **45 passed** |

旧候选失败原文（同一探针源码，旧候选源码未改）：

```text
P16: expected '0a8c27681e6681e9f04ee42d91c430539df4f…' to be '34088abdcadbe4317fe2f6c4f6a355d34a3a2…'
     （旧候选先写入主项目：HEAD 已从保存前 34088abd 变为 0a8c2768）
P17: expected '6dca64267b4b85d7327b284b19d7792f94c64…' to be '491bd512c02f0cc65792a5538b2f45306fe37…'
     （confirmUnchecked 也照样写入主项目：HEAD 491bd512 → 6dca6426）
P18: expected true to be false ×2   （旧候选 ok=true 且 confirmedAt 落盘）
```

证据：`probes/old-candidate/new-probes.txt`、`probes/new-candidate/new-probes.txt`、`probes/new-candidate/all-probes.txt`（45/45）。

---

## 1. 修订一：证据集合裁决前移到主项目写入之前

### 1.1 源码事实（旧候选）

`TaskRunner.doSave` 的顺序是：试合并（临时 worktree）→ 试检查 → 写入前核对 → **`git merge --ff-only trialCommit` 写入主项目** → 核对 `mergeCommit === trialCommit` → 内容漂移核对 → **最后**才调用 `adjudicateTrialEvidenceSet`。

后果：集合裁决失败时主项目已经被改写，`checkedFinal = checked && setCheck.ok` 只是把保存记录降级为“未检查”，既不恢复主项目，也不要求用户确认；而“未检查保存必须由用户明确确认”是既定门禁。

### 1.2 修订内容

1. **前移**：在写入前核对通过之后、`git merge --ff-only` 之前调用同一个 `adjudicateTrialEvidenceSet`；写入前以“即将写入的 `trialCommit`”作为期望的 merge 身份。
2. **硬阻断**：
   - `status === 'failed'`（真实失败）或 `status === 'invalidated'`（身份/集合失效）→ 直接阻断，**即使调用方带 `confirmUnchecked` 也不放行**；
   - `checked === true` 但集合裁决 `!ok`（缺项/重复/evidenceId 或提交绑定不一致）→ 直接阻断，不再“无条件保存后降级”。
3. **合法的未检查保存不变**：`checked === false` 且集合只是 `legacy_unverified` / `unverified`（证据缺项但身份自洽）时，仍由原有“用户明确确认未检查”的流程放行，不新增平行放行/阻断逻辑。
4. **写入后继续核对身份**：`mergeCommit !== trialCommit` 的原检查保持不变（仍转入人工接管）；集合裁决结果用于落盘，`SaveRecord`/`OpLog`/启动恢复仍消费同一个 `adjudicateTrialEvidenceSet`，未新增第二套裁决。
5. **失败语义**：返回 `evidence_invalid`（固定文案：证据失效，请重新检查后再保存），落 `lastSave.reason='failed'`，任务留在验收阶段，不产生 `saveRecord`。

### 1.3 反向探针（真实 Git + 真实 Vitest + 正常保存入口）

- **P16**：真实项目验收（build/test 均 `verified`）→ 用户逐条确认 → 正常 `saveTask`（无任何未检查确认）。在保存进度“写入前再确认一次”时刻，用同步回调把隐藏的试合并副本目录移走并在原路径放一个指向新位置的符号链接（真实宿主路径身份的 TOCTOU 变化）。
  - 断言：保存必须失败；**主项目 HEAD、`HEAD^{tree}`、`git status --porcelain` 与保存前完全一致**；不产生 `saveRecord`、任务不是 `saved`。
- **P17**：受限检查不可用 → 第一次 `saveTask` 返回 `unchecked_needs_confirm` → 用户明确 `saveUncheckedTask`。在同样的写入前时刻改掉副本身份。
  - 断言：`confirmUnchecked` 不能绕过身份失效；主项目完全不变、不产生 `saveRecord`。

> 说明（如实）：当试检查结果内部自洽时，集合裁决的字段（trialCommit/tree/evidenceId/集合）都由同一次运行派生，正常路径不会自发不一致。因此本探针用“保存窗口内外宿主路径身份被改变”这一真实 TOCTOU 条件触发集合失败，验证的是**时序性质**：集合裁决失败决不能发生在主项目写入之后。这不是重写 A1，也没有新增裁决系统。

---

## 2. 修订二：确认重跑必须取得有效的新证据

### 2.1 源码事实（旧候选）

`TaskRunner.confirmScopeChange` 重新执行检查后，只用 `evidence` 对象、`scope.fingerprint`、`scope.executionFingerprint` 是否**存在且与用户查看时相等**来认定重跑有效；这些字段存在但报告完整性（stdout 交叉核对）失败时，仍会写入 `confirmedAt`，自动解除范围门禁。

### 2.2 修订内容

- 重跑得到的 test 证据必须通过与保存门禁**完全相同的统一裁决** `adjudicateTaskEvidence`（失败优先、任务/轮次/验收版本/项目/副本身份、报告完整性、stdout 交叉核对、范围确认），且结论必须是 `verified`；
- 不满足 → 保持待确认：不写 `confirmedAt`，生成新的待确认 `scopeReview`（记录原因与新的指纹/版本），抛出固定错误（`ok=false`）；
- 范围确认不替代自动测试结果裁决：保存侧门禁（`saveBlockerCodes` / `adjudicateTaskEvidence`）未改，真实失败仍独立判 `test_failed` 阻断保存；
- 正常有效重跑仍可确认（正向用例保留）。

### 2.3 反向探针（真实 Vitest + 生产确认流程）

- 项目：执行体改写已有测试文件 → 静态范围进入待确认，执行清单完整；
- 用户查看后点击确认 → 宿主用真实 Vitest 重新执行，**执行清单（文件/用例/状态）与查看时完全相同**；
- 仅把沙箱返回的 stdout 摘要去掉 / 改成与报告不同的计数 → `buildReportEvidence` 判定交叉核对未发生/不一致，`report.integrity.ok=false`；
- 断言（反向 2 项）：`confirmScopeChange` 返回 `ok=false`；`scopeReview.confirmedAt` 为空；视图仍显示范围待确认；随后的 `saveTask` 仍被范围门禁阻断；
- 断言（正向 1 项）：同样的真实流程、stdout 正常时 `ok=true` 且 `confirmedAt` 落盘，避免把合法确认一并禁用。

---

## 3. 本机最终门禁（代码提交 `a739d02`）

| 门禁 | 结果 | 证据 |
| :-- | :-- | :-- |
| typecheck | exit 0 | `gates/typecheck.txt` |
| build（core + renderer） | exit 0 | `gates/build-core.txt`、`gates/build-renderer.txt` |
| 全量单测 | **773 passed / 38 skipped / 0 failed（811）** | `gates/full-suite.txt` |
| Electron E2E | **56 passed** | `gates/electron-e2e.txt` |
| 标准 Seatbelt 25 项真实项目 | **25/25，build passed，save/undo tree 一致**（`A1_R1_STANDARD_SANDBOX_FULL_PROJECT_VERIFICATION_OK`） | `gates/seatbelt-25-sample.txt` |
| 真实反向探针（全部） | **45 passed**（既有 40 + 新增 5） | `gates/probes.txt`、`probes/new-candidate/all-probes.txt` |
| 旧候选同一组新探针 | 4 failed / 1 passed | `probes/old-candidate/new-probes.txt` |

- 全量单测数量与上一轮完全一致（773/38/0），未删除/跳过任何既有测试，未降低断言；
- 新增探针为 `tests/closeout-probes/*.probe.ts`，已加入现有 `vitest.probes.config.ts`，由同一个 `probes` CI job 运行（见 §4）；
- E2E 会重写 `docs/screenshots/stage9-webcodex/*.png`，已在提交前还原，未进入本轮提交。

---

## 4. exact-HEAD CI（Ubuntu + macOS，test + probes）

- **代码提交**：`a739d024233cd0a099ab63ef2b1cbceddcd38db1`
- **Run**：`45451164433` — https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/45451164433
- **结论**：`conclusion=success`（**4/4 job 成功**，无 rerun）

| Job | 时间（UTC） | 结果 | 关键步骤 |
| :-- | :-- | :-- | :-- |
| `test (ubuntu-latest)` | 17:40:34 → 17:42:17 | success | typecheck、`771 passed / 40 skipped / 0 failed`、build |
| `test (macos-latest)` | 17:50:35 → 18:03:30 | success | typecheck、`773 passed / 38 skipped / 0 failed`、build、Electron E2E `56 passed` |
| `probes (ubuntu-latest)` | 17:40:34 → 17:41:35 | success | `18 test files / 45 passed`（含 `tests/closeout-probes/*`） |
| `probes (macos-latest)` | 17:45:37 → 17:48:19 | success | `18 test files / 45 passed`（含 `tests/closeout-probes/*`） |

- macOS 两个 job 排队约 5–10 分钟（runner 容量），started 后均一次通过，不是代码失败；
- 新增的 5 项探针已进入现有 `probes` CI job（配置见 `vitest.probes.config.ts`），Ubuntu/macOS 都是 45 项；
- 证据：`gates/ci-a739d02.json`（每个 job / step 的 conclusion）、`gates/remote-fingerprints.txt`（5/5 文件 sha256 与 GitHub 一致）。

> 本报告的提交是 docs-only；其 exact-HEAD CI（四项 job）在推送后按同一工作流运行，结果见 PR #7 checks 与最终回执。

---

## 5. 索引状态（如实登记）

| 工具 | 本轮状态 |
| :-- | :-- |
| `code-review-graph 2.4.0` | 在代码提交 `a739d024233c` 执行 `update --brief` 对齐：**3690 节点 / 56359 边 / 270 文件**，`Last updated 2026-11-25T01:40:16`，`Built at commit a739d024233c`。索引在 `.code-review-graph/`（被 `.gitignore` 排除，不入库）。CRG 的“test gap”启发式提示 `TaskRunner`/`confirmScopeChange` 缺少直接测试文件引用；实际它们由 `tests/a1-evidence-chain.test.ts` 等既有单测与本轮探针覆盖（启发式按直接引用统计，不代表无测试）。 | `gates/code-review-graph-status.txt`、`gates/code-review-graph-update.txt` |
| `graphify 0.9.113` | `graphify update . --no-cluster`：AST 抽取 3518 节点；落盘 `graphify-out/graph.json` 实测 **0 条边**（未配置 LLM，未生成语义边）。**不把 AST 抽取冒充语义索引**；语义索引状态为 NOT_VERIFIED。`graphify-out/` 已删除（可重复生成）。 | `gates/graphify-status.txt`、`gates/graphify-update.txt` |

> 两个索引都是本地开发索引：不属于产品交付物、不进入 Git、不参与 CI 门禁。

---

## 6. 工作区保护

| 工作树 | 用途 | 本轮处理 |
| :-- | :-- | :-- |
| `/Users/jamesho/ai-solo-studio-rebuild` | 原主工作区（8 个在研文件） | **未覆盖、未重置、未提交**；HEAD 仍 `8dfcfc19daf9ba890142be0075f9e869b6353731`；8 个文件 SHA-256 与基线逐字一致 |
| `/Users/jamesho/ai-solo-studio-a1` | Cursor A1 工作树（`9d1533f`） | 未改动 |
| `/Users/jamesho/ai-solo-studio-a0-delivery` | A0 审计工作树 | 未改动 |
| `/Users/jamesho/ai-solo-studio-a1-r3`（`takeover/AISS-A1-R3`） | **本轮接管工作树**（从 `2dff160` 继续） | 全部修改只在这里 |
| `/tmp/a1-closeout-old`（detached `2dff160`） | 旧候选对照（只为跑同一组新探针） | 证据落盘后**已移除** |

证据：`workspace-protection-before.txt`、`workspace-protection-after.txt`。

---

## 7. 清理

- 旧候选对照工作树 `/tmp/a1-closeout-old` 在探针证据落盘后移除；
- `graphify-out/` 为状态检查生成，记录统计后删除；`.code-review-graph/` 为本地索引，按既有约定保留且不入库；
- 探针临时目录由 `afterEach` 清理，`RecordStore` 均 `closeAll`；
- E2E 重写的截图已还原；
- 未删除任何旧失败证据；未合并 PR #7；活跃工作树与未合并代码全部保留。

---

## 8. 合规边界（与任务禁止项逐条对照）

| 禁止项 | 本轮实际 |
| :-- | :-- |
| 不启动 R5 | 未启动；仅两处限定修订 + 对应探针 |
| 不重写 A1 | 未重写；复用既有唯一裁决入口，未新增平行裁决系统 |
| 不扩大沙箱权限 | 未改沙箱策略/权限 |
| 不修改报告目录保留策略 | 未改（保守保留方案沿用） |
| 不做 Graphify 语义索引 / 原生模块专项研究 | 未做；只如实登记 AST 状态 |
| 不删除旧失败证据 | 未删除；旧探针与报告全部保留 |
| 不自行合并 PR #7 | 未合并；PR 保持 OPEN |

---

## 9. 剩余风险（沿用既有登记，不重新打开）

1. 报告目录保守保留：同一任务副本内按检查次数增长、不设上限（随副本回收）；已接受。
2. 标准 Seatbelt 断网/端口限制沿用 R1 的 OPEN 登记；本轮未扩大沙箱权限。
3. CRG/Graphify 是本地索引，不参与 CI；Graphify 语义边未生成。
4. `full_trust` 模式执行体与用户同权限；不构成对同权限攻击的隔离保证。
5. Windows 未验证（门禁为 macOS 本地 + Ubuntu/macOS CI）。
6. 历史轮次缺少 `acceptanceRev` 时只允许跳过该一项；版本/树/项目/副本/试合并提交仍强制核对。

---

## 10. 证据索引

```text
docs/reviews/
├── AISS-A1-PREMERGE-GATE-CLOSEOUT-001.md          # 本报告
└── AISS-A1-PREMERGE-GATE-CLOSEOUT-001/
    ├── gates/
    │   ├── typecheck.txt
    │   ├── build-core.txt
    │   ├── build-renderer.txt
    │   ├── full-suite.txt
    │   ├── electron-e2e.txt
    │   ├── seatbelt-25-sample.txt
    │   ├── probes.txt
    │   ├── ci-a739d02.json
    │   ├── remote-fingerprints.txt
    │   ├── code-review-graph-update.txt
    │   ├── code-review-graph-status.txt
    │   ├── graphify-update.txt
    │   └── graphify-status.txt
    ├── probes/
    │   ├── old-candidate/new-probes.txt
    │   └── new-candidate/new-probes.txt
    │   └── new-candidate/all-probes.txt
    ├── workspace-protection-before.txt
    └── workspace-protection-after.txt
```

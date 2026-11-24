# AI Solo Studio — 当前工程基线 (CURRENT_BASELINE)

**更新时间：** 2026-11-25
**权威基线分支：** `rebuild` (`origin/rebuild`)
**产品代码交付基线 (Product Code Merge SHA)：** `1c65aedd808b14207d8b6db6ef0d68ee3b065194`（PR #7 Merged）
**当前任务基线（Reference HEAD，写本文件时点）：** `1c65aedd808b14207d8b6db6ef0d68ee3b065194`
**工程状态声明：** `AISS_A1_MERGED_VERIFIED_COMPLETE`
**基线解耦与治理原则：** 严格区分三类 SHA，禁止自引用循环：
1. **产品合入 SHA**：`1c65aed`（PR #7 合并提交，静态唯一准绳）；
2. **动态主干 HEAD**：基线同步、工程治理与文档提交会正常推进，不以它替代产品合入 SHA；
3. **索引构建 SHA**：CRG 图数据库构建时点（见 §四），与以上两者分离登记。

---

## 一、 当前工程的三层状态严格划分（按真实 Git 与 PR 状态核查）

| 层次划分 | 覆盖范围与分支路径 | 当前真实状态与事实边界 |
|---|---|---|
| **第一层：主线已合并 (Mainline Merged)** | 分支：`origin/rebuild`<br>产品代码基线: `1c65aed`<br>(动态 HEAD 随文档与工程治理推进) | • **M0 / M1 / M2 / M3-BASE** 基础架构稳固。<br>• **PR #1 (Merged)**：CI 最小恢复与安全边界（`1b5fe76`）。<br>• **PR #2 (Merged)**：修复 ADR 0005 存储语义、消除 URL 逃逸、收敛单源 SOP 蓝图（`443773c`）。<br>• **PR #4 (Merged)**：统一 7 字段代理交付回复强制标准与全局工作区规则（`442c73f` / `255e635`）。<br>• **PR #5 (Merged)**：代码地图、基线记忆与 CRG 索引试点及失效降级规范（`441770f` / `dfa38ef`）。<br>• **PR #3 (Merged)**：ChatGPT 网页安全交互、方案受控导入门禁与审查反馈包（`9aecd45` / `f2900a8`）。<br>• **PR #7 (Merged)**：AISS-A1 可信证据链 R1–R4 与合入前门禁收尾（MERGE_SHA `1c65aed`；批准 HEAD `1a454e4`；产品代码提交 `a739d02`）。此层代码为目前正式交付产品基线。 |
| **第二层：独立 PR 待审 (Open PRs Pending Review)** | 本轮基线同步 PR（`docs/aiss-a1-merge-baseline-sync`，本文件所在提交） | • 仅包含本文件、`CODE_MAP.md`、A1 任务台账/计划状态与最终验收报告，无产品代码改动。<br>• 合入后本层关闭；`docs/novice-website-mode` 仍为本地独立分支（未提 PR，等待维护者裁定）。 |
| **第三层：本地工作区在研未提交 (Local In-Progress / Uncommitted)** | 路径：`/Users/jamesho/ai-solo-studio-rebuild`<br>（原工作区未提交文件） | • 包含 8 个未提交修改（`e2e/shell.e2e.ts`, `src/core/app/task-controller.ts`, `src/core/thinking/index.ts`, `App.tsx`, `SettingsPage.tsx`，以及未跟踪的 `autonomous-feedback-loop.ts`, `chatgpt-devkit.ts`, `tests/autonomous-feedback-loop.test.ts`）。<br>• 8 个文件 SHA-256 在 A1 全程与收尾时逐一核对一致（见 `docs/reviews/AISS-A1-MERGE-AND-FINAL-CLOSEOUT-001/workspace-protection-after.txt`）。<br>• **严格约束**：受 100% 隔离保护，严禁画入当前主线架构，不能作为现有代码引用。 |

---

## 二、 已交付能力登记

### 2.1 P0-2 ChatGPT 安全交互（PR #3，保持有效）

- **合入身份**：PR #3，主干 MERGE_SHA `9aecd45d94f0574930f833d83633cf9ac76ae744`，PR HEAD `f2900a8583625dd96fa76e65bdc96e65ec77e774`。
- **已验证边界**：独立沙箱伴侣窗口（专属分区、双权限全拒绝、零 preload）、域名白名单与 302/iframe/弹窗拦截、方案全要素导入门禁与防重锁、反馈包脱敏与人工核验、真实 Electron DOM 权限查询 E2E。
- **未验证**：伴侣视界内真实登录态 `LIVE_LOGIN_NOT_VERIFIED`；交互仍为人工确认式（Human-in-the-loop）。
- **详细证据**：`docs/reports/2026-11-24-chatgpt-interaction-final-delta.md`。

### 2.2 AISS-A1 可信证据链（PR #7，已合入并关闭）

**合入与批准身份**

| 项 | 值 |
| :-- | :-- |
| PR / 目标分支 | #7 `feat/aiss-a1-trusted-evidence-001` → `rebuild`（MERGED，2026-11-24T19:28:38Z） |
| 独立复核批准 HEAD | `1a454e45be12810f8ab8fb2b4b6f6e5157880420` |
| 产品代码提交 | `a739d024233cd0a099ab63ef2b1cbceddcd38db1` |
| 主干 MERGE_SHA | `1c65aedd808b14207d8b6db6ef0d68ee3b065194`（父：`e69ca85` + `1a454e4`，合并结果 tree = 批准 HEAD tree） |
| 合并前基线 | `e69ca8511a17acfc4427954af13ef6d364ffb553` |

**已交付能力（真实源码与门禁）**

1. **统一宿主证据模型**：`src/core/evidence/model.ts` / `inventory.ts` / `vitest.ts` / `validate.ts`；证据绑定项目根、任务、轮次、验收版本、被测 tree、任务副本、试合并提交、evidenceId。
2. **统一裁决唯一入口**：`adjudicateEvidence` / `adjudicateStoredProof` / `adjudicateCheckResult` / `adjudicateTaskEvidence` / `adjudicateTrialEvidenceSet`；失败优先，归属优先，证据完整优先；历史记录缺绑定显式降级，不补造通过。
3. **可信测试通过语义**：Vitest JSON 报告 + 运行窗口/计数一致性/失败优先 + **stdout 交叉核对**；零测试、全跳过、报告被复用/损坏、范围削弱均不得算通过。
4. **保存门禁**：写主项目前完成完整证据集合裁决；真实失败与身份失效为硬阻断（`confirmUnchecked` 不能绕过）；合法未检查保存仍须用户明确确认；写入后强制 `mergeCommit === trialCommit` 并核对任务内容漂移。
5. **试检查与范围确认**：试检查证据强制绑定本次 trialCommit 及其 tree；用户确认必须绑定内容 + 静态范围 + 实际执行清单 + 验收版本；确认后的重跑必须取得经统一裁决 `verified` 的新证据，否则保持待确认并继续阻断保存。
6. **持久化与恢复**：`SaveRecord` / `OpLog` 携带 `trialCommit`、`trialCommitTree`、`acceptanceRev`、`projectRootHash`、`trialWorktreePathHash`、`expectedChecks`、`evidenceIds`、`trialChecks`；启动恢复与历史展示复用同一裁决口径。
7. **诚实展示与反馈包**：验收卡/证据页/保存历史/ChatGPT 反馈包区分 verified / failed / not_checked / unverified / invalidated；失败与不可信有独立文案。

**真实验证范围**

- 反向探针：**45 项**（既有 40 项 + 合入前门禁收尾新增 5 项），真实 Git / 真实 Vitest / 真实 RecordStore / 真实 SIGKILL 中断；旧候选同一组新探针 **4 failed / 1 passed**，新候选 **45/45 passed**。
- 全量单测 **773 passed / 38 skipped / 0 failed**；Electron E2E **56 passed**；标准 Seatbelt 25 项真实项目 **25/25**（save/undo tree 一致）。
- 精确 CI：产品代码提交 `a739d02` Run `45451164433` 4/4；批准 HEAD `1a454e4` Run `45455480459` 4/4；合并提交 `1c65aed` Run `45470615272` 4/4（详见 §六 与最终验收报告）。

**已接受风险（沿用既有登记，不重新打开）**

1. 检查报告目录为保守保留：同一任务副本内按检查次数增长、不设上限（随副本回收）。
2. 标准 Seatbelt 断网/端口限制沿用 R1 的 OPEN 登记；未扩大沙箱权限。
3. `full_trust` 模式下执行体与用户同权限；不构成对同权限攻击的隔离保证。
4. 历史轮次缺少 `acceptanceRev` 时只允许跳过该一项；版本/树/项目/副本/试合并提交仍强制核对。
5. CRG/Graphify 为本地索引，不参与 CI；Graphify 语义边未生成（见 §四）。

**未验证 / 未实现（如实登记）**

- Windows 未验证（门禁为 macOS 本地 + Ubuntu/macOS CI）。
- Graphify 语义索引：`NOT_VERIFIED`（仅 AST 抽取，0 条语义边；未配置 LLM）。
- ChatGPT 伴侣视界真实登录态：`LIVE_LOGIN_NOT_VERIFIED`（P0-2 既有）。
- **A2–A6 能力均未实现**：本文件不预注册、不承诺、不描述其存在；任何后续能力须在其实现并有真实源码/测试证据后另行登记。

**详细证据**：`docs/reviews/AISS-A1-TRUSTED-EVIDENCE-001.md` … `-R4-FINAL-CLOSEOUT-001.md`、`docs/reviews/AISS-A1-R4-LAST-DELTA-001.md`、`docs/reviews/AISS-A1-PREMERGE-GATE-CLOSEOUT-001.md`、`docs/reviews/AISS-A1-MERGE-AND-FINAL-CLOSEOUT-001.md`。

---

## 三、 关键决策与架构优先级（Decision Precedence）

1. **最高优先级：已批准的正式 ADR 与最新修订**
   - **ADR 0010**（多执行体与订阅策略）：通用 AI API Key 为官方推荐；本地订阅 CLI 需默认关闭、逐服务商风险弹窗、如实声明隔离上限；严禁跨工具接触凭证、严禁回退到无沙箱宿主执行测试。
   - **ADR 0005 & 0006**：文件存储为唯一持久化载体；`PersistenceService`（`store.ts`）为唯一写入者（CAS + events.jsonl + 启动对账）；`.studio/` 不入 Git。
   - **ADR 0007 & 0008**：单测 / Electron 冒烟 / E2E 严格分层；新增依赖精确版本且发布满 14 天，禁止未受审原生模块。
2. **第二优先级：项目级通用规范**（`docs/standards/AGENT_REPORTING_STANDARD.md`，PR #4 已合并）：7 字段回执、证据完整落盘、未验证写 `NOT_VERIFIED`。
3. **第三优先级：当前基线与代码地图**（本文件 / `docs/engineering/CODE_MAP.md`）：必须 100% 映射 `origin/rebuild` 真实存在的模块、函数签名与测试套件。
4. **历史演进参考**（`docs/plans/`、`docs/reports/`）：仅作背景；与上述 ADR/基线冲突的早期描述一律失效。

---

## 四、 本地代码索引与辅助机制有效性声明

### 4.1 Code Review Graph（本轮真实构建与检索核验）

- **`build_sha`**：`1c65aedd808b14207d8b6db6ef0d68ee3b065194`（= 产品合入 SHA；本机 `code-review-graph 2.4.0` 在干净检出上执行 `update --brief`，工具自报 `Built at commit: 1c65aedd808b`）。
- **索引规模**：**3691 节点 / 56359 边 / 271 文件**（2026-11-25T03:32:01 更新）。
- **`source_equivalence`**：`true`（构建后至本文件所在 HEAD 的改动仅为 `docs/`；`git diff --name-only 1c65aed..<本文件 HEAD> -- src tests e2e package.json vitest*.ts` 为空）。
- **`exact_head_match`**：`false`（本文件提交会推进动态 HEAD）——构建时点匹配，登记时点不再 exact。
- **索引注册状态**：`SOURCE_EQUIVALENT`（仅可用于源码等价前提下的符号/引用检索辅助；**不得**作为 exact-HEAD 的 PR 审查、验收或发布证据）。按 `docs/engineering/INDEX_PILOT_EVALUATION.md` 原则 1，涉及精确 HEAD 的结论一律降级为 Git / Ripgrep 原生检索。
- **实际可用性核验（本次真实执行）**：`code-review-graph search "adjudicateTrialEvidenceSet"` → 命中 1 个节点：`src/core/evidence/adjudicate.ts:371-459`（Function，签名 `(input: TrialEvidenceSetInput) -> TrialEvidenceSetResult`）。
- **索引位置**：工作树内 `.code-review-graph/`（被 `.gitignore` 排除，不入库）。A1 收尾工作树退役后索引可随时用 `code-review-graph update` 重建。
- **失效降级策略**：`exact_head_match: false` 时开发代理立即降级为 Git / Ripgrep 原生源码检索，严禁阻塞开发，不引入常驻索引守护进程。

### 4.2 Graphify

- **语义索引状态：`NOT_VERIFIED`。** 本轮 `graphify update . --no-cluster` 仅完成 AST 抽取（3518 节点）；落盘 `graphify-out/graph.json` 实测 **0 条边**；未配置任何 LLM/外部服务，未生成语义边。**不把 AST 抽取冒充语义索引。**
- `graphify-out/` 不入 Git，检查后已删除，可重复生成；MCP `graphify-shm` 指向其他项目（`PROJECT_SCOPE_MISMATCH`），与本仓库无关。
- 详细记录：`docs/reviews/AISS-A1-MERGE-AND-FINAL-CLOSEOUT-001/gates/graphify-status.txt`。

---

## 五、 任务台账与能力状态（A2–A6 未实现）

| 任务 | 状态 | 说明 |
| :-- | :-- | :-- |
| `AISS-P0-2-CHATGPT-SECURE-INTERACTION-001` | `COMPLETE`（PR #3 Merged） | 见 §2.1。 |
| `AISS-A1-TRUSTED-EVIDENCE-001`（R1–R4 + 合入前门禁收尾 + 合入收尾） | **`AISS_A1_MERGED_VERIFIED_COMPLETE`**（PR #7 Merged，MERGE_SHA `1c65aed`） | 见 §2.2；最终验收报告 `docs/reviews/AISS-A1-MERGE-AND-FINAL-CLOSEOUT-001.md`。 |
| A2–A6 | **未实现 / 未登记** | 不预注册、不承诺；不得在文档或界面中描述为已存在能力。 |
| `docs/novice-website-mode`（新手建站 PRD） | 本地独立分支，未提 PR | 等待维护者裁定 5 项方案，未开工。 |

# AISS-AUTONOMOUS-FEEDBACK-AUDIT-001：自主反馈闭环源码审计与隔离验证报告

- **审计基准 HEAD**：`e69ca8511a17acfc4427954af13ef6d364ffb553` (`origin/rebuild`)
- **审计工作树**：`/Users/jamesho/ai-solo-studio-audit` (分支：`audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001`)
- **受保护原工作区**：`/Users/jamesho/ai-solo-studio-rebuild` (分支：`rebuild`, HEAD: `8dfcfc19daf9ba890142be0075f9e869b6353731`)
- **状态标记**：`AISS_AUTONOMOUS_FEEDBACK_AUDIT_READY_FOR_INDEPENDENT_REVIEW`
- **审计性质**：技术验证与架构审计报告，非正式功能交付，不合入产品主干。

---

## 1. 保护状态与基线校验

### 1.1 主工作区 8 文件完整性指纹（SHA-256）

审计前后经校验完全一致（0 篡改、0 污染）：

| 序号 | 文件路径 | SHA-256 校验码 | Git 跟踪状态 |
| :--- | :--- | :--- | :--- |
| 1 | `e2e/shell.e2e.ts` | `1059d524c53412f1b3ad5f7bde13c4b70e31ee7b026d684bb10426d3ad5aa93a` | Modified (M) |
| 2 | `src/core/app/task-controller.ts` | `40873cc12089ef94db563824b60135a56425c91ea6a4b42bc7e43ff990118881` | Modified (M) |
| 3 | `src/core/thinking/index.ts` | `cd4b5dd264b069bf558571916367e068f036496dc86da3c35466be5e43e9ecb5` | Modified (M) |
| 4 | `src/renderer/App.tsx` | `0127d93ce23138b099b3d66771d85666c257548e9186155799649385f33b9c30` | Modified (M) |
| 5 | `src/renderer/SettingsPage.tsx` | `c0ee540629549ef39fc87f6b07778aa4350955746f86e13b13d5e55821a70765` | Modified (M) |
| 6 | `src/core/app/autonomous-feedback-loop.ts` | `d5067b3fe176984f0115751f9fa5690d02b4dc121119bfb82981b83439424428` | Untracked (??) |
| 7 | `src/core/thinking/chatgpt-devkit.ts` | `49f3cfce392320c4b399e05bddec19695f7d4bc78fa17acdc6f2471efdf49f35` | Untracked (??) |
| 8 | `tests/autonomous-feedback-loop.test.ts` | `caad1b563d77eac30fa4af96165bfc767c837fc2954d622b0cef0f75dc94eae3` | Untracked (??) |

### 1.2 主干基线与冲突分析

- 原工作区基于历史节点 `8dfcfc1` 修改。
- 随后上游通过 PR #3 (`9aecd45`) 引入了重磅提交（P0-2: Companion 独立伴侣窗口、结构化方案导入门禁、反馈包脱敏审查模态框等），并经 PR #4、#5、#6 同步基线至 `e69ca85`。
- **冲突矩阵**：
  - `e2e/shell.e2e.ts`：本地仅增加未使用的 `import net from 'node:net';`，主干增加了 100+ 行完整的 P0-2 伴侣窗口与反馈审查测试。
  - `src/renderer/App.tsx`：本地修改了旧版 `onImportPlanToTask` 与侧边栏状态，与主干 PR #3 引入的 `targetPid` 显式目标项目门禁冲突。
  - `src/renderer/SettingsPage.tsx`：本地增加了 `squadExecutors`（施工队多席位原型），与主干最新设置页结构产生重叠冲突。
  - `src/core/app/task-controller.ts` 与 `src/core/thinking/index.ts`：本地差异可平滑打补丁合并至主干。

---

## 2. 源码与功能逐项盘点（能力矩阵）

### 2.1 逐文件职责与调用关系

#### 1. `src/core/app/autonomous-feedback-loop.ts` (214 行)
- **职责**：自动化纠错反馈引擎。
- **调用入口**：`TaskController.runFeedbackLoop()` 以及 `TaskRunner` 的 `update` 事件监听回调。
- **依赖调用**：`LoopGuard.evaluateTaskStep()`、`Thinker.think()`（Reviewer 模式）、`TaskController.reworkTask()`。
- **真实实现能力**：
  - `extractFailureEvidence`：从 `task.currentChecks` 或 `task.rounds` 提取失败单测名称及截断日志（<=1500字符），检查 `task.exit` 退出码及 `task.criteria` 中标记为 `rejected` 的条目。
  - `processTaskReview`：串联证据提取 -> 熔断器审查 -> 调用 Thinker 生成 JSON 诊断指令 -> 根据 `autonomous` 还是 `semi-auto` 模式调用 `reworkTask`。
- **未接通/伪造/缺失能力**：
  - **证据存在性缺失**：若未运行任何测试且进程正常退出，函数判定 `evidence.failed === false`，直接误判为 PASS（见反向探针 2）。
  - **缺乏独立校验**：无法防范执行体擅自修改/删除测试断言导致的表面通过。
  - 缺乏开销预算上限（Token 与耗时门禁）。

#### 2. `src/core/thinking/chatgpt-devkit.ts` (207 行)
- **职责**：通过 OpenAI 兼容接口以 JSON 模式进行结构化推理的 Thinker 适配器。
- **调用入口**：实现 `Thinker` 接口，由 `TaskController` 或 `AutonomousFeedbackLoop` 按需加载。
- **依赖调用**：外部 HTTP API (`/v1/chat/completions`)、`getAccessToken()` 凭证获取函数。
- **真实实现能力**：
  - 具备真实的 `fetch` 请求、AbortController 超时处理、401/429 状态码分类解析、JSON Schema 解析与 Bearer Token 错误日志脱敏。
  - 纯思考者设计，无工具注入，不直接操作本地文件。
- **限制与架构边界**：
  - 声明为 "DevKit 订阅版"，但底层实质为标准的 OpenAI Chat Completions API 协议端点调用。
  - 在无官方 Sign-In-With-ChatGPT 本地网关或服务集成时，`getAccessToken` 只能依赖外部传入。

#### 3. `src/core/app/task-controller.ts` (1333 行)
- **改动点**：
  - 引入 `feedbackLoop` 配置选项。
  - 在 `getRunner()` 中监听 `runner.on('update')`，当 `updated.state === 'reviewing'` 时异步触发 `runFeedbackLoop`。
  - 新增 `getFeedbackLoop()` 与 `runFeedbackLoop()` 方法。
- **真实能力**：
  - 成功复用了原有的任务状态机与持久化生命周期，通过调用 `reworkTask()` 派发下一轮执行，状态流转为规范的 `reviewing -> approved (round++)`。
- **架构冲突与缺陷**：
  - **并发竞态风险**：在 `runner.on('update')` 中通过 `void this.runFeedbackLoop(...)` 异步触发，无并发锁。如果外部同时触发或快速发生状态变迁，可能产生多次重入。

#### 4. `src/core/thinking/index.ts` (9 行)
- 导出 `ChatGptDevKitThinker` 及其常量与类型。纯模块导出。

#### 5. `src/renderer/App.tsx` 与 `src/renderer/SettingsPage.tsx`
- **改动点**：增加侧边栏 ChatGPT Web 开关；在设置页实验性加入 `squadExecutors`（本地 localStorage 存储的执行席位列表）。
- **评估结论**：UI 层面修改属于非闭环核心的原型实验，且与主干 PR #3 已合入的正式门禁代码产生多处语义冲突，**建议废弃或延后解耦设计**。

#### 6. `e2e/shell.e2e.ts`
- 仅增加了 `import net from 'node:net';`，未包含任何有效反馈闭环的端到端测试。**建议废弃改动，完全同步主干**。

#### 7. `tests/autonomous-feedback-loop.test.ts` (295 行)
- **测试内容**：覆盖了 DevKit 脱敏、Token 检测、401/429 报错处理、全绿通过跳过、单测失败自动退回、半自动建议模式、LoopGuard 连续 3 次熔断阻断。
- **真实性评估**：单元测试逻辑真实严密，但测试用例直接 Mock 了 `TaskController.load` 与 `reworkTask`，未覆盖多轮并发与真实工作树文件变更校验。

---

## 3. 自主反馈闭环专项深度审计

### A. 任务状态与生命周期
1. **状态机复用**：原型严格复用了 `TaskController.load`、`reworkTask` 与底层状态模型（`reviewing -> approved`），未私自创建第二套冲突的状态机。
2. **生命周期风险**：
   - 依赖 `runner.on('update')` 监听并在 `reviewing` 状态下无锁触发。当任务由多个子步骤驱动或发生异常状态刷新时，容易产生竞态。
   - 应用重启后，处于 `reviewing` 状态的任务不会自动恢复未完成的闭环评估，需人工进入验收页或重新触发。

### B. 执行证据可信性
1. **真实宿主证据提取**：能够直接从 `StoredCheckProof`（执行器运行 `npm test` 等命令的物理产物）提取错误输出和退出码，并非单纯读取 AI 的自述。
2. **高危漏洞（测试缺失误判为 PASS）**：
   - 当任务根本没有配置检查项，或测试脚本未执行直接退出（exitCode 0）时，`extractFailureEvidence` 返回 `failed: false`，闭环直接宣告 `passed: true`。
3. **防篡改盲区**：
   - 执行体若在修改代码时删除了测试用例、清空了测试文件或降级了断言，只要当前检查退出码为 0，闭环会误判为修复成功。

### C. 独立复核与修复循环
1. **职责隔离**：Reviewer（诊断脑）与 Executor（执行体）实现了上下文与职责的隔离。Reviewer 仅输出结构化 JSON 诊断文本，不具有任何写入与执行工具权限。
2. **熔断与终止保护**：集成了 `LoopGuard`，默认阈值为 3 次。连续 3 次失败能够可靠地熔断并阻断下一轮派发。
3. **缺失机制**：缺失累计 Token 与单任务总耗时熔断阈值；当诊断服务持续不可用（如网络断开）时，会退化为固定模版文本反复重试。

### D. 安全与授权
1. **凭证脱敏**：`redactDevKitSecret` 能有效对 Bearer Token 进行正则和字符串替换，防止 Token 泄露到前端日志。
2. **授权范围**：`reworkTask` 继承主工作区权限；但在全自动模式下，执行体重试可能会突破用户最初的改动心理预期，必须严格锁定在受控工作树内。

### E. AI 服务与执行体适配
1. **DevKit 定位与事实**：当前 `ChatGptDevKitThinker` 实际上是标准的 HTTP REST 调用实现，并未集成任何私有非官方网页抓取协议，不存在封号或反爬对抗风险；但其要求合规的 Access Token。
2. **主干 P0-2 契合度**：主干 PR #3 已确立了 ChatGPT 独立伴侣窗口与人工脱敏审查反馈包（`Human-in-the-loop`）。自主反馈闭环必须在此架构下提供：
   - 模式一：本地已配置 API Key / Access Token 时的全自动模式；
   - 模式二：无直接 API 时的半自动“一键生成反馈包并送交伴侣窗口”模式。

---

## 4. 独立审计工作树隔离集成与反向验证

在 `/Users/jamesho/ai-solo-studio-audit` 中完成隔离验证：

### 4.1 核心测试套件结果
1. **主干基线回归**：58 个测试文件、677 个单元测试全部通过（0 失败）。
2. **TypeScript 类型检查**：`npm run typecheck` 0 错误通过。
3. **闭环原有测试套件**：打入 Controller 补丁后，9 个测试全部 PASS（耗时 170ms）。
4. **系统回归测试**：`b4-2-controller.test.ts`、`runner.test.ts`、`flow.test.ts` 共 94 个测试全部通过。

### 4.2 反向审计探针验证（4 项探针全部实测通过）
在 `tests/probes/audit-negative-probes.test.ts` 中构建反向探针：
- **探针 1（执行体异常退出捕获）**：验证当无检查日志但进程退出码非 0（如 OOM / Kill 137）时，闭环正确捕获异常并阻止误判通过。
- **探针 2（测试缺失虚假通过漏洞实证）**：验证了当 `currentChecks` 为空时，原型存在无条件放行漏洞，证明了建立“强制证据存在性门禁”的必要性。
- **探针 3（复核服务故障降级）**：验证了当 Thinker 出现 401/Network 故障时，系统降级为通用测试失败提示，不会发生未捕获异常崩溃。
- **探针 4（跨项目越权与隔离）**：验证了通过非法 taskId 注入时，Controller 基础安全层可靠拦截。

---

## 5. 资产处置决策与分阶段实施计划

### 5.1 模块资产决策
- **可直接复用**：
  - `src/core/app/loop-guard.ts`（熔断机制）。
  - `src/core/thinking/chatgpt-devkit.ts`（规范的 OpenAI 兼容 Thinker 抽象）。
  - `tests/autonomous-feedback-loop.test.ts`（高质量的逻辑用例集）。
- **需要重构**：
  - `src/core/app/autonomous-feedback-loop.ts`：重构以补齐强制证据门禁（必须有测试产物且 Git 差异符合预期，防假通过）、增加耗时/Token 上限。
  - `src/core/app/task-controller.ts`：增加互斥锁与防重复触发保护，与 P0-2 的反馈包模态框机制联动。
- **建议废弃**：
  - `src/renderer/App.tsx` 与 `src/renderer/SettingsPage.tsx` 中的施工队与冲突状态修改（与主干 PR #3 冲突）。
  - `e2e/shell.e2e.ts` 的临时改动。

### 5.2 实施路线图（三阶段）

| 阶段 | 目标 | 核心任务 | 验收门禁 | 依赖关系 |
| :--- | :--- | :--- | :--- | :--- |
| **阶段 1：可信证据与防作弊门禁** | 消除虚假通过与防篡改 | 1. 重构证据提取，强制要求必须具备有效的测试产物；<br>2. 增加 Git 差异基线核验（禁止执行体擅自清空测试文件）。 | 反向探针 2 修复并通过；无测试时绝对禁止判定 PASS。 | 强依赖主干当前基线 |
| **阶段 2：状态机受控与并发防护** | 消除并发竞态与循环卡死 | 1. 在 TaskController 中引入状态机锁与重入互斥；<br>2. 完善 Token/轮次双重熔断；<br>3. 实现半自动模式与 P0-2 反馈模态框直接对接。 | 并发触发测试 0 异常；3 次连续失败 100% 熔断。 | 依赖阶段 1 |
| **阶段 3：多执行体协同与端到端闭环** | 正式接入 UI 与工作台 | 1. 在设置页提供规范的自主纠错开关；<br>2. 补充完整的 Electron 端到端回归测试用例。 | 完整 E2E 绿色通过；用户操作体验无缝。 | 依赖阶段 2 |

---

## 6. 工程治理补充登记（下次文档修订项）

以下条目已完成实测核查并登记，待后续统一随文档 PR 修订，不在本次审计中改动产品代码：
1. **WebBridge 伴侣窗口机制**：实际路径为人工导入与降级通道，不支持跨窗口 DOM 穿透。
2. **函数签名与组件**：`ChatGPTPlanConfirmDialog`、`ChatGPTFeedbackModal` 组件身份及 `buildChatGPTFeedbackPacket(opts)` 签名与源码完全保持一致。
3. **CRG 构建身份与 HEAD 匹配**：构建 SHA `9ce89e2` 为源码等价构建索引，当前主干 HEAD `e69ca85` 为元数据与文档同步提交。

---

`AISS_AUTONOMOUS_FEEDBACK_AUDIT_READY_FOR_INDEPENDENT_REVIEW`

# AI Solo Studio — 核心代码地图 (CODE_MAP)

**版本：** v1.9 (AISS-A1 Merged Closeout，2026-11-25)  
**基线分支：** `origin/rebuild`（产品合入 SHA `1c65aedd808b14207d8b6db6ef0d68ee3b065194` = PR #7 MERGE_SHA；动态主干 HEAD 随文档推进，见 `CURRENT_BASELINE.md`）  
**真实性原则：** 100% 经由真实源码导出与调用实现核对；Preload API 明确展示完整入参（包括 `projectId`）；严格区分 `runCheck()` 与 `runProjectChecks()`；未合入主线的在研原型不画入当前主线架构；已合入的 A1 能力全部附真实门禁与反向探针证据。  

---

## 一、 系统全景与模块分层架构

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. 渲染层 (Renderer: React 19 + Vite, 沙箱隔离环境)                    │
│    入口: src/renderer/index.html -> main.tsx -> App.tsx                │
│    视图: Workbench.tsx, ProjectBoard.tsx, SettingsPage.tsx,            │
│          TaskPage.tsx, Acceptance.tsx, DiffPreview.tsx,                │
│          ChatGPTView.tsx (伴侣控制、多项目选择器、方案导入门禁)          │
│    辅助: planParser.ts (方案全要素解析与防重锁),                        │
│          chatgptFeedback.ts (反馈包生成与脱敏核验),                    │
│          webBridge.ts (提取辅助；无跨窗口 DOM 读取，失败诚实降级)      │
│    通信接口: window.studio.* (经 contextBridge 暴露的白名单 API)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ IPC (invoke / on)
┌───────────────────────────────────▼────────────────────────────────────┐
│ 2. 预加载与主进程 (Preload & Main: Electron 安全外壳)                   │
│    preload 入口: src/preload/index.cts (白名单路由与参数类型校验)      │
│                  - tasks:*, acceptance:*, chatgpt:* (伴侣视界 IPC)     │
│    main 入口:    src/main/index.ts (窗口初始化、CSP、IPC 注册与分发)    │
│    安全伴侣视界: src/main/chatgpt-companion.ts                        │
│                  - 独立 BrowserWindow (persist:ai_solo_chatgpt)        │
│                  - 双权限全拒绝 (Request / Check Handlers)              │
│                  - 弹窗、302 重定向、跨域 iframe 子框架全拦截          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 直接 Node 调用 (纯 Node，无 Electron 依赖)
┌───────────────────────────────────▼────────────────────────────────────┐
│ 3. 业务编排层 (Application Layer: src/core/app/)                       │
│    task-controller.ts: 全局编排中枢 (TaskController) 协调状态流转与UI   │
│    ai-settings.ts, discussion-service.ts, open-projects.ts,            │
│    provider-profiles.ts, subscription-clis.ts, task-view.ts            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         ▼                          ▼                          ▼
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│ 4. 任务与调度    │       │ 5. 隔离与安全    │       │ 6. 证据与持久化  │
│ task/runner.ts   │       │ git/git.ts       │       │ persistence/     │
│ task/state.ts    │       │ policy/risk.ts   │       │   store.ts       │
│ executor/types   │       │ checks/scripts.ts│       │ persistence/     │
│ proc/run.ts      │       │ env/health.ts    │       │   volume.ts      │
│                  │       │                  │       │ acceptance/      │
│                  │       │                  │       │   card.ts,view.ts│
└──────────────────┘       └──────────────────┘       └──────────────────┘
```

---

## 二、 核心子系统与实际源码路径速查

| 子系统模块 | 真实源码文件路径 | 核心接口 / 类 / 真实函数 | 关键职责与调用约束 |
|---|---|---|---|
| **主进程外壳** | `src/main/index.ts` | `createWindow`, `ipcMain.handle` | 维护 `BrowserWindow` 安全参数（`contextIsolation: true`, `sandbox: true`, `webviewTag: false`，见 `src/main/index.ts:247`）；统一注册 IPC 监听（`tasks:*`, `acceptance:*`, `chatgpt:*`），分发至对应 `projectId` 的 `TaskController` 或 `chatgptCompanion`。 |
| **预加载层** | `src/preload/index.cts` | `contextBridge.exposeInMainWorld` | 严格暴露 `window.studio` 白名单方法（方法签名均显式接收 `projectId` 参数，及 `openChatGPTCompanion`、`closeChatGPTCompanion` 等伴侣方法），严禁泄漏 Node 原生 `fs` 或敏感全局对象。 |
| **ChatGPT 安全伴侣视界** | `src/main/chatgpt-companion.ts` | `ChatGPTCompanionManager`<br>`isAllowedChatGPTUrl`<br>`chatgptCompanion` | 独立 BrowserWindow、专属持久分区 `persist:ai_solo_chatgpt`、`sandbox: true`、`contextIsolation: true`、零 preload 注入；双重权限全拒绝（`setPermissionRequestHandler` / `setPermissionCheckHandler`）；弹窗拦截、服务端 302 重定向拦截、跨域 iframe 子框架导航拦截；页面加载失败感知并提供系统浏览器安全降级。主渲染层仅能通过 open/close/status/system-browser IPC 控制伴侣窗口，无读取其 DOM 的 IPC 通道（`src/preload/index.cts:84-87`、`src/main/index.ts:739-742`）。 |
| **方案解析与导入门禁** | `src/renderer/planParser.ts` | `parsePlanFromText`<br>`extractCodeBlocks`<br>`serializePlanForTask` | 结构化解析方案文本；全要素无静默丢失；明确区分用户核准要求（最高优先级）与原始方案参考（背景说明）；空目标拦截；多项目环境强制显式指定目标项目，提供提交防重锁。 |
| **反馈包脱敏与审查** | `src/renderer/chatgptFeedback.ts` | `sanitizeFeedbackText`<br>`buildChatGPTFeedbackPacket` | 组装格式化 ChatGPT 审查反馈包（含任务ID、目标、执行结果、退出码、真实变更证据、系统体检）；敏感凭证与绝对路径脱敏；文本或选项变动实时重置人工核验状态，未勾选“我已人工核验脱敏内容”禁止复制。 |
| **提取辅助与诚实降级（无跨窗口 DOM 访问）** | `src/renderer/webBridge.ts` | `extractContentFromWebview`<br>`extractMarkdownCodeBlocks` | `extractContentFromWebview` 仅当所选节点具备 `executeJavaScript` 时尝试提取（`webBridge.ts:25-27`）；主窗口 `webviewTag: false`（`src/main/index.ts:247`）且 `#chatgpt-webview` 只是普通 `<div>`（`ChatGPTView.tsx:453-456`），故无法读取独立伴侣窗口 DOM，恒返回诚实降级错误（`webBridge.ts:81-87`），真实交付路径为人工复制/粘贴；绝不静默读取宿主系统剪贴板。 |
| **伴侣交互视图** | `src/renderer/ChatGPTView.tsx` | `ChatGPTView` | 伴侣视界状态监控、加载错误与阻断通知、显式项目选择器、方案预览与确认门禁（预览/确认弹层为组件内内联 JSX，**未导出独立组件**）、提交防重锁。 |
| **应用编排中枢** | `src/core/app/task-controller.ts` | `TaskController` (`create`, `savePlan`, `start`, `saveTask`, `discardTask`) | 主进程 IPC 与核心业务的桥梁，负责请求参数检验、视图装配与高阶业务编排。 |
| **状态机核心** | `src/core/task/state.ts` | `next`, `canFire`, `TaskState`, `TaskEvent` | 纯函数严格状态机。状态转换必须通过 `next(state, event)` 触发，非法迁移抛出 `InvalidTransition`。 |
| **任务调度引擎** | `src/core/task/runner.ts` | `TaskRunner` (`create`, `setPlan`, `approve`, `start`, `save`, `discard`, `confirmScopeChange`) | 调度执行体生命周期，驱动安全保存四步安全流程与隔离清理；保存写入前先完成完整试检查证据集合裁决（真实失败/身份失效硬阻断），写入后强制核对 `mergeCommit === trialCommit`；用户确认范围后的重跑必须取得经统一裁决 `verified` 的新证据。 |
| **安全进程运行** | `src/core/proc/run.ts` | `run`, `runProcess`, `isSuccess` | 底层调用 `node:child_process.spawn`，强制参数数组传参且 `{ shell: false }`，提供优雅停止（SIGINT -> SIGTERM -> SIGKILL）升级。 |
| **Git 隔离工作区** | `src/core/git/git.ts` | `createWorktree`, `createTrialWorktree`, `removeTrialWorktree`, `removeWorktree`, `diffSummary`, `mergeTask` | 任务必须在独立 worktree 沙箱中施工；处理分支检出、试合并与代码差异捕获。 |
| **受控持久化存储** | `src/core/persistence/store.ts` | `RecordStore` (`load`, `commit`, `list`) | 依据 ADR 0005，全系统唯一文件写入者。CAS 乐观锁校验、`.studio/events.jsonl` 事件日志追加、启动对账重建。 |
| **卷兼容性探针** | `src/core/persistence/volume.ts` | `localApfsProbe`, `requireLocalVolume` | 依据 ADR 0005 第 12 条校验数据目录是否为本地 APFS 磁盘，防止网络卷导致锁失效。 |
| **自动化检查（可信证据采集）** | `src/core/checks/scripts.ts` | `detectScripts`, `runCheck`, `runProjectChecks`, `collectApprovedScopeBaseline`, `currentScopeFingerprint` | 静态解析并沙箱执行目标项目中的检查脚本。`build` 以真实进程退出码为证据；`test` 只有取得结构化测试证据才算 `passed`，否则 `failed` / `unverified` / `not_available`。`buildEvidence` 逐项调用 `runCheck`，试合并阶段调用聚合的 `runProjectChecks`。 |
| **统一宿主证据模型** | `src/core/evidence/model.ts`<br>`src/core/evidence/inventory.ts`<br>`src/core/evidence/vitest.ts`<br>`src/core/evidence/validate.ts` | `HostCheckEvidence`, `assessScopeChange`, `readVitestReport`, `evidenceIdentityProblem` | 证据身份（项目/任务/轮次/验收版本/被测 tree/项目根/任务副本）、运行身份、脚本/配置/运行器入口与依赖/测试清单指纹、Vitest JSON 报告完整性（逐项记录是否实际校验）、保守测试范围评估（逐文件下降、内容/辅助文件变化、实际执行范围）. |
| **统一证据裁决** | `src/core/evidence/adjudicate.ts` | `adjudicateEvidence`, `adjudicateStoredProof`, `adjudicateCheckResult`, `adjudicateTaskEvidence`, `adjudicateRoundChecks`, `adjudicateTrialEvidenceSet`, `adjudicateSaveRecord` | 唯一可信裁决入口：类型/任务/轮次/验收版本/内容/项目/副本身份 → 深度失效 → 范围确认 → 失败/未执行/结构性证据 → 通过。`adjudicateTrialEvidenceSet` 额外核对试合并提交/tree、项目/副本哈希、应执行检查集合与实际证据集合、evidenceId 一一对应、每条证据统一裁决；正常保存、持久化与启动恢复共用同一口径。验收卡、证据页、保存门禁、历史轮次、ChatGPT 反馈包事实全部消费此入口，禁止各自解释 `passed`。 |
| **双轨验收卡与证据** | `src/core/acceptance/card.ts`<br>`src/core/acceptance/view.ts`<br>`src/core/acceptance/proof.ts`<br>`src/core/acceptance/proof-status.ts` | `buildCard`, `toUserView`, `buildTaskProof`, `checkInvalidations` | 聚合真实进程事实、Git 真实修改、宿主证据与人工确认项，判定 `readyToSave` 门禁。条目状态区分 `verified` / `failed` / `not_checked` / `unverified`（缺乏有效证据）/ `invalidated`（证据失效）/ `user_confirmed`；证据不足或失效时绝不显示为通过，旧记录不补造测试数量。 |
| **环境体检** | `src/core/env/health.ts`<br>`src/core/env/host-env.ts` | `runHealthCheck` | 检测系统运行环境、磁盘空间、Node/Git 依赖与安全隔离状态。 |

> **ChatGPT 交付路径与信任边界（源码核实，2026-11-24）：** 主窗口以 `webviewTag: false` 创建（`src/main/index.ts:247`）；`#chatgpt-webview` 只是普通 `<div data-webview-enabled="false">`（`src/renderer/ChatGPTView.tsx:453-456`），不是真实 `<webview>`，因此 `extractContentFromWebview()` 无法在主渲染层执行页面脚本（`src/renderer/webBridge.ts:25-27`），只会返回诚实降级错误（`webBridge.ts:81-87`）。ChatGPT 实际运行于独立沙箱 `BrowserWindow`（`src/main/chatgpt-companion.ts:73-86`：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webviewTag: false`、零 preload、独立分区 `persist:ai_solo_chatgpt`）；主渲染层没有任何读取其 DOM 的通道（IPC 仅 open/close/status/system-browser：`src/preload/index.cts:84-87`、`src/main/index.ts:739-742`），Electron 也不允许跨窗口读取另一 `BrowserWindow` 的 DOM。真实交付路径为人工复制/粘贴（用户主动点击「📋 从剪贴板粘贴」`ChatGPTView.tsx:491-494`、输入框 `:519-529`、`window.prompt` 兜底 `:225`）；失败时显式提示「未能在网页中捕获到回答…」并给出 `manual-fallback-hint`（`ChatGPTView.tsx:237`、`:504-515`；`webBridge.ts:86`）。`webBridge.ts` 内无任何 `navigator.clipboard` 调用，不静默窃取剪贴板；剪贴板读取只发生在用户主动点击粘贴按钮时（`ChatGPTView.tsx:131`）。

---

## 二·五、AISS-A1 可信证据链路（本阶段新增）

```
TaskRunner.buildEvidence(task)
  ├─ 计算被测内容 tree（仅剔除「未跟踪」的 .studio/ node_modules 缓存；已跟踪文件的修改/删除完整保留）
  │   └─ 改动清单使用同一内容 tree 与基线做 git diff-tree（不写工作树索引）
  ├─ 构造 EvidenceIdentityContext { projectRoot, taskId, round, acceptanceRev, testedTree, baselineRev=worktree.baseSha, approvedScope=checkAuth.scope }
  ├─ runCheck(worktree, 'build'|'test', sandboxRunner, { authorizedDigest, identity })
  │    ├─ build：真实进程退出码 → passed / failed
  │    └─ test ：Vitest 且脚本可安全追加参数 → 注入 JSON 报告器
  │         ├─ readVitestReport：随机路径 / 运行窗口 / 计数一致性 / stdout 交叉核对
  │         ├─ assessTestScope：相对基线提交比较测试文件/测试块/断言/skip/only/配置/运行器/锁文件
  │         └─ 结论顺序：失败 > 报告完整性 > 零测试 > 全部跳过 > 非 0 退出 > 范围削弱 > passed
  ├─ tree 前后比对：运行期间内容变化 → 证据作废（source_changed_during_check）
  ├─ toStoredCheckProofs：StoredCheckProof 携带 HostCheckEvidence
  └─ buildCard：条目状态按证据语义生成；测试范围削弱记录 scopeChange（需用户显式重新确认）

recheck(task)            → acceptanceRev+1、清空全部确认、重新采集证据（旧证据/旧未检查确认失效）
save(task) 试合并         → runProjectChecks(同一证据语义) + 检查前后 tree 比对
                          → 原验收证据与试检查结果不一致 → acceptance_inconsistent 阻断
                          → 写入主项目之前：adjudicateTrialEvidenceSet（trialCommit/tree、项目/副本、集合完整性、
                            evidenceId、逐条裁决）→ 失败/身份失效硬阻断；checked 但集合未 verified 也阻断
                          → git merge --ff-only 后：mergeCommit === trialCommit 强制核对 + 任务内容漂移核对
启动核对 reconcileTasks   → revalidateStoredEvidence：身份/脚本/配置/运行器漂移 → evidenceInvalid（证据失效）
                           （只记录事实，不改写历史轮次）
```

保存门禁的硬阻断边界（源码核实，2026-11-25）：`confirmUnchecked` 只放行「未检查」本身，绝不放行真实失败、身份失效、试检查证据集合不一致或其他既定硬阻断；合法的未检查保存仍走原有用户明确确认。

用户显式动作：`TaskController.confirmScopeChange(id, version)`（preload `confirmScopeChange` → IPC `acceptance:confirm-scope-change`）→ 校验内容指纹+范围指纹+验收版本 → 清空旧验收决定 → 按当前范围重新生成证据 → **重跑证据必须通过统一裁决且为 `verified`**（报告完整性/stdout 交叉核对/身份/失败优先）→ 才写入 `confirmedAt` 并绑定确认；否则保持待确认并继续阻断保存。保存/试合并消费该确认（未确认或已失效 → 硬阻断），保存成功后清理。自动反馈闭环不得调用。

检查运行环境：标准模式 Seatbelt 配置档额外允许「向自己的子进程发信号」（Vitest 结束 worker 需要），仍禁止向外进程发信号；检查进程 `TMPDIR` 位于副本 `.studio/tmp`，并设置 `GIT_CEILING_DIRECTORIES=<副本>/.studio`（不扩大沙箱写权限的前提下避免测试进程把临时目录误认为项目仓库）；运行前在副本内创建空的 `node_modules/`，让 Vite/Vitest 的配置临时文件写入副本而不是主项目依赖目录。

## 三、 跨层调用与关键业务真实时序流（严格对齐源码与完整参数）

### 1. 任务创建与计划拟定阶段 (Draft & Plan Phase)
*注意：此阶段仅在主仓库持久化记录，**绝不创建任何 Git worktree**。Preload API 严格传入 `projectId`。*
```
Renderer (用户输入需求点击创建)
  └──► Preload: window.studio.createTask(projectId, request)
        └──► Main: ipcMain.handle('tasks:create', (_e, projectId, request))
              └──► controllerFor(projectId).create(request)
                    └──► TaskRunner.create(request)
                          └──► RecordStore.commit() (落盘 draft 记录与事件日志)

Renderer (用户编辑确认计划表单)
  └──► Preload: window.studio.savePlan(projectId, id, plan)
        └──► Main: ipcMain.handle('tasks:savePlan', (_e, projectId, id, plan))
              └──► controllerFor(projectId).savePlan(id, plan)
                    └──► TaskRunner.setPlan(id, plan)
                          └──► RecordStore.commit() (状态流转为 planned)
```

### 2. 任务开工与隔离施工阶段 (Start & Execution Phase)
*注意：只有在此阶段批准开工后，TaskRunner 才真正调用 Git 创建独立 worktree 并拉起执行进程。*
```
Renderer (用户勾选知情确认并点击开工)
  └──► Preload: window.studio.startTask(projectId, id, ack)
        └──► Main: ipcMain.handle('tasks:start', (_e, projectId, id, ack))
              └──► controllerFor(projectId).start(id, ack)
                    ├──► TaskRunner.approve(id) (状态迁至 approved)
                    └──► TaskRunner.start(id) (异步执行内部 runTask)
                          ├──► G.detectExternalDrivers(repo) (防线：确保主项目无外部不可控驱动)
                          ├──► G.createWorktree(repo, taskId) (★检出独立 worktree 目录与分支)
                          ├──► fire(t, 'start') (状态跃迁: approved -> running)
                          ├──► activeExecutor.start({ cwd: worktree.path, prompt, ... })
                          └──► proc/run.ts: runProcess() (安全参数数组，shell: false 子进程运行)
```

### 3. 施工结束与验收准备阶段 (Reviewing & Proof Phase)
*注意：执行体正常退出时状态先跃迁至 `exec_succeeded`，构建证据完成后再跃迁至 `reviewing`；证据构建中对 'build' 和 'test' 逐项调用 `runCheck()`。*
```
TaskRunner (执行体子进程退出码 0: kind === 'exited' && code === 0)
  ├──► fire(t, 'exec_exit_ok') (状态跃迁: running -> exec_succeeded)
  └──► TaskRunner.review(t)
        ├──► TaskRunner.buildEvidence(t)
        │     ├──► G.diffSummary(worktree) (捕获当前 worktree 的真实文件变动)
        │     ├──► G.computeTree(repo, worktree.path) (计算初次 acceptedTree)
        │     ├──► 循环执行各项检查: runCheck(worktree.path, 'build', ...) 与 runCheck(worktree.path, 'test', ...)
        │     ├──► G.computeTree 再次核验：若检查脚本产生文件副作用导致 tree 改变，置 t.checksVoid
        │     ├──► G.saveRoundRef 保存本轮 Git 引用快照
        │     └──► buildCard(...) (装配验收卡并存储于 t.card)
        ├──► fire(t, 'review') (状态跃迁: exec_succeeded -> reviewing)
        └──► RecordStore.commit() (持久化 reviewing 终态与 events.jsonl)

Renderer (切入验收卡视图)
  └──► Preload: window.studio.getAcceptanceView(projectId, id)
        └──► Main: ipcMain.handle('acceptance:get', (_e, projectId, id))
              └──► controllerFor(projectId).getAcceptanceView(id)
                    └──► TaskController.acceptanceView(task)
                          └──► acceptance/view.ts: toUserView(task, ...) (装配前端展示视图)
```

### 4. 双轨验收确认与保存合并阶段 (Acceptance & Save Phase)
*注意：`TaskRunner.save()` 包含四步刚性安全流程；试合并阶段的自动化检查调用的是聚合检查函数 `runProjectChecks()`。*
```
Renderer (用户核对视觉与改动，确认各项验收标准后点击保存)
  └──► Preload: window.studio.saveTask(projectId, id, version)
        └──► Main: ipcMain.handle('acceptance:save', (_e, projectId, id, version))
              └──► controllerFor(projectId).saveTask(id, version)
                    └──► TaskController.runSave(id, version, confirmUnchecked=false)
                          └──► TaskRunner.save(id, opts)
                                │
                                ├──► 【Step 1：状态与项目防线核验】
                                │     ├── 核查状态为 reviewing，无运行中锁；
                                │     ├── G.detectExternalDrivers (主项目与副本均无外置驱动)；
                                │     ├── 核对主项目工作区干净 (G.dirtyFiles 为空) 且分支一致；
                                │     └── 重新计算 G.computeTree 严格比对已冻结的 t.acceptedTree。
                                │
                                ├──► 【Step 2：临时副本试合并 (Trial Merge)】
                                │     ├── G.commitTree 生成任务独立提交 (taskCommit)；
                                │     ├── G.createTrialWorktree 创建临时隔离副本 (trialPath)；
                                │     └── G.git(trialPath, ['merge', '--no-ff', taskCommit]) 尝试合并：
                                │           若冲突，捕获冲突文件并触发 'save_conflict' (迁至 save_failed_unmerged)，主项目保持 100% 干净。
                                │
                                ├──► 【Step 3：试合并后的自动检查 (Trial Checks)】
                                │     └── TaskRunner.runTrialChecks(t, trialPath)
                                │           └──► runProjectChecks(trialPath, sandbox, opts) (聚合执行可用检查)：
                                │                 在试合并结果上复跑检查，若失败则拒绝保存并清理临时副本；
                                │                 若无检查脚本，需经 confirmUnchecked 显式确认后方可继续。
                                │
                                ├──► 【Step 3.5：写入前完整证据集合裁决 (Pre-Write Evidence Set Gate)】
                                │     └── adjudicateTrialEvidenceSet({ trialCommit, trialCommitTree, expectedChecks,
                                │           evidenceIds, checks, projectRootHash, trialWorktreePathHash }):
                                │           身份/集合不一致或真实失败 → 硬阻断（confirmUnchecked 不能绕过）；
                                │           checked 但集合未 verified → 阻断；合法未检查保存按用户确认放行。
                                │
                                ├──► 【Step 4：主项目最终快速合并与安全收尾 (Fast-Forward Merge)】
                                │     ├── 再次核验主项目未被并发篡改 (currentHead === preHead)；
                                │     ├── G.git(repo, ['merge', '--ff-only', trialCommit]) 瞬间推进主线；
                                │     ├── 无论成功失败立即调用 cleanupTrial() 销毁临时 worktree；
                                │     ├── G.removeWorktree(repo, task.worktree) 清理任务施工工作树与分支；
                                │     └── RecordStore.commit() CAS 写入 saved 终态与 events.jsonl。
```

### 5. ChatGPT 网页交互、方案受控导入与反馈审查时序流 (P0-2 Flow)
*注意：本链路为严格的人工确认式（Human-in-the-loop）交互，绝不直接将网页文本静默写入执行，绝不伪造无感全自动通信通道。*
```
【伴侣视界拉起与状态监听】
Renderer (ChatGPTView)
  └──► Preload: window.studio.openChatGPTCompanion()
        └──► Main: ipcMain.handle('chatgpt:openCompanion')
              └──► chatgptCompanion.openCompanion()
                    ├──► BrowserWindow 创建 (persist:ai_solo_chatgpt, contextIsolation, sandbox)
                    ├──► setupWebContentsSecurity (双权限全拒绝, will-navigate/redirect/frame 拦截)
                    └──► loadURL('https://chatgpt.com') (若遇网络阻断，记录 lastLoadError 并向 UI 报告)

【方案提取、门禁解析与任务创建】
Renderer (用户手动粘贴方案；「从伴侣提取」仅为兼容入口，实际恒降级为手动)
  ├──► webBridge: extractContentFromWebview() (主窗口无真实 `<webview>`，无法读取独立伴侣窗口 DOM，恒返回诚实降级错误，随后走人工粘贴，不偷窃剪贴板)
  ├──► planParser: parsePlanFromText(rawText) (解析结构化字段；全要素保留；用户修改覆盖原始值)
  ├──► 多项目环境拦截：强制用户显式选定 targetProjectId，未选则拦截创建
  └──► 用户确认方案点击创建 (提供 isSubmitting 防重锁)
        └──► Preload: window.studio.createTask(targetProjectId, serializedRequest)
              └──► Main: ipcMain.handle('tasks:create', ...) -> TaskController.create()

【任务执行后审查反馈包生成与脱敏人工核验】
Renderer (TaskPage 任务完成或需向 ChatGPT 复核时)
  ├──► chatgptFeedback: buildChatGPTFeedbackPacket(task, projectName?, options?) (真实签名见 `src/renderer/chatgptFeedback.ts:52-56`)
  │     └──► 区分宿主真实检查事实与 AI 自述；组合退出码、变动证据、系统体检
  ├──► TaskPage 内联反馈包审查模态框（`TaskPage.tsx:207` 的 `showFeedbackModal` 分支，**未导出独立组件**）
  │     ├──► sanitizeFeedbackText() (脱敏绝对路径与潜在 API Key)
  │     └──► 变动感知：用户编辑文本或切换脱敏选项时，实时重置 hasConfirmedReview = false
  └──► 复制门禁：用户必须主动勾选“我已人工核验脱敏内容”后，复制按钮方可解锁
```

---

## 四、 核心测试套件与安全防线映射

| 关注领域 | 核心测试套件文件 | 覆盖的真实安全红线与断言 |
|---|---|---|
| **ChatGPT 安全视界与方案/反馈** | `tests/chatgpt-secure-interaction.test.ts` | • `isAllowedChatGPTUrl` 域名白名单与非 https 协议拦截<br>• BrowserWindow 沙箱隔离与专属持久分区（`persist:ai_solo_chatgpt`）<br>• 双权限全拦截（`permissionRequestHandler` 与 `permissionCheckHandler` 均返回 `false`）<br>• 弹窗、302 服务端重定向、跨域 iframe 子框架全拦截且不静默唤起外部应用<br>• 方案全要素保留（无静默丢失）、用户修改优先、空目标拦截<br>• 反馈包生成、路径/敏感凭证脱敏与人工核验状态重置 |
| **Electron 端到端真实安全拦截** | `e2e/shell.e2e.ts` | • 真实 Chromium 权限查询（`navigator.permissions.query` 确认为 `denied`，杜绝测试假阳性）<br>• 服务端 302 重定向到外部域名真实阻断断言<br>• 跨域 iframe 子框架逃逸导航拦截断言<br>• 伴侣视界生命周期与方案导入流程真实 UI 闭环 |
| **架构与安全边界** | `tests/security.test.ts` | • `contextIsolation: true`, `sandbox: true`<br>• ADR 0006 约束：除 `persistence/` 外，`src/` 无直接文件写入<br>• 严禁向执行体传入跳过权限参数 |
| **数据并发与崩溃恢复** | `tests/adr-0005-scenarios.test.ts`<br>`tests/persistence.test.ts` | • CAS 乐观并发冲突拦截与日志告警<br>• 进程强制终止后，启动依据 `events.jsonl` 对账重建<br>• 过期 `runId` 迟到写入强制丢弃 |
| **状态机严格流转** | `tests/state.test.ts` | • 非法状态跃迁抛出 `InvalidTransition`<br>• `exec_succeeded` 绝不能直接跃迁至 `saved` |
| **双轨验收与保存门禁** | `tests/acceptance.test.ts`<br>`tests/save-safety.test.ts` | • 退出码非 0 或检查失败时强制 `readyToSave = false`<br>• 用户未勾选验收标准时严格锁定保存按钮 |
| **A1 可信证据链（单测/集成）** | `tests/a1-evidence-chain.test.ts`<br>`tests/a1-trusted-evidence.test.ts`<br>`tests/r1-trusted-evidence.test.ts`<br>`tests/r2-trusted-evidence.test.ts`<br>`tests/r3-trusted-evidence.test.ts`<br>`tests/r4-trusted-evidence.test.ts` | • 可信测试通过语义（真实 Vitest JSON + stdout 交叉核对）<br>• 失败优先、身份/版本/tree/项目/副本身份核对<br>• 试检查证据绑定 trialCommit 及其 tree；保存前集合裁决<br>• 范围削弱需用户确认；确认后重跑必须取得有效新证据<br>• 未检查保存只放行未检查，不能绕过硬阻断<br>• 持久化/启动恢复/历史展示复用同一裁决 |
| **A1 真实反向探针（独立 CI 门禁）** | `tests/r3-probes/*.probe.ts`（20）<br>`tests/r4-probes/*.probe.ts`（20）<br>`tests/closeout-probes/*.probe.ts`（5） | • 45 项真实 Git / 真实 Vitest / 真实 RecordStore / 真实 SIGKILL 反向探针<br>• 由 `vitest.probes.config.ts` 收集，`.github/workflows/ci.yml` 的 `probes` job 在 Ubuntu + macOS 运行<br>• 旧候选同一组新探针 4 failed / 1 passed；新候选 45/45 passed |
| **环境与启动冒烟** | `scripts/smoke.mjs` | • Electron 无头启动，DevTools 安全策略零报错 |

---

## 五、 未合入主线的在研原型清单（In-Progress / Draft）

以下文件存在于本地在研工作区（`/Users/jamesho/ai-solo-studio-rebuild`）或特定实验分支中，**尚未正式合并入主线 `rebuild`**，严禁误作为当前主线架构依据：
1. `src/core/app/autonomous-feedback-loop.ts`（原工作区未提交文件 `??`，闭环反馈自愈实验原型）
2. `src/core/thinking/chatgpt-devkit.ts`（原工作区未提交文件 `??`，本地思考协议开发包原型；**明确与 PR #3 无关**，PR #3 仅包含独立伴侣窗口（BrowserWindow）安全隔离）
3. `tests/autonomous-feedback-loop.test.ts`（原工作区未提交文件 `??`，对应自愈测试原型）
4. `src/renderer/novice/`（新手建站向导组件规划，待 PRD 裁定开工）

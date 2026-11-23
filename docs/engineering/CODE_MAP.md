# AI Solo Studio — 核心代码地图 (CODE_MAP)

**版本：** v1.4 (R3 Closeout Final)  
**基线分支：** `origin/rebuild` (`443773c` / PR #2 Merged)  
**真实性原则：** 100% 经由真实源码导出与调用实现核对；Preload API 明确展示完整入参（包括 `projectId`）；严格区分 `runCheck()` 与 `runProjectChecks()`；未合入主线的在研原型不画入当前架构。

---

## 一、 系统全景与模块分层架构

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. 渲染层 (Renderer: React 19 + Vite, 沙箱隔离环境)                    │
│    入口: src/renderer/index.html -> main.tsx -> App.tsx                │
│    视图: Workbench.tsx, ProjectBoard.tsx, SettingsPage.tsx,            │
│          TaskPage.tsx, Acceptance.tsx, DiffPreview.tsx                 │
│    通信接口: window.studio.* (经 contextBridge 暴露的白名单 API)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ IPC (invoke / on)
┌───────────────────────────────────▼────────────────────────────────────┐
│ 2. 预加载与主进程 (Preload & Main: Electron 安全外壳)                   │
│    preload 入口: src/preload/index.cts (白名单路由与参数类型校验)      │
│    main 入口:    src/main/index.ts (窗口初始化、CSP、IPC 注册与分发)    │
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
| **主进程外壳** | `src/main/index.ts` | `createWindow`, `ipcMain.handle` | 维护 `BrowserWindow` 安全参数（`contextIsolation: true`, `sandbox: true`）；统一注册 IPC 监听（`tasks:*`, `acceptance:*` 等），分发至对应 `projectId` 的 `TaskController`。 |
| **预加载层** | `src/preload/index.cts` | `contextBridge.exposeInMainWorld` | 严格暴露 `window.studio` 白名单方法（方法签名均显式接收 `projectId` 参数），严禁泄漏 Node 原生 `fs` 或敏感全局对象。 |
| **应用编排中枢** | `src/core/app/task-controller.ts` | `TaskController` (`create`, `savePlan`, `start`, `saveTask`, `discardTask`) | 主进程 IPC 与核心业务的桥梁，负责请求参数检验、视图装配与高阶业务编排。 |
| **状态机核心** | `src/core/task/state.ts` | `next`, `canFire`, `TaskState`, `TaskEvent` | 纯函数严格状态机。状态转换必须通过 `next(state, event)` 触发，非法迁移抛出 `InvalidTransition`。 |
| **任务调度引擎** | `src/core/task/runner.ts` | `TaskRunner` (`create`, `setPlan`, `approve`, `start`, `save`, `discard`) | 调度执行体生命周期，驱动安全保存四步安全流程与隔离清理。 |
| **安全进程运行** | `src/core/proc/run.ts` | `run`, `runProcess`, `isSuccess` | 底层调用 `node:child_process.spawn`，强制参数数组传参且 `{ shell: false }`，提供优雅停止（SIGINT -> SIGTERM -> SIGKILL）升级。 |
| **Git 隔离工作区** | `src/core/git/git.ts` | `createWorktree`, `createTrialWorktree`, `removeTrialWorktree`, `removeWorktree`, `diffSummary`, `mergeTask` | 任务必须在独立 worktree 沙箱中施工；处理分支检出、试合并与代码差异捕获。 |
| **受控持久化存储** | `src/core/persistence/store.ts` | `RecordStore` (`load`, `commit`, `list`) | 依据 ADR 0005，全系统唯一文件写入者。CAS 乐观锁校验、`.studio/events.jsonl` 事件日志追加、启动对账重建。 |
| **卷兼容性探针** | `src/core/persistence/volume.ts` | `localApfsProbe`, `requireLocalVolume` | 依据 ADR 0005 第 12 条校验数据目录是否为本地 APFS 磁盘，防止网络卷导致锁失效。 |
| **自动化检查** | `src/core/checks/scripts.ts` | `detectScripts`, `runCheck`, `runProjectChecks` | 静态解析并沙箱执行目标项目中的检查脚本。`buildEvidence` 逐项调用 `runCheck`，试合并阶段调用聚合的 `runProjectChecks`。 |
| **双轨验收卡与证据** | `src/core/acceptance/card.ts`<br>`src/core/acceptance/view.ts`<br>`src/core/acceptance/proof.ts` | `buildCard`, `toUserView`, `buildTaskProof` | 聚合退出码、Git 真实修改、检查结果与人工确认项，判定 `readyToSave` 门禁。 |
| **环境体检** | `src/core/env/health.ts`<br>`src/core/env/host-env.ts` | `runHealthCheck` | 检测系统运行环境、磁盘空间、Node/Git 依赖与安全隔离状态。 |

---

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
                                ├──► 【Step 4：主项目最终快速合并与安全收尾 (Fast-Forward Merge)】
                                │     ├── 再次核验主项目未被并发篡改 (currentHead === preHead)；
                                │     ├── G.git(repo, ['merge', '--ff-only', trialCommit]) 瞬间推进主线；
                                │     ├── 无论成功失败立即调用 cleanupTrial() 销毁临时 worktree；
                                │     ├── G.removeWorktree(repo, task.worktree) 清理任务施工工作树与分支；
                                │     └── RecordStore.commit() CAS 写入 saved 终态与 events.jsonl。
```

---

## 四、 核心测试套件与安全防线映射

| 关注领域 | 核心测试套件文件 | 覆盖的真实安全红线与断言 |
|---|---|---|
| **架构与安全边界** | `tests/security.test.ts` | • `contextIsolation: true`, `sandbox: true`<br>• ADR 0006 约束：除 `persistence/` 外，`src/` 无直接文件写入<br>• 严禁向执行体传入跳过权限参数 |
| **数据并发与崩溃恢复** | `tests/adr-0005-scenarios.test.ts`<br>`tests/persistence.test.ts` | • CAS 乐观并发冲突拦截与日志告警<br>• 进程强制终止后，启动依据 `events.jsonl` 对账重建<br>• 过期 `runId` 迟到写入强制丢弃 |
| **状态机严格流转** | `tests/state.test.ts` | • 非法状态跃迁抛出 `InvalidTransition`<br>• `exec_succeeded` 绝不能直接跃迁至 `saved` |
| **双轨验收与保存门禁** | `tests/acceptance.test.ts`<br>`tests/save-safety.test.ts` | • 退出码非 0 或检查失败时强制 `readyToSave = false`<br>• 用户未勾选验收标准时严格锁定保存按钮 |
| **环境与启动冒烟** | `scripts/smoke.mjs` | • Electron 无头启动，DevTools 安全策略零报错 |

---

## 五、 未合入主线的在研原型清单（In-Progress / Draft）

以下文件存在于本地在研工作区（`/Users/jamesho/ai-solo-studio-rebuild`）或特定实验分支中，**尚未正式合并入主线 `rebuild`**，严禁误作为当前主线架构依据：
1. `src/core/app/autonomous-feedback-loop.ts`（原工作区未提交文件 `??`，闭环反馈自愈实验原型）
2. `src/core/thinking/chatgpt-devkit.ts`（原工作区未提交文件 `??`，本地思考协议开发包原型；**明确与 PR #3 无关**，PR #3 仅包含 Webview 安全伴侣）
3. `tests/autonomous-feedback-loop.test.ts`（原工作区未提交文件 `??`，对应自愈测试原型）
4. `src/renderer/novice/`（新手建站向导组件规划，待 PRD 裁定开工）

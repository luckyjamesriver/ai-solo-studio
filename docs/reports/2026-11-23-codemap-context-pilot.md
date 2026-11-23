# AI Solo Studio — 代码地图与项目记忆专项证据报告 (R3 Closeout)

- **TASK_ID**：`AISS-CODEMAP-CONTEXT-PILOT-R3-CLOSEOUT`
- **日期**：2026-11-23
- **目标分支**：`rebuild`
- **基线 HEAD**：`443773c` (`origin/rebuild` / PR #2 Merged)
- **完成状态**：`READY_FOR_REVIEW` (AISS_CODEMAP_CONTEXT_READY_FOR_INDEPENDENT_REVIEW)

---

## 一、 R3 Closeout 最终精准性修订对照表

本轮修订严格落实维护者提出的 7 项收尾要求，对 `CODE_MAP.md`、`CURRENT_BASELINE.md` 及索引状态进行了最终核验与固化：

| # | 检查项 | 前置状态 | 最终修正与核验记录 | 源码依据位置 |
|---|---|---|---|---|
| **1** | **Preload API 完整入参** | 仅展示简略入参（如 `createTask(request)`） | 补全 Preload 全部方法对 `projectId` 的显式入参要求：<br>• `createTask(projectId, request)`<br>• `savePlan(projectId, id, plan)`<br>• `startTask(projectId, id, ack)`<br>• `getAcceptanceView(projectId, id)`<br>• `saveTask(projectId, id, version)` | `src/preload/index.cts:28-66`<br>`src/main/index.ts:167-210` |
| **2** | **施工结束状态跃迁流** | 简写为 `approved -> running -> reviewing` | 如实呈现真实两段跃迁：<br>1. 进程退出码 0 时触发 `exec_exit_ok`，由 `running -> exec_succeeded`；<br>2. `TaskRunner.review()` 完成证据构建后触发 `review`，由 `exec_succeeded -> reviewing`。 | `src/core/task/runner.ts:515-520`<br>`src/core/task/state.ts:25-33` |
| **3** | **检查函数精准分工** | 混淆 `runCheck` 与 `runProjectChecks` | 明确区分两者：<br>• `buildEvidence` 逐项遍历执行：`runCheck(wt.path, 'build', ...)` 与 `runCheck(wt.path, 'test', ...)` 并校验副作用；<br>• `save()` 试合并阶段调用聚合检查：`runTrialChecks()` -> `runProjectChecks(trialPath, ...)`。 | `src/core/task/runner.ts:536-545`<br>`src/core/task/runner.ts:634-645`<br>`src/core/checks/scripts.ts:77,157` |
| **4** | **源码级调用链核验** | 曾声称“100% 匹配”但存在参数未对齐 | 经 Python 脚本逐函数对齐调用方、参数表与异步执行时序，附带机械校验日志，不再使用绝对化定性词。 | 见第二节实测校验记录 |
| **5** | **CRG 索引同步** | 索引 HEAD 停留在 `ef7ec40` | 执行 `code-review-graph update` 完成增量同步，HEAD 推进至 `a975dff`（214 文件，2989 节点，47146 边，数据库大小 52MB）。 | `code-review-graph status` 实测 |
| **6** | **CI 结果核验** | 本地核对 | GitHub Actions 运行通过：Ubuntu 最新 CI Job `test (ubuntu-latest)` 成功完成；macOS 构建通过。 | GitHub Run #45155681540 |
| **7** | **解耦与工作区防护** | 保持解耦与隔离 | PR #5 仅包含 5 个文档与配置改动，与 PR #4 完全解耦；原工作区 8 个未提交文件完好无损。 | `git status` 真实核验 |

---

## 二、 机械化调用与参数校验记录 (Automated Trace Log)

```
[PASS] src/preload/index.cts:
  - createTask: (projectId, request) => ipcRenderer.invoke('tasks:create', projectId, request)
  - savePlan: (projectId, id, plan) => ipcRenderer.invoke('tasks:savePlan', projectId, id, plan)
  - startTask: (projectId, id, ack) => ipcRenderer.invoke('tasks:start', projectId, id, ack)
  - getAcceptanceView: (projectId, id) => ipcRenderer.invoke('acceptance:get', projectId, id)
  - saveTask: (projectId, id, version) => ipcRenderer.invoke('acceptance:save', projectId, id, version)

[PASS] src/main/index.ts IPC Handlers:
  - tasks:create -> controllerFor(projectId).create(request)
  - tasks:savePlan -> controllerFor(projectId).savePlan(id, plan)
  - tasks:start -> controllerFor(projectId).start(id, ack)
  - acceptance:get -> controllerFor(projectId).getAcceptanceView(id)
  - acceptance:save -> controllerFor(projectId).saveTask(id, version)

[PASS] State Machine Transitions:
  - running + exec_exit_ok -> exec_succeeded
  - exec_succeeded + review -> reviewing
  - reviewing + save -> saved

[PASS] Check Runner Invocations:
  - TaskRunner.buildEvidence() -> runCheck(wt.path, name, ...)
  - TaskRunner.runTrialChecks() -> runProjectChecks(trialPath, sandbox, ...)
```

---

## 三、 交付文件清单

1. `docs/CURRENT_BASELINE.md`：三层工程状态（已合并/PR待审/本地在研）及 ADR 0010 决策优先级。
2. `docs/engineering/CODE_MAP.md`：完整 Preload 参数、准确时序流（含 `exec_succeeded -> reviewing`）与检查函数真实调用的代码地图。
3. `docs/engineering/INDEX_PILOT_EVALUATION.md`：CRG 索引试点数据、INDEX_STALE 动态流转验证与降级机制。
4. `docs/reports/2026-11-23-codemap-context-pilot.md`：本专项 R3 Closeout 完整证据报告与实测记录。
5. `.gitignore`：排除 `.code-review-graph/` 与 `.graphify/` 索引数据库。

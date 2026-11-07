# AI Solo Studio — 架构设计 v1.4

配套文档：`REQUIREMENTS_REPORT.md` v1.4

## 1. 总体结构

```
Renderer (React + Vite, sandbox)          界面：环境体检 / 项目 / 任务 / 历史
   │  window.studio.*（preload 白名单 API）
Preload (contextBridge, CommonJS)
   │  ipcRenderer.invoke
Main process (Electron)                   IPC 处理、参数校验、对话框
   │
core/（纯 Node，无 Electron 依赖，可独立测试）
  proc/        子进程：参数数组、不经 shell、真实退出码、超时、停止升级信号
  task/        状态机、任务模型、持久化（项目内 .studio/tasks/*.json）、编排器
  git/         仓库检测与初始化、worktree、diff、合并、撤销、保存点、回退
  executor/    统一接口 + adapters/{fake, (M2) claude-code | codex}
  policy/      权限请求风险分级与自动批准规则
  checks/      build / test 脚本探测与运行
  acceptance/  汇总真实证据 → 验收卡
  env/         环境体检
```

渲染进程无法传入任意路径：只能操作用户通过系统对话框选中的项目。

## 2. 任务状态机

```
draft ─┬─► clarifying ─► draft
       └─► planned ─► approved ─► running
running ─► exec_succeeded | exec_failed | stopped | timed_out ─► reviewing
reviewing ─► saved | discarded
reviewing ─► approved（发起修复，回到同一 worktree）
```

- 非法迁移抛错（`tests/state.test.ts`）。
- `exec_succeeded` 只表示执行体退出码为 0，**不代表任务完成**；不能从它直接保存。
- 保存的前提由验收卡 `readyToSave` 决定：执行正常结束、有实际改动、自动检查无失败、验收标准全部由用户确认。

## 3. 执行体接口

见 `src/core/executor/types.ts`。要点：

- `capabilities` 声明是否支持权限询问、是否支持停止后继续。界面据此显示，不伪装能力。
- `start({ cwd })` 的 `cwd` 永远是任务 worktree。
- `respond(id, allow|deny)` 回答权限请求；`stop()` 真实结束底层进程。
- `FakeExecutor` 可按剧本写文件、请求权限、挂起、以任意退出码结束，覆盖全部分支。

## 4. 恢复边界

- 可恢复：worktree 内的文件改动（撤销任务即删除 worktree 与分支）。
- 不可自动恢复：worktree 外写入、联网、依赖安装脚本的副作用、数据库写入、发布。
- `policy/risk.ts` 对每个权限请求给出 `level` 与 `reversible`；越出 worktree 的路径一律高风险、不可恢复、不可自动批准。

## 5. 进程与安全

- 子进程一律 `spawn(cmd, args, { shell: false })`，可执行文件从 PATH 查找。
- 停止：SIGINT → 宽限期 → SIGTERM → 宽限期 → SIGKILL；记为 `stopped`。外部信号终止记为 `signaled`。两者都不算成功。
- Electron：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webviewTag: false`；CSP；禁止页面内导航；外链交给系统浏览器。
- `tests/security.test.ts` 防止这些设置与“跳过权限参数”“写死个人路径”回归。

## 6. 技术栈

TypeScript（strict）· Electron · React 19 · Vite · Vitest · GitHub Actions（Ubuntu + macOS）。M3 起加入 Playwright 做 Electron 端到端测试。

## 7. 验证分工

- 自动化：core 全部逻辑以模拟执行体 + 真实临时 Git 仓库测试；Electron 外壳在 CI 外做无头冒烟测试。
- 本机：真实执行体、真实账号、打包后的端到端。每个里程碑附 `docs/checklists/`。

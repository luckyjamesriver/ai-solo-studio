# AI Solo Studio — 架构设计 v1.4

配套文档：`REQUIREMENTS_REPORT.md` v1.4

## 1. 总体结构

```
┌──────────────────────────── Electron ────────────────────────────┐
│  Renderer (React + Vite, sandboxed)                              │
│    页面：环境体检 / 项目 / 任务（计划卡·施工时间线·验收卡）/ 历史   │
│            │  window.studio.*（preload 暴露的白名单 API）          │
│  ──────────┼────────────────────────────────────────────────────  │
│  Preload (contextBridge)                                         │
│  ──────────┼────────────────────────────────────────────────────  │
│  Main process                                                    │
│    ipc/  ── 参数校验（zod）──►  core/（纯 Node，可独立测试）       │
└──────────────────────────────────────────────────────────────────┘

core/
  task/        任务状态机 + 持久化（项目内 .studio/ 目录，JSON）
  git/         仓库检测、初始化、worktree 创建/删除、diff、合并、保存点
  executor/    Executor 接口 + adapters/{fake, claude-code | codex}
  policy/      权限请求风险分级（low/medium/high）与自动批准规则
  checks/      构建/测试脚本探测与运行、退出码采集
  acceptance/  汇总证据 → 验收卡数据（只认真实信号）
  env/         环境体检（git、node、CLI 是否存在与登录状态）
  proc/        子进程封装：spawn 参数数组、超时、停止、输出采集
```

## 2. 关键设计

### 2.1 任务状态机

```
draft → clarifying? → planned → approved → running
running → (succeeded | failed | stopped | timed_out) → reviewing
reviewing → (saved | discarded)
reviewing → running   （发起修复）
```

- 状态迁移只能由明确事件触发；非法迁移抛错（单元测试覆盖）。
- `succeeded` 仅表示执行体进程以退出码 0 正常结束，**不代表任务完成**。是否完成由验收卡决定。

### 2.2 Executor 接口（草案）

```ts
interface Executor {
  id: string;
  detect(): Promise<{ installed: boolean; loggedIn: 'yes' | 'no' | 'unknown'; version?: string }>;
  start(opts: { cwd: string; prompt: string; model?: string }): ExecutorRun;
}
interface ExecutorRun {
  events: AsyncIterable<ExecutorEvent>;   // message | tool_use | permission_request | exit
  respond(requestId: string, decision: 'allow' | 'deny'): Promise<void>;
  stop(): Promise<void>;                  // 真实中断，先 SIGINT，超时后 SIGTERM/SIGKILL
}
```

- `cwd` 永远是任务 worktree；适配器负责把工作目录限制传给执行体。
- Fake Executor 可脚本化：按剧本产生文件改动、权限请求、成功/失败/挂起，用于测试全部分支。

### 2.3 恢复边界

- Git 可恢复：worktree 内的文件改动。
- 不可自动恢复：worktree 外的写入、依赖全局安装、数据库写入、网络调用、发布。
- policy 模块把权限请求归类；计划卡与审批卡展示“此操作能否撤销”。

### 2.4 进程与安全

- 所有子进程 `spawn(cmd, args, { shell: false })`；可执行文件通过 PATH 查找，不写死路径。
- 停止：SIGINT → 5 秒 → SIGTERM → 5 秒 → SIGKILL；被信号终止记为 `stopped`，绝不视为成功。
- Electron：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，禁止 `webview`；CSP 限制；`setWindowOpenHandler` 一律外部打开。

## 3. 技术栈

TypeScript（strict）· Electron · React 19 · Vite · Vitest（core 单元/集成测试，含真实 git 临时仓库）· Playwright（Electron 端到端，M3 起）· ESLint + Prettier · GitHub Actions（lint、typecheck、test）。

## 4. 目录布局

```
/docs          需求、架构、ADR
/src/core      纯 Node 核心（无 Electron 依赖）
/src/main      Electron 主进程与 IPC
/src/preload   contextBridge
/src/renderer  React 界面
/tests         core 测试与 e2e
/legacy        旧演示代码（只读归档，M1 完成后删除）
```

## 5. 验证分工

- **自动化（CI 与开发沙箱）**：core 全部逻辑以 Fake Executor + 真实临时 git 仓库测试。
- **本机验证（开发者在 macOS 上）**：真实执行体、真实订阅、Electron 打包后的端到端。每个里程碑附验收清单 `docs/checklists/Mx.md`。

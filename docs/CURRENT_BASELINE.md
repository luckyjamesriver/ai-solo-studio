# AI Solo Studio — 当前工程基线 (CURRENT_BASELINE)

**更新时间：** 2026-11-23  
**权威基线分支：** `rebuild`（最新主干 HEAD: `443773c` / PR #2 Merged）  
**状态声明：** `AISS_CODEMAP_CONTEXT_READY_FOR_INDEPENDENT_REVIEW`

---

## 一、 当前工程的三层状态严格划分（按真实 Git 与 PR 状态核查）

为了防止开发过程中将“未提交实验代码”或“待审 PR”误判为“主线已交付架构”，系统工程状态严格区分为三层：

| 层次划分 | 覆盖范围与分支路径 | 当前真实状态与事实边界 |
|---|---|---|
| **第一层：主线已合并 (Mainline Merged)** | 分支：`origin/rebuild`<br>最新 HEAD: `443773c` | • **M0 / M1 / M2 / M3-BASE** 基础架构稳固。<br>• **PR #1 (Merged)**: CI 最小恢复与安全边界（`1b5fe76`）。<br>• **PR #2 (Merged)**: 修复 ADR 0005 存储语义、消除 URL 逃逸、收敛单源 SOP 蓝图（`443773c`）。<br>• 此层代码为目前唯一正式交付代码。 |
| **第二层：独立 PR 待审 (Open PRs Pending Review)** | • **PR #3**: `feat/p0-2-chatgpt-interaction`<br>• **PR #4**: `docs/agent-reporting-standard`<br>• **PR #5**: `feat/codemap-context-pilot` | • **PR #3 (OPEN)**: ChatGPT P0-2 Webview 安全通信桥梁及独立闭环验证（包含 `ChatGPTCompanionManager`、`planParser.ts`、`chatgptFeedback.ts` 等）。<br>• **PR #4 (OPEN)**: 统一 7 字段代理交付回复强制标准与项目级指令文件，等待维护者审查合并。<br>• **PR #5 (本专项, OPEN)**: 代码地图、基线记忆与 CRG 索引试点及失效降级规范。<br>• **独立分支 (未提 PR)**: `docs/novice-website-mode`（新手建站模式 PRD 及 N0-N7 规划 R1/v0.2，本地独立分支已就绪，等待维护者裁定 5 项方案后决定是否提交 PR）。 |
| **第三层：本地工作区在研未提交 (Local In-Progress / Uncommitted)** | 路径：`/Users/jamesho/ai-solo-studio-rebuild`<br>（原工作区未提交文件） | • 包含 8 个未提交修改（`e2e/shell.e2e.ts`, `src/core/app/task-controller.ts`, `src/core/thinking/index.ts`, `App.tsx`, `SettingsPage.tsx` 以及未跟踪的 `autonomous-feedback-loop.ts`, `chatgpt-devkit.ts`, `tests/autonomous-feedback-loop.test.ts`）。<br>• **特别强调**：`src/core/thinking/chatgpt-devkit.ts` 为原工作区本地未跟踪原型文件（`??`），**绝不是 PR #3 的组成部分**。<br>• **严格约束**：受 100% 隔离保护，**严禁画入当前主线架构，不能作为现有代码引用**。 |

---

## 二、 关键决策与架构优先级（Decision Precedence）

当不同文档表述冲突或存在历史演进差异时，严格按以下**最新正式决策优先、高阶架构规则优先**的原则判定：

1. **最高优先级：已批准的正式 ADR 与最新修订**
   - **ADR 0010 (2026-11-11，多执行体与订阅策略)**：
     - **正式修订并覆盖了 ADR 0002 第 1 条与 ADR 0009 第 2.1 条**；
     - 确立“通用 AI API Key 为官方推荐标准”；
     - 允许本地订阅制 CLI（Codex, Claude Code, Antigravity, Cursor），但设立三项刚性门禁：**默认关闭、逐服务商独立风险弹窗人工确认、如实声明权限隔离上限**；
     - **永久保留技术红线**：严禁跨工具接触或盗取外部凭证，严禁回退到无沙箱宿主环境执行项目测试。
   - **ADR 0005 & 0006 (数据存储与代码分层)**：
     - 文件存储为唯一持久化载体；主进程 `PersistenceService`（`store.ts`）为全系统唯一写入者（CAS 乐观锁 + 事件日志 `events.jsonl` + 启动对账）；
     - `.studio/` 绝不入 Git（已列入 `.gitignore`）；`src/` 内部只有 `persistence/` 模块允许直接执行持久化文件写入，UI 与 Agent 严禁绕过。
   - **ADR 0007 & 0008 (测试分层与依赖准入)**：
     - Core 纯逻辑单元测试、Electron 冒烟测试、Playwright E2E 测试严格分层；
     - 新增依赖必须精确版本且发布满 14 天，禁止引入未受审的原生编译模块。
2. **第二优先级：项目级通用规范（`docs/standards/AGENT_REPORTING_STANDARD.md`，PR #4 待审）**
   - 任务交付面向用户的回复强制使用 7 字段固定格式（最多 8 行、300 汉字）；详细证据必须完整落盘于项目文档中，严禁假装通过。
3. **第三优先级：当前基线与代码地图（`CURRENT_BASELINE.md` / `docs/engineering/CODE_MAP.md`）**
   - 必须 100% 映射 `origin/rebuild` 上真实存在的模块、函数签名与测试套件。
4. **历史演进参考：早期报告与草稿（`docs/plans/`、`docs/reports/`）**
   - 仅作为历史演进背景记录，凡与上述 ADR 冲突的早期描述一律失效。

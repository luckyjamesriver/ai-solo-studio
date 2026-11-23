# AI Solo Studio — 当前工程基线 (CURRENT_BASELINE)

**更新时间：** 2026-11-24  
**权威基线分支：** `rebuild`（最新主干 HEAD: `9aecd45` / PR #3 Merged）  
**状态声明：** `AISS_P0_2_CHATGPT_SECURE_INTERACTION_COMPLETE`

---

## 一、 当前工程的三层状态严格划分（按真实 Git 与 PR 状态核查）

为了防止开发过程中将“未提交实验代码”或“待审 PR”误判为“主线已交付架构”，系统工程状态严格区分为三层：

| 层次划分 | 覆盖范围与分支路径 | 当前真实状态与事实边界 |
|---|---|---|
| **第一层：主线已合并 (Mainline Merged)** | 分支：`origin/rebuild`<br>最新 HEAD: `9aecd45` | • **M0 / M1 / M2 / M3-BASE** 基础架构稳固。<br>• **PR #1 (Merged)**: CI 最小恢复与安全边界（`1b5fe76`）。<br>• **PR #2 (Merged)**: 修复 ADR 0005 存储语义、消除 URL 逃逸、收敛单源 SOP 蓝图（`443773c`）。<br>• **PR #4 (Merged)**: 统一 7 字段代理交付回复强制标准与全局工作区规则（`442c73f` / `255e635`）。<br>• **PR #5 (Merged)**: 代码地图、基线记忆与 CRG 索引试点及失效降级规范（`441770f` / `dfa38ef`）。<br>• **PR #3 (Merged)**: ChatGPT 网页安全交互、方案受控导入门禁与审查反馈包（`9aecd45` / `f2900a8`）。<br>• 此层代码为目前正式交付代码。 |
| **第二层：独立 PR 待审 (Open PRs Pending Review)** | • **独立分支 (未提 PR)**: `docs/novice-website-mode` | • **独立分支 (未提 PR)**: `docs/novice-website-mode`（新手建站模式 PRD 及 N0-N7 规划 R1/v0.2，本地独立分支已就绪，等待维护者裁定 5 项方案后决定是否提交 PR）。<br>• 当前无任何 OPEN PR。 |
| **第三层：本地工作区在研未提交 (Local In-Progress / Uncommitted)** | 路径：`/Users/jamesho/ai-solo-studio-rebuild`<br>（原工作区未提交文件） | • 包含 8 个未提交修改（`e2e/shell.e2e.ts`, `src/core/app/task-controller.ts`, `src/core/thinking/index.ts`, `App.tsx`, `SettingsPage.tsx` 以及未跟踪的 `autonomous-feedback-loop.ts`, `chatgpt-devkit.ts`, `tests/autonomous-feedback-loop.test.ts`）。<br>• **特别强调**：`src/core/thinking/chatgpt-devkit.ts` 为原工作区本地未跟踪原型文件（`??`），**绝不是 PR #3 的组成部分**。<br>• **严格约束**：受 100% 隔离保护，**严禁画入当前主线架构，不能作为现有代码引用**。 |

---

## 二、 P0-2 安全边界与当前能力明确登记 (ChatGPT Interaction)

1. **已合并提交与分支身份**:
   - PR 编号：#3 (`feat/p0-2-chatgpt-interaction`)
   - PR HEAD：`f2900a8583625dd96fa76e65bdc96e65ec77e774`
   - 主干 MERGE_SHA：`9aecd45d94f0574930f833d83633cf9ac76ae744`
   - 对应详细证据报告：`docs/reports/2026-11-24-chatgpt-interaction-final-delta.md`
2. **已验证功能与技术安全边界**:
   - **强隔离伴侣视界**: 独立 BrowserWindow、专属持久分区 `persist:ai_solo_chatgpt`、`sandbox: true`、`contextIsolation: true`、零 preload 注入、无 Node.js 能力；
   - **受控导航与外部拦截**: 域名严格限定于官方白名单；服务端 302 重定向拦截、跨域 iframe 子框架导航拦截、非白名单弹窗全量拦截；
   - **系统权限双重全拒绝**: 主进程 `setPermissionRequestHandler` 与 `setPermissionCheckHandler` 双全量拒绝，经由真实 Electron DOM 查询核验通过，杜绝测试假阳性；
   - **方案信息完整性与门禁**: 明确区分用户核准要求（最高优先级）与原始方案参考（背景说明），清空目标强制阻断，全要素无静默丢失；多项目环境强制显式指定目标项目，提供提交锁防止并发重复创建；
   - **反馈包安全审查与脱敏**: 区分宿主真实检查事实与 AI 自述；敏感凭证与绝对路径脱敏；外发前强制人工逐行核验，选项与正文改动即时重置核验状态。
3. **未完成事项与后续边界界定**:
   - **登录状态**: 伴侣视界内诚实标为 `LIVE_LOGIN_NOT_VERIFIED`（尚未进行也不伪造真实服务商反作弊与免登录验证，遇到登录阻断时采用系统浏览器降级）；
   - **交互范式**: 当前正式能力为严格的人工确认式方案导入与反馈交接（Human-in-the-loop）；任何自动化双向通信通道属于后续规划（需依托官方 OAuth 与 Responses API）。

---

## 三、 关键决策与架构优先级（Decision Precedence）

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
2. **第二优先级：项目级通用规范（`docs/standards/AGENT_REPORTING_STANDARD.md`，PR #4 已合并入主线）**
   - 任务交付面向用户的回复强制使用 7 字段固定格式（最多 8 行、300 汉字）；详细证据必须完整落盘于项目文档中，严禁假装通过。
3. **第三优先级：当前基线与代码地图（`CURRENT_BASELINE.md` / `docs/engineering/CODE_MAP.md`，PR #5 已合并入主线）**
   - 必须 100% 映射 `origin/rebuild` 上真实存在的模块、函数签名与测试套件。
4. **历史演进参考：早期报告与草稿（`docs/plans/`、`docs/reports/`）**
   - 仅作为历史演进背景记录，凡与上述 ADR 冲突的早期描述一律失效。

---

## 四、 本地代码索引与辅助机制有效性声明 (Code Review Graph)

- **CRG 索引状态**：`STALE_PENDING_SYNC` (主干推进至 `9aecd45`，CRG 索引待例行增量更新)
- **失效降级策略**：开发代理立即降级为 Git / Ripgrep 原生源码检索，严禁阻塞开发，不引入任何常驻索引守护进程。

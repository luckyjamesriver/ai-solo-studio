# 阶段 9 交付报告：WebCodex 官方网页对讲、SOP 蓝图与 DeepSeek 施工验收全流程闭环

> **历史记录说明（2026-11-24 更正）：** 本报告记录阶段 9 当时的实现状态，**不代表当前架构**。阶段 9 曾以内嵌 `<webview>` 提取为方案（提交 `83efa4f`：`src/main/index.ts` 为 `webviewTag: true`，`ChatGPTView.tsx` 内为真实 `<webview id="chatgpt-webview" src="https://chatgpt.com">`）；P0-2 起主窗口已改为 `webviewTag: false`（`src/main/index.ts:247`），ChatGPT 运行于独立伴侣 `BrowserWindow`（`src/main/chatgpt-companion.ts:73-86`），独立窗口 DOM 不可跨窗口读取，真实交付路径为人工复制/粘贴 + 诚实降级。当前事实以 `docs/CURRENT_BASELINE.md` 与源码为准。

## 1. 概述与目标

在遵循 《UI v2.1 规范稿》（低噪音、Noto 字体家族、tokens.css 设计令牌、禁止老仓库彩色药丸及高饱和浅蓝底）的原则下，将此前开发的高价值能力无缝合入正统重构仓库（`ai-solo-studio-rebuild`），并实现全流程闭环：
1. **WebCodex 官方网页对讲视界 (`ChatGPTView.tsx`)**：100% 官方网页内嵌，直通个人订阅，解决 API 费用痛点，并提供「📥 提炼方案并转为任务」一键回填看板。
2. **SOP 蓝图库 (`sopTemplates.ts`)**：提供 3 大标准工程模板（极简桌面离线工具、SaaS 落地页、本地自动化脚本），在任务输入框下拉一键注入。
3. **经验反思知识库 (RSI, `learning-engine.ts`)**：沉淀历史踩坑教训与最佳实践，基于 `.studio/learnings.json` 自动在后续施工中召回。
4. **防死循环熔断保护 (`loop-guard.ts`)**：当同一任务发生连续 3 次相同修复失败或代码无变更时，主动熔断介入，防止无休止消耗 Token。
5. **DeepSeek 全流程自动化闭环**：通过配置 DeepSeek API 为后台执行者，使用 Tool Calling 完成文件物理写入、四步客观试检查通过、用户验收确认并真实落盘保存。

---

## 2. 变更清单与架构落点

| 模块 | 文件路径 | 说明 |
| :--- | :--- | :--- |
| **Electron 主进程** | `src/main/index.ts` | 阶段 9 当时启用 `webviewTag: true`（提交 `83efa4f`）；P0-2 已废除，当前主窗口为 `webviewTag: false`（`src/main/index.ts:247`） |
| **SOP 蓝图库** | `src/core/thinking/sopTemplates.ts` | 3 套经过类型检查验证的 SOP 蓝图模板与占位符替换机制 |
| **经验反思引擎** | `src/core/app/learning-engine.ts` | 基于 APFS 本地持久化的工程教训召回与记录服务 (RSI) |
| **死循环熔断保护** | `src/core/app/loop-guard.ts` | 施工重试熔断器与死循环守卫 |
| **Web 提取桥接** | `src/renderer/webBridge.ts` | 尝试对 `#chatgpt-webview` 调用 `executeJavaScript` 提取文本与 Markdown 代码块；当前主窗口 `webviewTag: false`（`src/main/index.ts:247`）且该节点为普通 `<div>`（`src/renderer/ChatGPTView.tsx:453-456`），无法读取独立伴侣窗口 DOM，恒返回诚实降级错误（`webBridge.ts:81-87`），实际走人工复制/粘贴 |
| **ChatGPT 视界** | `src/renderer/ChatGPTView.tsx` | 遵循 UI v2.1 规范的官方网页视界，支持一键提炼方案 |
| **主导航侧栏** | `src/renderer/Sidebar.tsx` | 增加「ChatGPT 网页」常驻导航项 |
| **看板界面** | `src/renderer/ProjectBoard.tsx` | 在任务输入区新增 SOP 蓝图快捷下拉选择器 |
| **应用外壳路由** | `src/renderer/App.tsx` | 增加 `chatgpt_web` 视图流转与方案导入自动建任务机制 |
| **E2E 验证套件** | `e2e/shell.e2e.ts` | 阶段 9 完整的端到端自动化测试与截图取证流程 |

---

## 3. 测试与截图取证

端到端测试套件全绿通过：
- **测试命令**：`E2E_STAGE9_SHOT_DIR=docs/screenshots/stage9-webcodex npx vitest run -c vitest.e2e.config.ts -t "阶段 9"`
- **测试结果**：`1 passed | 54 skipped (55)`，耗时 13.88s。

### 证据截图清单（位于 `docs/screenshots/stage9-webcodex/`）

1. **`01-sop-blueprint-selected.png`**：在项目看板任务输入框旁选择「极简桌面离线工具 SOP」，输入框自动填充结构化需求模板。
2. **`02-chatgpt-official-webview.png`**：点击侧栏「ChatGPT 网页」，加载官方 ChatGPT 视界，顶部包含「ChatGPT 官方对讲视界」及「📥 提炼方案并转为任务」按钮。
3. **`03-deepseek-plan-ready.png`**：方案提炼后自动创建任务并进入开工计划，执行者成功配置并绑定为 `DeepSeek · deepseek-chat（API）`。
4. **`04-deepseek-execution-acceptance.png`**：DeepSeek 通过 `write_file` 工具调用完成施工，四步试检查通过，展示客观验收卡。
5. **`05-save-result-complete.png`**：用户确认改动后保存成功，落盘物理文件 `calculator.mjs`。

---

## 4. CI 与远端验证

- 提交分支：`rebuild`
- 测试状态：本地全量单测与构建通过 (`npm run build`)，阶段 9 E2E 验证全绿。

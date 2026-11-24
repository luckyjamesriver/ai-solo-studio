# P0-2 终验与基线同步详细证据报告 (FINAL-BASELINE-SYNC)

**任务编号：** `AISS-P0-2-FINAL-BASELINE-SYNC-001`  
**执行日期：** 2026-11-24  
**目标分支：** `rebuild` (`origin/rebuild`)  
**产品代码基线：** `9aecd45d94f0574930f833d83633cf9ac76ae744` (PR #3 Merged)  
**最终收尾状态：** `AISS_P0_2_FINAL_BASELINE_SYNC_COMPLETE`

---

## 一、 执行背景与已确认问题核实

在 PR #3 顺利合并后，针对收尾状态核查发现以下关键问题：
1. **CI 状态真实核实**：文档提交 `9ce89e2` 对应的 CI Run `45248201955` 中，`test (ubuntu-latest)` 耗时 1m23s 成功通过；但 `test (macos-latest)` 在公共 Runner 队列中排队等待约 15 分钟后被取消（`conclusion: cancelled`，完成时间 `2026-11-23T19:37:08Z`）。本项目严格遵守工程诚信准则，**如实记录该取消事实，绝不删除或伪装为成功**。
2. **基线文档混淆动态 HEAD**：`CURRENT_BASELINE.md` 原文本将动态主干 HEAD 与静态产品交付物 SHA 混同，导致每当提交基线文档自身时，HEAD SHA 必然改变，形成自引用循环。
3. **代码地图滞后**：`docs/engineering/CODE_MAP.md` 仍停留在 PR #2 基线（v1.4），缺少 PR #3 引入的伴侣视界、方案导入门禁、反馈审查与相关测试防线。
4. **CRG 索引滞后**：由于主干合并推进，本地 CRG 图数据库标记为 `STALE_PENDING_SYNC`，需要例行增量更新与可检索性实测。

---

## 二、 关键工程改动与解耦设计

### 1. 基线文档解耦设计 (`docs/CURRENT_BASELINE.md`)
- **产品代码交付基线**：锁定为 PR #3 合入提交 `9aecd45d94f0574930f833d83633cf9ac76ae744`。此提交包含全部经过双平台 CI 与真实 Electron E2E 验证的产品源码、架构与测试。
- **动态 Git 主干 HEAD**：定义为随纯文档演进、工程治理与测试维护正常前移的 `origin/rebuild`。动态 HEAD 前移不改变既定产品交付物与代码基线 SHA，彻底消除了文档更新的无限自引用循环。

### 2. 代码地图全量增量映射 (`docs/engineering/CODE_MAP.md`)
更新版本至 `v1.5 (P0-2 Baseline Closeout)`，完整补全 PR #3 新增的核心组件与链路：
- **主进程**：`src/main/chatgpt-companion.ts`（`ChatGPTCompanionManager`，独立 BrowserWindow、专属持久分区 `persist:ai_solo_chatgpt`、强沙箱、双重权限全拒绝、弹窗/302 重定向/跨域 iframe 全拦截、页面加载失败感知与系统浏览器安全降级）。
- **预加载层**：`src/preload/index.cts` 暴露 `openChatGPTCompanion`, `closeChatGPTCompanion`, `getChatGPTCompanionStatus`, `openChatGPTInSystemBrowser` 等白名单 API。
- **渲染层与辅助模块**：
  - `src/renderer/ChatGPTView.tsx`（伴侣视界控制、加载错误提示、显式项目选择器、方案审查与防重锁）。
  - `src/renderer/planParser.ts`（结构化方案解析、全要素无静默丢失、用户批准优先级高于原始参考、空目标拦截）。
  - `src/renderer/chatgptFeedback.ts`（生成结构化反馈审查包、凭证与绝对路径脱敏、选项变动重置核验状态、强制人工确认门禁）。
  - `src/renderer/webBridge.ts`（提取辅助：主窗口 `webviewTag: false` 且 `#chatgpt-webview` 为普通 `<div>`，无法跨窗口读取独立伴侣窗口 DOM，恒返回诚实降级错误并引导人工粘贴，绝不偷窃剪贴板；证据 `src/main/index.ts:247`、`src/renderer/ChatGPTView.tsx:453-456`、`src/renderer/webBridge.ts:81-87`）。
  - `src/renderer/TaskPage.tsx`（反馈包模态框入口接入）。
- **时序流**：新增《5. ChatGPT 网页交互、方案受控导入与反馈审查时序流 (P0-2 Flow)》。
- **测试映射**：登记 `tests/chatgpt-secure-interaction.test.ts` 与 `e2e/shell.e2e.ts` 的真实断言边界。

### 3. CRG 代码知识图谱全量构建与检索验证
使用 `code-review-graph` MCP 工具对代码库执行构建与深度验证：
- **构建结果**：
  - 解析文件数：218
  - 节点总数：3060
  - 边总数：48324（含 CALLS: 28302, TESTED_BY: 13712, CONTAINS: 2835, REFERENCES: 2223）
  - `built_at_sha`: `9ce89e2b54a43054130487c12587abe3a040807a`（仓库文档记录值，本次未复验）
  - `head_matches_build`: `true`（记录时点成立：构建时 HEAD 即 `9ce89e2`。此后 `1b8e9c9`/`e69ca85` 仅修改 `docs/`，当前 HEAD 为 `e69ca8511a17acfc4427954af13ef6d364ffb553`，故当前 `exact_head_match: false`，索引注册状态为 `STALE_PENDING_SYNC`；最新三字段注册见 `docs/CURRENT_BASELINE.md` §四）
- **可检索性验证 (Query Evidence)**（均为仓库文档记录值，本次未复验）：
  - `query_graph_tool` (`file_summary` 目标 `src/main/chatgpt-companion.ts`)：秒级精准提取 14 个节点（类 `ChatGPTCompanionManager`、函数 `openCompanion`、`setupWebContentsSecurity`、`isAllowedChatGPTUrl` 等完整行号）。
  - `query_graph_tool` (`tests_for` 目标 `ChatGPTCompanionManager`)：秒级精准命中 4 项关联测试用例（真实 WebContents 拦截测试、LIVE_LOGIN_NOT_VERIFIED 标记测试、白名单限制测试、非法协议拦截测试）。
- **时效性说明（2026-11-24）：** 上述 218 文件 / 3060 节点 / 48324 边与检索命中均为**仓库文档记录值**；当前工作区未检出 `.code-review-graph/` 索引库，本次未重建或读取实时索引，实时索引验证标记为 `OPEN / 未核实`。

---

## 三、 主工作区 8 个保护文件零修改核验

在本次任务全程中，原主工作区（`/Users/jamesho/ai-solo-studio-rebuild`）的 8 个在研文件受到 100% 隔离保护，未做任何暂存、重置或覆盖：

| 文件路径 | 基准 SHA-256 | 收尾核验 SHA-256 | 状态对比 |
|---|---|---|---|
| `e2e/shell.e2e.ts` | `1059d524c53412f1b3ad5f7bde13c4b70e31ee7b026d684bb10426d3ad5aa93a` | `1059d524c53412f1b3ad5f7bde13c4b70e31ee7b026d684bb10426d3ad5aa93a` | 严格一致 (未修改) |
| `src/core/app/task-controller.ts` | `40873cc12089ef94db563824b60135a56425c91ea6a4b42bc7e43ff990118881` | `40873cc12089ef94db563824b60135a56425c91ea6a4b42bc7e43ff990118881` | 严格一致 (未修改) |
| `src/core/thinking/index.ts` | `cd4b5dd264b069bf558571916367e068f036496dc86da3c35466be5e43e9ecb5` | `cd4b5dd264b069bf558571916367e068f036496dc86da3c35466be5e43e9ecb5` | 严格一致 (未修改) |
| `src/renderer/App.tsx` | `0127d93ce23138b099b3d66771d85666c257548e9186155799649385f33b9c30` | `0127d93ce23138b099b3d66771d85666c257548e9186155799649385f33b9c30` | 严格一致 (未修改) |
| `src/renderer/SettingsPage.tsx` | `c0ee540629549ef39fc87f6b07778aa4350955746f86e13b13d5e55821a70765` | `c0ee540629549ef39fc87f6b07778aa4350955746f86e13b13d5e55821a70765` | 严格一致 (未修改) |
| `src/core/app/autonomous-feedback-loop.ts` | `d5067b3fe176984f0115751f9fa5690d02b4dc121119bfb82981b83439424428` | `d5067b3fe176984f0115751f9fa5690d02b4dc121119bfb82981b83439424428` | 严格一致 (未修改) |
| `src/core/thinking/chatgpt-devkit.ts` | `49f3cfce392320c4b399e05bddec19695f7d4bc78fa17acdc6f2471efdf49f35` | `49f3cfce392320c4b399e05bddec19695f7d4bc78fa17acdc6f2471efdf49f35` | 严格一致 (未修改) |
| `tests/autonomous-feedback-loop.test.ts` | `caad1b563d77eac30fa4af96165bfc767c837fc2954d622b0cef0f75dc94eae3` | `caad1b563d77eac30fa4af96165bfc767c837fc2954d622b0cef0f75dc94eae3` | 严格一致 (未修改) |

# AI Solo Studio — 代理交付回复规范 (AGENT_REPORTING_STANDARD)

**版本：** v1.0  
**状态：** 强制执行 (MANDATORY)  
**适用范围：** Antigravity、Claude Code、Codex、ChatGPT 以及所有参与本项目的 AI 执行代理  
**唯一权威路径：** `docs/standards/AGENT_REPORTING_STANDARD.md`

---

## 一、 规范宗旨与核心原则

为避免各 AI 代理在交付时产生冗长的流水账、重复的任务背景介绍和无意义的日志堆叠，维护者明确设立本标准：

1. **终端回复高度凝练：** 面向用户的最终交互回复必须极简、结构统一，原则上最多 8 行、300 个汉字（不计标识符、SHA、URL 与文件路径）。
2. **证据留存绝对完整：** 详细技术证据、全量测试日志、CI Run 链接、风险分析、改动文件清单和复核指引必须完整保存在项目证据文档（如 `docs/reports/` 或 `docs/checklists/`）中，**严禁因终端精简而丢失任何事实依据**。
3. **真实诚实，严禁假装：** 未验证事项明确写 `NOT_VERIFIED`，不得写 PASS；PR 待复核不得写 `COMPLETE`；CI 通过不代表真实服务已验证。

---

## 二、 强制固定输出格式（7 个字段）

所有任务完成、阶段验收、独立复核交接以及受阻回执，在最终交付时**统一且必须**采用以下 7 个字段，顺序不可颠倒、字段不可缺失：

```markdown
**任务：** `TASK_ID` ｜ **状态：** `STATUS`
**结果：** 一句话说明真正完成了什么。
**交付：** PR 编号、最终 HEAD、主要成果路径。
**验证：** 单测 / E2E / CI / 真实服务验证的实际结果。
**风险：** 无，或最多两项尚未解决的问题。
**下一步：** 唯一明确的下一动作，注明是否需要维护者介入。
**详细证据：** 项目内报告的相对路径。
```

---

## 三、 状态与字段填写规范

### 1. 状态枚举 (`STATUS`)
严格只能使用以下四种状态：
- **`COMPLETE`**：任务已全部完成，代码已合入主线分支（或已完成经独立复核的双向验证闭环），无遗留阻塞问题。
- **`READY_FOR_REVIEW`**：本阶段开发/设计已就绪，已提交独立 PR 或已生成候选成果，等待维护者或外部评审介入审查（**PR 尚待合并时不得标注为 COMPLETE**）。
- **`PARTIAL`**：完成了部分预期子目标，部分用例通过但仍有明确遗留待办，不满足提审或完成条件。
- **`BLOCKED`**：遇到严重阻断（如缺少关键凭证、依赖破坏、条款合规冲突或环境异常），无法继续推进，需要维护者介入或外部解除阻塞。

### 2. 字段填写要点
- **`结果：`** 仅用一句话概括真正做成了什么，区分设计文档就绪、Mock 验证与真实功能落地。
- **`交付：`** 精确标明 PR 编号（若有）、提交 SHA（短哈希或完整哈希）、核心产物相对路径。
- **`验证：`** 真实报告各层验证结果（如：`unit: 44 pass / e2e: 1 pass / CI: NOT_VERIFIED`）。未验证项写 `NOT_VERIFIED`。
- **`风险：`** 写“无”，或列出最多两项关键风险/技术债，不写无关痛痒的套话。
- **`下一步：`** 唯一指明下一动作，并明确是否需要维护者操作。
- **`详细证据：`** 指向项目内落盘的 Markdown 报告或 Checklists 路径（如 `docs/reports/xxxx.md`）。

---

## 四、 执行守则（禁止与例外事项）

1. **禁止复述流水账：** 严禁在回复中贴上几十行执行过程、逐步命令、开发计划与背景重申。
2. **禁止假状态：** 未经真机实测的严禁宣称“已验证”；未合并的 PR 严禁写 `COMPLETE`。
3. **禁止无信息量心跳消息：** 禁止输出“正在监控”“正在等待测试”“稍后汇报”等废话。
4. **自主解决常规阻断：** 遇到普通工程报错（编译错误、轻微测试失败、格式问题）由代理自主解决并重试，不打扰用户。
5. **例外情况（突破字数限制）：** 遇到安全事故、凭证泄露风险、不可逆数据破坏危险时，允许突破字数限制，但必须在第一行显式给出醒目告警与应急处置指引。
6. **用户显式要求详版：** 当用户明确要求“查看详细技术报告”时，代理可在终端完整展示全部证据内容。

---

## 五、 四类标准回复示例 (Templates)

### 示例 1：READY_FOR_REVIEW（功能/文档提审）
```markdown
**任务：** `AISS-NOVICE-WEBSITE-MODE-DESIGN-R1` ｜ **状态：** `READY_FOR_REVIEW`
**结果：** 完成新手建站模式 PRD 及架构映射 v0.2 修订，修正持久化边界与去伪存真。
**交付：** PR #3、HEAD `9d5dc23`、`docs/requirements/PRD_NOVICE_WEBSITE_MODE_v0.2.md`。
**验证：** 需求 0–15 章对齐核验 pass / 路径真实性核验 pass / 原工作区隔离 pass。
**风险：** macOS 首发与 MVP 范围收敛等 5 项方案仍标记为待维护者裁决。
**下一步：** 等待维护者审阅 v0.2 文档并裁定 5 项决策（需维护者介入）。
**详细证据：** `docs/requirements/REVISION_CHANGELOG_R1_v0.2.md`
```

### 示例 2：COMPLETE（主线合入与落地）
```markdown
**任务：** `AISS-STORAGE-P0-INTEGRITY-001` ｜ **状态：** `COMPLETE`
**结果：** 修复 ADR 0005 存储语义，消除 URL 绕过漏洞，建立单源 SOP 蓝图。
**交付：** PR #2 (Merged)、HEAD `443773c`、`src/core/persistence/`。
**验证：** unit: 52 pass / e2e: 4 pass / CI: Run #128 pass / 本机验证通过。
**风险：** 无。
**下一步：** 启动 P0-2 ChatGPT Webview 独立闭环测试（无须维护者介入）。
**详细证据：** `docs/reports/2026-11-p0-integrity-report.md`
```

### 示例 3：PARTIAL（部分完成与存在遗留）
```markdown
**任务：** `AISS-ENV-CHECK-ADAPTER-002` ｜ **状态：** `PARTIAL`
**结果：** 完成便携 Node.js LTS 探测与环境体检模块，免安装 Git 下载逻辑尚未就绪。
**交付：** HEAD `e7a1b2c`、`src/core/env/runtime.ts`。
**验证：** unit: 12 pass, 2 skipped / E2E: NOT_VERIFIED / CI: NOT_VERIFIED。
**风险：** 弱网环境下离线包解压超时处理尚未覆盖。
**下一步：** 补齐 Git 便携二进制校验并补全 2 项跳过的单元测试（无须维护者介入）。
**详细证据：** `docs/reports/2026-11-env-check-partial.md`
```

### 示例 4：BLOCKED（关键阻断需人工介入）
```markdown
**任务：** `AISS-DEPLOY-CLOUDFLARE-003` ｜ **状态：** `BLOCKED`
**结果：** 静态资源一键打包管道完成，边缘部署 API 调用受阻于缺少生产 Token。
**交付：** HEAD `f3c8d1a`、`src/core/deploy/cloudflare.ts`。
**验证：** unit: 8 pass / 真实部署: BLOCKED (401 Unauthorized)。
**风险：** 缺乏合法托管凭证导致公网发布闭环无法验证。
**下一步：** 需维护者提供受控的 Cloudflare API Token 环境变量（需维护者介入）。
**详细证据：** `docs/reports/2026-11-deploy-blocked-evidence.md`
```

# OpenAI 官方技术栈系统性可行性分析报告 (2026)

**TASK_ID：AISS-P1-OPENAI-OFFICIAL-001**  
**修订批次：** P0-2 / P1 阶段综合修订  
**编制时间：** 2026-11-23  
**适用范围：** AI Solo Studio 协同开发体系  

---

## 一、调研背景与核心目标

维护者明确要求在 AI Solo Studio 中系统性吸纳与采用 OpenAI 官方正式技术栈，包括：
1. OpenAI 官方 API 与全新 Responses API。
2. Codex CLI / Codex app-server 官方协议。
3. Sign in with ChatGPT 官方 OAuth 授权与 DevKit。
4. 官方 SDK 与工具调用（Tool Calling / Computer Use）范式。

本报告对以上四大方向进行技术可行性、授权机制、额度消费模型、工程约束与实施路径的深度论证。

---

## 二、关键技术点可行性论证

### 1. Responses API (`/v1/responses`)

- **技术定位**：OpenAI 针对新一代模型推出的综合交互接口，融合了文本生成、结构化思考链（Reasoning Items）、客户端工具调用及服务端内置工具。
- **与传统 Chat Completions 区别**：
  - 原生支持显式推理步（Reasoning tokens / Thinking trace），便于提取中间审查逻辑。
  - 支持多模态输入与流式事件协议，原生兼容状态机流转。
- **可行性评估**：**高（推荐作为后续自动化双向交互核心实现）**。可直接替代手写的模拟思考协议，降低协议解析脆弱度。
- **额度与计费**：消耗标准 OpenAI API 计费额度（按输入/输出/推理 Token 计费），与 ChatGPT Plus/Pro 订阅额度相互独立。

### 2. Codex app-server 协议集成

- **技术定位**：Codex 官方客户端与本地/服务端代理进程通信的标准 RPC 协议（基于 JSON-RPC 2.0 / stdio / IPC）。
- **可行性评估**：**高**。
  - 本 App 当前 `CodexExecutor` 采用命令行参数驱动，对于复杂的代码审查和长会话，容易遇到进程重启开销。
  - 接入 app-server 协议可维持长连接上下文，支持增量文件补丁推送、受控工具审批（Approval Policy）与实时日志流监听。
- **实施要点**：定义严格的 IPC 超时、心跳对账与异常退出自动重连机制。

### 3. Sign in with ChatGPT (SIWC) 与合资格计划授权路径

- **技术定位**：OpenAI 官方推出的统一身份认证与第三方应用授权系统（Sign in with ChatGPT / SIWC），面向开发者与第三方工作台。
- **合资格 ChatGPT 计划范围**：
  - **ChatGPT Plus / Pro**：个人高阶订阅，通过 SIWC 可完成个人身份认证并关联用户账号。
  - **ChatGPT Team / Enterprise / Edu**：企业与教育组织计划，具备统一 Workspace 成员管理、SSO（单点登录）与数据隐私隔离保证（不使用客户数据训练模型）。
- **与个人订阅额度的关键边界澄清**：
  - **重要事实**：Sign in with ChatGPT 本质上是 **OAuth 2.0 / OIDC 身份认证与权限委托**，主要用于获取用户个人或企业组织标识（User ID / Email / Workspace ID）以及特定合资格应用的授权作用域（Scopes）。
  - **额度真相**：官方 OAuth **并不等同于**可以任意调用后端 `/v1/responses` 或普通商用 API 来消耗用户的 ChatGPT Plus/Pro 网页订阅额度。OpenAI 商业条款明确区分了消费者订阅服务（ChatGPT Consumer/Team）与开发者 API 平台（Platform API）。
  - **网页登录限制与 `LIVE_LOGIN_NOT_VERIFIED` 状态**：
    - 在 Electron 桌面客户端内嵌打开官方网页时，OpenAI 部署了严格的 Cloudflare / Bot 探测策略与 Google OAuth 嵌入式浏览器拦截机制（Disallowed User-Agent）。
    - 严禁通过伪装 User-Agent、篡改 Client Hints 或非授权读取系统 Cookie 来规避检测，此举不仅脆弱，还会违反服务商安全协议。
    - 因此，在 P0-2 阶段，App 诚实标注登录状态为 `LIVE_LOGIN_NOT_VERIFIED`，并提供「系统默认浏览器」作为 100% 受官方支持的原生备用通道。

---

## 三、P0-2 与后续全自动阶段的协同边界界定

| 协同维度 | P0-2 当前实现（安全基线与人工确认交接） | P1 / P3 及后续规划（程序化全自动协作） |
| :--- | :--- | :--- |
| **网页交互** | 独立伴侣视界 (`BrowserWindow`) + 系统浏览器备用 | 官方 SIWC 认证 + Webhook / MCP 扩展通道 |
| **方案导入** | 结构化方案解析（`parsePlanFromText`）+ 用户预览确认卡片 | 通过 Responses API 结构化提取方案工单 |
| **执行结果反馈** | 标准结构化反馈包（`buildChatGPTFeedbackPacket`）+ 人工复制交接 | 通过官方 API 或 app-server 反向推送任务证据与测试结果 |
| **双向通信性质** | **明确标注：人工确认交接（Human-in-the-loop）** | **程序化全自动双向通信** |
| **安全与隔离** | 主窗口维持 `webviewTag: false`，伴侣窗口独立分区沙箱 | 端到端凭证托管与受控 Token 刷新 |

---

## 四、结论与分步推进建议

1. **第一步（P0-2，本次已完成）**：
   - 彻底废除 User-Agent 伪装，关闭内联 `<webview>`，主应用维持 `webviewTag: false`。
   - 实现独立沙箱伴侣窗口（`chatgpt-companion.ts`）与系统浏览器降级方案，标记 `LIVE_LOGIN_NOT_VERIFIED`。
   - 建立结构化方案解析、预览确认卡片与六大核心模块执行结果反馈包。
2. **第二步（P1）**：
   - 申请并配置正式的 OpenAI 开发者应用与 SIWC 授权凭据。
   - 验证合资格账号（Team/Enterprise）的 OAuth Token 范围。
3. **第三步（P3/P4）**：
   - 在执行体层引入官方 SDK，通过 Responses API 实现结构化思考与审查。
   - 实现 Codex app-server 协议的长连接适配器。

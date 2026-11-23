# OpenAI 官方技术栈系统性可行性分析报告 (2026)

**TASK_ID：AISS-P1-OPENAI-OFFICIAL-001**  
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
- **可行性评估**：**高（推荐作为 P4 核心实现）**。可直接替代手写的模拟思考协议，降低协议解析脆弱度。
- **额度与计费**：消耗标准 OpenAI API 计费额度（按输入/输出/推理 Token 计费），与 ChatGPT Plus/Pro 订阅额度相互独立。

### 2. Codex app-server 协议集成

- **技术定位**：Codex 官方客户端与本地/服务端代理进程通信的标准 RPC 协议（基于 JSON-RPC 2.0 / stdio / IPC）。
- **可行性评估**：**高**。
  - 本 App 当前 `CodexExecutor` 采用命令行参数驱动，对于复杂的代码审查和长会话，容易遇到进程重启开销。
  - 接入 app-server 协议可维持长连接上下文，支持增量文件补丁推送、受控工具审批（Approval Policy）与实时日志流监听。
- **实施要点**：定义严格的 IPC 超时、心跳对账与异常退出自动重连机制。

### 3. Sign in with ChatGPT 与 DevKit

- **技术定位**：OpenAI 官方推出的统一身份认证系统，允许第三方应用接入 ChatGPT 用户身份。
- **与个人订阅额度的关键边界澄清**：
  - **重要事实**：Sign in with ChatGPT 本质上是 **OAuth 2.0 / OIDC 身份认证**，用于获取用户个人标识（User ID / Email）与授权令牌。
  - **额度真相**：官方 OAuth **并不等同于**可以任意调用后端 `/v1/responses` 或普通商用 API 来消耗用户的 ChatGPT Plus/Pro 网页订阅额度。OpenAI 商业条款明确区分了消费者订阅服务与开发者 API 平台。
  - **合规建议**：
    1. 网页视界（Companion Window）通过官方登录态承载，直通个人订阅的网页对话。
    2. 后台自动化高频施工与自动化测试，采用正规 API Key（支持官方平台或第三方兼容端点如 DeepSeek），避免依赖非官方反向工程 API。

---

## 三、推荐技术演进架构 (P4/P5)

```
┌────────────────────────────────────────────────────────┐
│             AI Solo Studio 控制中心                    │
├──────────────────────────┬─────────────────────────────┤
│   ChatGPT 官方视界       │       自动化执行体集群      │
│ (独立窗口 · 个人订阅)   │ (Responses API / DeepSeek)  │
├──────────────────────────┴─────────────────────────────┤
│         统一协同中间层 (Unified Collab Protocol)        │
│       - 任务工单 (Task Manifest)                       │
│       - 验收事实 (Evidence & Facts)                    │
│       - 状态机与持久化 (ADR 0005 CAS Store)            │
└────────────────────────────────────────────────────────┘
```

---

## 四、结论与分步推进建议

1. **第一步（P0-2）**：将 ChatGPT 网页独立为安全伴随窗口，使用标准 OAuth 登录，解决隔离性问题。
2. **第二步（P4）**：在执行体层引入官方 SDK，增加对 Responses API 的配置选项，支持主流推理模型。
3. **第三步（P5）**：实现 app-server 协议适配器，提供比单次 CLI 启动更轻量、更高密度的本地长任务调度。

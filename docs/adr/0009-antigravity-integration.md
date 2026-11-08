# ADR 0009：Antigravity 接入决策（第一版不接入）

- 状态：已决定（2026-11-08）
- 相关：ADR 0001（执行体与条款调查）、ADR 0002（不提供订阅类集成）、docs/PROJECT_CONTEXT.md

## 1. 背景
Antigravity 的命令行 `agy` 技术上可以无头运行，但能否由第三方程序调用，条款与社区答复并不一致，违规后果严重（账户被暂停，社区报告可能波及整个 Google 账户）。本文把此前分散在 ADR 0001、ADR 0002 里的结论单独成文，并写明将来接入的前提。

## 2. 决定
1. **第一版不接入 Antigravity。** 用户仍可用外部执行交接（ADR 0002）：导出任务文件，在官方 Antigravity 中自行运行，再导入报告；本应用不接管其身份，也不接触其登录状态。
2. **将来接入 Gemini 模型时，优先走 Gemini API key**（用户自己的密钥，按量计费，属于标准、合规的接入方式）。
3. **消费级登录调用 `agy` 只能作为用户主动开启的高级选项**：默认关闭；开启前必须披露 Google 条款中的**封号风险**（账户可能被暂停，并可能波及整个 Google 账户），由用户明确确认后才可启用；不得提取、复制或转发其登录令牌。
4. 上述第 3 点是**将来**的方向，不改变第一版的范围。它与 ADR 0002 里“已规划的高级选项整体删除”存在张力：真正开始做之前，必须另写一份 ADR 重新审议与 0002 的关系（0002 的原则是“用户勾选不能替代服务方的合规授权”），并更新需求文档。

## 3. 依据
查阅日期：2026-11-08。**说明：下列链接与摘要沿用 ADR 0001（2026-11-07）的调查记录，本次没有重新抓取原页面，页面内容可能已变化；接入前须重新核实。**
- Antigravity 服务条款第 6 节：[https://antigravity.google/terms/](https://antigravity.google/terms/)。调查记录中的要点：§6 禁止“使用第三方软件、工具或服务访问本服务”；违者可被暂停账户。
- 官方 FAQ：[https://antigravity.google/docs/faq](https://antigravity.google/docs/faq)（以 OpenClaw 等为例）；Headless 文档：[https://antigravity.google/docs/cli/headless/](https://antigravity.google/docs/cli/headless/)。
- 官方论坛答复（Google AI 开发者论坛）：
  - [Is orchestrating the official Antigravity CLI from a local multi-agent coding application allowed?](https://discuss.ai.google.dev/t/is-orchestrating-the-official-antigravity-cli-from-a-local-multi-agent-coding-application-allowed/181088)
  - [Headless agy runs launched by a script from another AI coding tool within the additional terms?](https://discuss.ai.google.dev/t/headless-agy-runs-launched-by-a-script-from-another-ai-coding-tool-within-the-additional-terms/185494)
  - 答复称：在本机启动未经修改的官方 `agy`、使用其文档化的 headless 模式、不提取或转发登录令牌，属于允许的用法。**答复者是否为 Google 官方人员、是否具有约束力，未核实。**
- 结论依据：条款文字（禁止第三方工具访问）与论坛答复（允许本机启动官方 agy）互相矛盾，且后果严重，因此第一版不接入；将来接入也必须以 API key 为首选，登录方式仅作为带风险披露的可选项。

## 4. 后果
- 第一版没有 Antigravity 集成代码；界面与文档不得暗示支持。
- 用户用 Antigravity 做外部执行时，走交接协议，报告需绑定 Git 状态（docs/PROTOCOL.md）。
- 将来若做 Gemini API key 接入，按 ADR 0008 检查依赖，并按 ADR 0005 的凭证规则保存密钥（密钥放系统受保护存储，不写入项目目录）。

## 5. 待办
1. **核实 Codex 使用“Sign in with ChatGPT”被第三方程序调用的合规性。** 现状：ADR 0001 记录 OpenAI 官方支持开源、本机运行的应用让符合条件的 ChatGPT 计划用户用自己的计划驱动 AI 功能（含 Codex app-server 配置），并有 UI/品牌规范、需单独的计划使用授权、预览期限制等义务；但对本应用这种“第三方程序调用 Codex”的具体情形，是否满足这些条件、是否有额外限制，**尚未逐条核实**。需要在对外测试前完成（路线图 M6 之前），结论写入 ADR 或需求文档；在核实完成前，不把本机现有 Codex 登录作为对外方案（需求 v1.5 已有此限制）。
2. 若决定做 agy 高级选项：先写新 ADR（见第 2 节第 4 点），并重新核实上面三条链接的现行内容。

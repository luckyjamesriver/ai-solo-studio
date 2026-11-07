# 执行体技术验证（ADR 0001）

可重复运行的实验脚本。每次实验都在全新的临时 Git 仓库里（只有 `index.html`）执行固定任务，不使用任何跳过权限/沙箱的参数，不修改全局配置。

```bash
node spikes/claude-code/run.mjs [e1 e2 e3 e4 e5 e7]   # Claude Code
node spikes/codex/run.mjs [e7 exec app]               # Codex（exec = 事件流/中断/退出码，app = app-server 审批）
```

- 会调用真实模型（使用本机已登录的账号），每个脚本大约几分钟。
- 结果汇总：`<name>/samples/results.json`；原始事件流样本（已去除账号、用户名、路径、令牌）：`<name>/samples/*.jsonl`。
- 遇到需要登录或人工确认的情况：停下来，不要绕过。

## 参考的官方文档
- Claude Code：[headless / 非交互运行](https://code.claude.com/docs/en/headless)、[CLI 参考](https://code.claude.com/docs/en/cli-reference)、[权限](https://code.claude.com/docs/en/permissions)、[Agent SDK 权限](https://code.claude.com/docs/en/agent-sdk/permissions)、[Agent SDK 用户输入（canUseTool）](https://code.claude.com/docs/en/agent-sdk/user-input)
- Codex：[非交互模式（exec）](https://learn.chatgpt.com/docs/non-interactive-mode)、[app-server](https://learn.chatgpt.com/docs/app-server)、[审批与安全](https://learn.chatgpt.com/docs/agent-approvals-security)、[命令参考](https://learn.chatgpt.com/docs/developer-commands?surface=cli)（原 developers.openai.com/codex/* 会重定向到这里）

# AI Solo Studio — Claude Code 项目级指令 (CLAUDE.md)

> 本文件是 Claude Code 在当前项目中的指令入口，严格继承项目唯一权威规范。
> 权威规范文档：`docs/standards/AGENT_REPORTING_STANDARD.md`
> 通用代理规则：`AGENTS.md`

---

## 强制交付回复规范

任务收工汇报必须严格采用 7 个字段固定格式（最多 8 行、300 汉字）：

```markdown
**任务：** `TASK_ID` ｜ **状态：** `STATUS`
**结果：** 一句话说明真正完成了什么。
**交付：** PR 编号、最终 HEAD、主要成果路径。
**验证：** 单测 / E2E / CI / 真实服务验证的实际结果。
**风险：** 无，或最多两项尚未解决的问题。
**下一步：** 唯一明确的下一动作，注明是否需要维护者介入。
**详细证据：** 项目内报告的相对路径。
```

- 状态只能为：`COMPLETE`、`READY_FOR_REVIEW`、`PARTIAL`、`BLOCKED`。
- PR 待合并时不得标注为 COMPLETE。
- 完整证据必须写入 `docs/reports/` 或 `~/AI-CoWork-rebuild-import/report.md`。

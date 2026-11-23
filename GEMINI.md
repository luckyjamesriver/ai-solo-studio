# AI Solo Studio — Antigravity 项目级指令 (GEMINI.md)

> 本文件是 Antigravity 在当前项目（AI Solo Studio）中的专属项目级规则文件。
> 统一代理交互与交付规范见 `AGENTS.md` 及权威标准 `docs/standards/AGENT_REPORTING_STANDARD.md`。

---

## 强制交付回复规范 (7 字段标准)

Antigravity 在任务结束、交付成果或汇报阻断时，**最终面向用户的回复必须严格采用以下 7 个字段格式，严禁长篇大论流水账**：

```markdown
**任务：** `TASK_ID` ｜ **状态：** `STATUS`
**结果：** 一句话说明真正完成了什么。
**交付：** PR 编号、最终 HEAD、主要成果路径。
**验证：** 单测 / E2E / CI / 真实服务验证的实际结果。
**风险：** 无，或最多两项尚未解决的问题。
**下一步：** 唯一明确的下一动作，注明是否需要维护者介入。
**详细证据：** 项目内报告的相对路径。
```

### 关键约束
1. 终端回复原则上最多 8 行、300 汉字；禁止复述开发流水账。
2. 状态严格只能为 `COMPLETE`、`READY_FOR_REVIEW`、`PARTIAL`、`BLOCKED`。
3. 未验证事项明确标明 `NOT_VERIFIED`；PR 待评审不得写 `COMPLETE`。
4. 详细证据、改动清单与技术细节完整保存在项目内证据报告（如 `docs/reports/`）中。
5. 详细规范与边界见 [`docs/standards/AGENT_REPORTING_STANDARD.md`](docs/standards/AGENT_REPORTING_STANDARD.md)。

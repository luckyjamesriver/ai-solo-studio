# AI Solo Studio — Claude Code 项目级指令 (CLAUDE.md)

> 本文件是 Claude Code 在当前项目中的指令入口，严格继承项目唯一权威规范。
> 统一交付回复格式与规范已收敛至唯一权威文档，不再于此处维护副本。

---

## 交付规范引用与加载要求

1. **唯一权威规范：** 所有任务交付与状态汇报，必须严格遵守 [`docs/standards/AGENT_REPORTING_STANDARD.md`](docs/standards/AGENT_REPORTING_STANDARD.md) 及 [`AGENTS.md`](AGENTS.md)。
2. **格式执行要求：** 任务完成、提审或受阻时，最终面向用户的回复**必须严格采用固定 7 字段格式**，原则上最多 8 行、300 汉字以内，严禁长篇大论流水账。
3. **状态枚举约束：** 仅允许使用 `COMPLETE`、`READY_FOR_REVIEW`、`PARTIAL`、`BLOCKED` 四种状态；PR 待合并时不得标注为 COMPLETE。
4. **证据落盘机制：** 详细技术证据、测试日志与改动清单必须完整写入当前项目内的相对路径（如 `docs/reports/`），严禁使用外部绝对路径。
5. **例外情况：** 仅当发生安全事故、凭证泄露风险，或用户明确指令要求详细报告时，方可突破字数限制展开汇报。

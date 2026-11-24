# AISS-A1-TRUSTED-EVIDENCE-001 — 仓库内证据包索引

随产品 PR 一起提交，供独立复核直接读取；完整本机副本位于 `/Users/jamesho/a1-evidence/`。

| 文件 | 内容 |
| :-- | :-- |
| `../AISS-A1-TRUSTED-EVIDENCE-001.md` | 主报告（修复、证据模型、全链路、反向矩阵、门禁、OPEN） |
| `gates.md` | 门禁命令、结果、运行身份、CI 链接、A0 分支、复核命令 |
| `probes/a1-fix-proof.test.ts` | 修复前后对照探针源码（同一文件、同一组断言） |
| `probes/pre-fix-baseline-probe.log` | 探针在基线 `e69ca85` 上的运行结果：**5 failed / exit 1** |
| `probes/post-fix-a1-probe.log` | 探针在 A1 修复后的运行结果：**5 passed / exit 0** |
| `full-suite-excerpt.txt` | 本机全量单元+集成 JSON 汇总：749 / 711 passed / 0 failed / 38 skipped |
| `a1-special-tests-excerpt.txt` | A1 专项反向矩阵 34 项（20 + 14）全部通过 |
| `e2e-excerpt.txt` | Electron E2E：56 passed / 0 failed |
| `real-project-verify.log` | 真实项目工作树端到端验证（真实 build + 真实 `npm test` 749 项，`checked=true` 保存） |
| `workspace-protection-before.txt` / `-after.txt` | 原主工作区 8 文件 SHA-256、HEAD、status、diff 哈希（前后一致） |

设计说明：`../../plans/2026-11-24-AISS-A1-trusted-evidence.md`
独立审计材料（A0，远程可读、独立分支、不合入）：`audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001-delivery` @ `a54fefbd152464a93ca3782faa130dd2582cdcf9`

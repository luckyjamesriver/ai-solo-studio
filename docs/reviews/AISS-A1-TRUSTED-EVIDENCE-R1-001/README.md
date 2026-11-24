# R1 证据包索引（AISS-A1-TRUSTED-EVIDENCE-R1-001）

本目录随 PR #7 提交，供独立复核直接从远程读取；不依赖本机路径。

| 文件 | 内容 |
| :-- | :-- |
| `../AISS-A1-TRUSTED-EVIDENCE-R1-001.md` | 逐项修复报告 |
| `gates.md` | 全部最终门禁的命令、结果、运行身份与 CI 链接 |
| `source-identity.md` | 旧/新候选 commit、探针源码 SHA-256、工具链与运行环境 |
| `repro/r1-probe.probe.ts.txt` | 修复前后对照探针源码（同一文件） |
| `repro/real-project-sandbox-verify.mjs` | 标准模式 Seatbelt 沙箱内完整真实项目检查+保存+撤销的可执行脚本 |
| `repro/real-project-verify.mjs` | A1 阶段宿主运行器验证脚本（辅助证据，不作为产品验收依据） |
| `probes/r1-pre-fix-old-candidate.txt` | 同一探针在旧候选 6918ea5 的运行：8 failed / 1 passed，exit 1 |
| `probes/r1-post-fix-new-candidate.txt` | 同一探针在新候选的运行：9 passed，exit 0 |
| `probes/r1-standard-sandbox-full-project.txt` | 标准沙箱完整项目验证原始输出 |
| `probes/full-suite-excerpt.txt` / `special-tests-excerpt.txt` / `e2e-excerpt.txt` | 本机全量 / 专项 / E2E 汇总 |
| `workspace-protection-before.txt` / `-after.txt` | 原主工作区 8 文件与 A0 审计工作树的收工指纹 |

旧候选与修复缺陷的对应关系见报告 §0 与各节；探针在旧候选上的失败正是复核提出的问题，不构成本报告自证通过。

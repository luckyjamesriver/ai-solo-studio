# AISS-A1-TRUSTED-EVIDENCE-R1-001：最终门禁与运行身份

## 1. 运行身份

| 项 | 值 |
| :-- | :-- |
| 旧候选（复核未通过） | `6918ea590f14935c4f164185a5702c51ee9bf8c0` |
| 主干基线 | `e69ca8511a17acfc4427954af13ef6d364ffb553` |
| 新候选 | PR #7 的 exact HEAD（见 PR checks / 报告 §8） |
| Node / npm | `v22.23.5` / `10.9.9`（engines >=22.22.2 <23） |
| Vitest / Electron / Git | `5.0.5` / `45.0.0` / `2.54.0 (Apple Git-157)` |
| OS / 时区 | macOS darwin arm64（真实显示环境）/ Asia/Singapore |
| 探针源码 SHA-256 | `bdcb727570a30a140a091ffe38f6c5069622334504fc50c3897106cb8e7218aa` |

## 2. 门禁结果

| 门禁 | 命令 | 结果 |
| :-- | :-- | :-- |
| TypeScript | `npm run typecheck` | **通过（exit 0，0 错误）** |
| 全量单元+集成 | `npm test` | **772 / 734 passed / 0 failed / 38 skipped（exit 0）** |
| A1+R1 专项反向矩阵 | 同左 | **57 passed / 0 failed** |
| 构建 | `npm run build` | **通过（exit 0）** |
| Electron E2E | `npx vitest run -c vitest.e2e.config.ts` | __E2E__ |
| 标准模式沙箱完整真实项目（build+test+保存+撤销） | `repro/real-project-sandbox-verify.mjs` | **通过**：`runEnv=sandbox`、`sandboxKind=seatbelt`，build `verified`、test `verified`，结构化报告 25/25、执行 5/5 文件、完整性/交叉核对全 true、范围 `assessed_unchanged`；保存 `checked=true`（`evidenceIds` 记录）、任务内容完整应用；撤销后 `HEAD^{tree}` 与保存前严格相等 |
| 真实 Git 保存与撤销 | `tests/r1-git-integrity.test.ts` + 上述沙箱脚本 | **通过**（已跟踪 `node_modules/fixture.js` 删除可见、保存生效、撤销精确恢复） |
| 修复前后对照探针（同一文件） | 旧候选 / 新候选 | **旧候选 8 failed / 1 passed，exit 1**；**新候选 9 passed，exit 0** |
| 原工作区 8 文件 / A0 工作树保护 | SHA-256 / HEAD / status / diff 哈希 | __PROTECT__ |
| 远程证据完整性 | 推送后 `gh api …/contents/...` 读回 + SHA-256 比对 | __REMOTE__ |
| 新 PR exact-HEAD 双平台 CI | GitHub Actions | __CI__ |

## 3. 证据文件

| 文件 | 内容 |
| :-- | :-- |
| `probes/r1-pre-fix-old-candidate.txt` | 旧候选探针原始输出（8 failed / 1 passed，exit 1） |
| `probes/r1-post-fix-new-candidate.txt` | 新候选同一探针原始输出（9 passed，exit 0） |
| `probes/r1-standard-sandbox-full-project.txt` | 标准 Seatbelt 沙箱完整项目验收/保存/撤销原始输出 |
| `probes/full-suite-excerpt.txt` | 本机全量汇总 |
| `probes/special-tests-excerpt.txt` | A1+R1 专项矩阵汇总 |
| `probes/e2e-excerpt.txt` | Electron E2E 汇总 |
| `repro/r1-probe.probe.ts.txt` | 修复前后对照探针源码（与旧候选运行的文件 SHA-256 相同） |
| `repro/real-project-sandbox-verify.mjs` | 标准沙箱验证可执行脚本 |
| `repro/real-project/` | 自包含真实项目（tsc build + Vitest 25 项、5 个测试文件） |
| `repro/real-project-verify.mjs` | A1 阶段宿主运行器脚本（辅助证据，不作为产品验收依据） |
| `workspace-protection-before.txt` / `-after.txt` | 原工作区与 A0 工作树收工指纹 |

## 4. 独立复核命令

```bash
git fetch origin && git worktree add /tmp/r1-review feat/aiss-a1-trusted-evidence-001
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm ci && npm run typecheck && npm test && npm run build
npx vitest run tests/r1-git-integrity.test.ts tests/r1-trusted-evidence.test.ts tests/a1-trusted-evidence.test.ts tests/a1-evidence-chain.test.ts
npx vitest run -c vitest.e2e.config.ts
npm run build:core && A1_WORKTREE=$PWD node docs/reviews/AISS-A1-TRUSTED-EVIDENCE-R1-001/repro/real-project-sandbox-verify.mjs
# 同一探针：旧候选 → 8 failed/exit 1；新候选 → 9 passed/exit 0
cp docs/reviews/AISS-A1-TRUSTED-EVIDENCE-R1-001/repro/r1-probe.probe.ts.txt /tmp/r1-probe.test.ts && mkdir -p tests/probes && cp /tmp/r1-probe.test.ts tests/probes/ && npx vitest run tests/probes/r1-probe.test.ts
```

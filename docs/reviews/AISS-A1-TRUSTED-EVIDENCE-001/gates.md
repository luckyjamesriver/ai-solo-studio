# AISS-A1 门禁与可复核证据（仓库内证据包）

本目录保存可随 PR 远程读取的原始证据；本机另有完整副本（`/Users/jamesho/a1-evidence/`），
两个位置的探针源码 SHA-256 一致：`beb919675dc5e54ef76d8dd486c2f7756543a13be38e044220bf977ad58ee614`。

## 1. 运行身份与环境

| 项 | 值 |
| :-- | :-- |
| 基线 commit | `e69ca8511a17acfc4427954af13ef6d364ffb553`（`origin/rebuild`） |
| 产品分支 / PR | `feat/aiss-a1-trusted-evidence-001` / PR #7 |
| Node（engines: >=22.22.2 <23） | `v22.23.5`（`/opt/homebrew/opt/node@22/bin/node`） |
| npm | `10.9.9` |
| Vitest | `5.0.5`（`node_modules/vitest/package.json` sha256 `d00333f3a13ed44fedc77184c8675bae45246534f06684d94cff5e4f8a9f7c10`） |
| Electron | `45.0.0` |
| Git | `2.54.0 (Apple Git-157)` |
| OS | macOS（darwin arm64），真实显示环境（Electron E2E 需要） |
| 时区 | Asia/Singapore |

## 2. 门禁结果（本机）

| 门禁 | 命令 | 结果 | 证据 |
| :-- | :-- | :-- | :-- |
| TypeScript | `npm run typecheck` | 0 错误 | 本地完整副本 `logs/baseline-typecheck.log`（基线）与本机复跑 |
| 全量单元+集成 | `npm test` | **749 tests / 711 passed / 0 failed / 38 skipped，exit 0** | `full-suite-excerpt.txt` |
| A1 专项反向矩阵 | `npx vitest run tests/a1-trusted-evidence.test.ts tests/a1-evidence-chain.test.ts` | **34 passed / 0 failed，exit 0** | `a1-special-tests-excerpt.txt` |
| 构建 | `npm run build` | core tsc + renderer vite build 通过 | CI 日志 |
| Electron E2E | `npx vitest run -c vitest.e2e.config.ts` | **56 passed / 0 failed，exit 0** | `e2e-excerpt.txt` |
| 真实项目工作树 | `node …/real-project-verify.mjs` | 验收 749/711/38 + 结构化报告 integrity ok + `checked=true` 保存 | `real-project-verify.log` |
| 修复前对照（基线） | 同一探针放在基线 checkout 运行 | **5 failed / 0 passed，exit 1** | `probes/pre-fix-baseline-probe.log` |
| 修复后对照（A1） | 同一探针放在 A1 运行 | **5 passed / 0 failed，exit 0** | `probes/post-fix-a1-probe.log` |
| 原工作区保护 | SHA-256 / HEAD / status / diff 哈希 | 8/8 一致，未修改 | `workspace-protection-before.txt`、`workspace-protection-after.txt` |

## 3. CI（exact HEAD）

- 代码提交 `503179f8b1079b998352c0aac76d5469535592d7` → run [45325957236](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/45325957236)
  - Ubuntu：typecheck + `npm test` **749 项 / 709 passed / 40 skipped / 0 failed**（Linux 按设计跳过 2 个 macOS 专属用例）+ `npm run build` 通过。
  - macOS：typecheck + `npm test` **749 项 / 711 passed / 38 skipped / 0 failed** + Electron E2E **56 passed**。
- 本报告的最终 docs-only 提交的 exact-HEAD CI 结果见 [PR #7 checks](https://github.com/luckyjamesriver/ai-solo-studio/pull/7/checks)。

## 4. A0 独立复核材料（远程可读，独立分支，不合入）

- 分支：`audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001-delivery`
- HEAD：`a54fefbd152464a93ca3782faa130dd2582cdcf9`（`gh api …/branches/…` 复核 `protected: false`）
- 相对 `e69ca85` 仅 `docs/reviews/**` 新增；未修改产品源码、未推送 `rebuild`、未开 PR。
- OPEN 项按 `docs/reviews/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/open-items.md` 登记，未伪造通过。

## 5. 独立复核命令

```bash
git fetch origin
git worktree add /tmp/a1-review feat/aiss-a1-trusted-evidence-001
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm ci && npm run typecheck && npm test && npm run build
npx vitest run -c vitest.e2e.config.ts    # 需要真实显示环境（macOS）

# 缺陷修复前后对照：同一探针
cp docs/reviews/AISS-A1-TRUSTED-EVIDENCE-001/probes/a1-fix-proof.test.ts <checkout>/tests/probes/
npx vitest run tests/probes/a1-fix-proof.test.ts   # 基线 checkout → 5 failed；A1 → 5 passed
```

# AISS-A1-TRUSTED-EVIDENCE-R3 证据目录

- **详细报告（唯一权威）**：`../AISS-A1-TRUSTED-EVIDENCE-R3-INDEPENDENT-REMEDIATION-001.md`
- **代码提交（exact HEAD）**：`13edb62cb4d2546c1430f70aa5f520ca3424cdc6`
- **报告/证据提交（docs-only）**：`9c4d163f22647cdf4d024841b479968181bec596`

## 目录内容

| 路径 | 内容 |
| :-- | :-- |
| `workspace-protection-before.txt` / `workspace-protection-after.txt` | 原主工作区 8 个在研文件接管前/交付后的 git status 与 sha256 |
| `gates/typecheck.txt` | `tsc -p tsconfig.json --noEmit` |
| `gates/build-core.txt` / `gates/build-renderer.txt` | `tsc -p tsconfig.build.json` / `vite build` |
| `gates/full-suite.txt` | 全量 Vitest（763 passed / 38 skipped / 0 failed） |
| `gates/electron-e2e.txt` | Electron E2E（56 passed） |
| `gates/seatbelt-25-sample.txt` | 标准 Seatbelt 沙箱 25 项真实样本项目（build/test/save/undo） |
| `gates/ci-13edb62.json` | 代码提交 exact-HEAD CI（Ubuntu + macOS，含各 step conclusion） |
| `gates/remote-fingerprints.txt` | 远程 43 个改动文件逐文件读取与 sha256 比对 |
| `probes/r3-p5-child.mjs` | R3-05 真实保存/中断子进程 |
| `probes/old-candidate/p{1..5}-*.txt` | 旧候选 9d1533f 上同一组探针的真实失败输出 |
| `probes/new-candidate/p{1..5}-*.txt` | 新候选上同一组探针的真实通过输出 |

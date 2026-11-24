# 源码身份与运行环境

- 旧候选（复核未通过）：`6918ea590f14935c4f164185a5702c51ee9bf8c0`
- 主干基线：`e69ca8511a17acfc4427954af13ef6d364ffb553`
- 新候选（代码提交）：`6349f38a469ad88fac52c6742a3140a1153811f0`（最终 HEAD 见 PR #7 checks）
- 探针源码 SHA-256：`bdcb727570a30a140a091ffe38f6c5069622334504fc50c3897106cb8e7218aa`（`repro/r1-probe.probe.ts.txt`；旧候选运行时为同一文件）
- 沙箱验证脚本 SHA-256：`69a4e2f4d588493b7b26723e697ed2626b4e549ad75b0ac5384e7dab51ae396b`
- Node：`v22.23.5`（engines: >=22.22.2 <23；npm 10.9.9）
- Vitest：`5.0.5`（`node_modules/vitest/package.json` sha256 `d00333f3a13ed44fedc77184c8675bae45246534f06684d94cff5e4f8a9f7c10`）
- Electron：`45.0.0`；Git：`2.54.0 (Apple Git-157)`；OS：macOS darwin arm64（真实显示环境，E2E 需要）；时区 Asia/Singapore
- 标准沙箱：产品自带 `createStandaloneSandboxRunner()`（macOS Seatbelt，独立于 Codex）

## 旧候选运行同一探针

```
cp repro/r1-probe.probe.ts.txt <old-candidate-checkout>/tests/probes/
cd <old-candidate-checkout> && npx vitest run tests/probes/r1-probe.test.ts   # 8 failed / 1 passed, exit 1
```

新候选上同一文件：

```
cp repro/r1-probe.probe.ts.txt tests/probes/ && npx vitest run tests/probes/r1-probe.test.ts   # 9 passed, exit 0
```

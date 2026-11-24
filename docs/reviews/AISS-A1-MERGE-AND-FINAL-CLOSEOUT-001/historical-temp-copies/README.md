# 历史临时副本中唯一未入仓文件的保留记录

`a1-fix-proof.test.ts.txt` 原位于 `/tmp/a1-baseline/tests/probes/a1-fix-proof.test.ts`（历轮 A1 修复使用的合成基线仓库 `/tmp/a1-baseline` 中唯一未入仓的探针源码）。

- 原文件 sha256：`beb919675dc5e54ef76d8dd486c2f7756543a13be38e044220bf977ad58ee614`（3852 bytes）
- 合成仓库 `/tmp/a1-baseline` 自身只有一个本地合成提交 `eeecaf0 base`，不属于任何 Git worktree；无进程占用。
- 为遵守「历史失败证据/探针源码保留」，在退役该 176MB 临时测试副本前，把此唯一未入仓文件逐字节保存到本目录（后缀 `.txt` 仅为避免被测试收集器执行）。
- 其余 `/tmp/a1-*.log`、`/tmp/a1-*.json`（历轮测试输出，约 2.3MB）按「历史日志保留」原则保留在原位，未删除、未改写。

/**
 * 真实 Codex 集成测试的统一开关。
 * `npm run test:real` 固定设置 STUDIO_REAL_CODEX=1 并运行整个 tests/integration 目录；
 * 为了不在每次运行时重复发起所有历史实测（消耗额度），具体运行哪些套件由本文件内的清单决定——
 * 要重跑某个历史套件，把它的名字加进 ACTIVE_SUITES，不要在命令行加环境变量。
 *
 * 套件名：b3-0（B3-0 施工模式探测）、b3-1（B3-1 补充实测与端到端）、b3-1b（B3-1b 真实 worktree 下的 git 与 npm test）、
 *        b4-1（B4-1 真实 Codex 端到端：改标题 → 验收 → 保存 → 撤销，哨兵钩子全程不触发）、
 *        persist-1（ADR 0005 持久化服务：两个任务并行施工，状态互不覆盖，保存并在重启对账后仍完整；2 次模型回合）、
 *        codex-loop、extensions、path、sentinel、thinker（M2/M2.5 的历史实测，部分依赖已被 B3 替换的旧式参数）。
 */
export const ACTIVE_SUITES = new Set<string>(['persist-1']);

export const realEnabled = (suite: string): boolean => process.env.STUDIO_REAL_CODEX === '1' && ACTIVE_SUITES.has(suite);

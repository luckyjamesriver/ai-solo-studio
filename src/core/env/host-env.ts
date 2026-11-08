/**
 * 宿主启动子进程时使用的环境。
 * 图形界面（Dock/Finder）启动的应用拿到的 PATH 往往只有系统最小集合，找不到 Homebrew 装的 git/node/codex。
 * 补全路径只作用于“宿主启动的子进程”：这里返回的是副本，**不修改 process.env**，也不写任何用户配置。
 */
let extraPathDirs: readonly string[] = [];

/** 设置需要补充到子进程 PATH 末尾的目录（由 resolveHostPath 的结果注入）。 */
export function setSupplementalPath(dirs: readonly string[]): void {
  extraPathDirs = [...dirs];
}

export function getSupplementalPath(): readonly string[] {
  return extraPathDirs;
}

export function withSupplementalPath(base: NodeJS.ProcessEnv, extra: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (!extra.length) return env;
  const have = (env.PATH ?? '').split(':').filter(Boolean);
  const add = extra.filter((d) => !have.includes(d));
  env.PATH = [...have, ...add].join(':');
  return env;
}

/** 当前进程环境的副本，附带补全的 PATH。始终返回新对象。 */
export function hostEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return withSupplementalPath(base, extraPathDirs);
}

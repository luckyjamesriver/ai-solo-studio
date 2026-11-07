import { run } from '../proc/run.js';

export type Light = 'green' | 'yellow' | 'red';

export interface EnvItem {
  id: string;
  label: string;
  light: Light;
  detail: string;
  /** 官方安装/说明页面 */
  help?: string;
}

async function version(cmd: string, args = ['--version']): Promise<string | null> {
  const r = await run(cmd, args, { cwd: process.cwd(), timeoutMs: 8000, killGraceMs: 500 });
  if (r.outcome.kind === 'exited' && r.outcome.code === 0) return (r.stdout || r.stderr).trim().split('\n')[0] ?? '';
  return null;
}

/** 环境体检：只读检测，不安装任何东西。 */
export async function detectEnvironment(): Promise<EnvItem[]> {
  const [gitV, nodeV, npmV] = await Promise.all([version('git'), version('node'), version('npm')]);
  const items: EnvItem[] = [
    gitV
      ? { id: 'git', label: 'Git', light: 'green', detail: gitV }
      : { id: 'git', label: 'Git', light: 'red', detail: '未找到 Git。它用来保存你的每个版本，必须安装。', help: 'https://git-scm.com/downloads' },
    nodeV
      ? { id: 'node', label: 'Node.js', light: 'green', detail: `${nodeV}${npmV ? `，npm ${npmV}` : ''}` }
      : { id: 'node', label: 'Node.js', light: 'yellow', detail: '未找到 Node.js。网页项目的预览、构建和测试需要它。', help: 'https://nodejs.org/' },
  ];
  return items;
}

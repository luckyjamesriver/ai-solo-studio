export interface CliArgs {
  requirement?: string;
  resume?: string;
  importReport?: string;
  task?: string;
  single: boolean;
  planner?: string;
  reviewer?: string;
  exportDir?: string;
  setCurrent: boolean;
  project?: string;
  context: string[];
  maxCalls?: number;
  stepTimeoutSec?: number;
  maxTotalSec?: number;
  maxCostUsd?: number;
  help: boolean;
}

export const USAGE = `用法：
  npm run think -- "<需求>" --task <任务编号> --export-dir <目录> [选项]
      拆条目 → 你确认 → 起草 → 评审 → 修订 → 机械检查 → 你裁决 → 批准 → 导出任务文件
  npm run think -- --resume <线程编号> [--task <任务编号> --export-dir <目录>]
  npm run think -- --import <report.md> --task <任务编号>      导入并核对执行报告（已绑定才可审查）

选项：
  --single                单思考者模式（跳过评审；记录与任务文件标注“未经独立评审”）
  --planner <id>          规划者（codex | claude-cli-personal）
  --reviewer <id>         评审者（需与规划者不同）
  （都不指定时使用预设 dev-personal：Claude 规划 + Codex 评审——开发者自用预设，不是产品默认）
  --export-dir <目录>     任务文件导出目录
  --set-current           同时更新导出目录下的 next-task.md（已存在时要求确认并另存旧文件）
  --context <文件>        按需资料（项目目录内；可重复）
  --project <目录>        项目目录（默认当前目录所在的 Git 仓库）
  --max-calls <n>         每线程调用次数上限（默认 12）
  --step-timeout <秒>     单步超时（默认 180）
  --max-total <秒>        累计调用耗时上限（默认 1800）
  --max-cost <美元>       累计已知费用上限（只统计报告了费用的思考者）
说明：单次调用的费用无法事前封顶；预算是“累计到达即不再发起新调用”，不是硬上限。
没有交互终端（无 TTY）时，所有需要你确认的点都会停止并保存线程，不会默认通过。`;

/** 解析命令行；任何不认识的选项都报错（不静默忽略）。 */
export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { single: false, setCurrent: false, context: [], help: false };
  const positional: string[] = [];
  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} 需要一个值`);
    return v;
  };
  const num = (v: string, flag: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} 需要一个正数`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    switch (t) {
      case '--help':
      case '-h':
        a.help = true;
        break;
      case '--single':
        a.single = true;
        break;
      case '--set-current':
        a.setCurrent = true;
        break;
      case '--resume':
        a.resume = need(i++, t);
        break;
      case '--import':
        a.importReport = need(i++, t);
        break;
      case '--task':
        a.task = need(i++, t);
        break;
      case '--planner':
        a.planner = need(i++, t);
        break;
      case '--reviewer':
        a.reviewer = need(i++, t);
        break;
      case '--export-dir':
        a.exportDir = need(i++, t);
        break;
      case '--project':
        a.project = need(i++, t);
        break;
      case '--context':
        a.context.push(need(i++, t));
        break;
      case '--max-calls':
        a.maxCalls = Math.floor(num(need(i++, t), t));
        break;
      case '--step-timeout':
        a.stepTimeoutSec = num(need(i++, t), t);
        break;
      case '--max-total':
        a.maxTotalSec = num(need(i++, t), t);
        break;
      case '--max-cost':
        a.maxCostUsd = num(need(i++, t), t);
        break;
      default:
        if (t.startsWith('--')) throw new Error(`不认识的选项：${t}`);
        positional.push(t);
    }
  }
  if (positional.length) a.requirement = positional.join(' ');
  const modes = [a.requirement !== undefined, a.resume !== undefined, a.importReport !== undefined].filter(Boolean).length;
  if (!a.help && modes !== 1) throw new Error('请且只请提供一种操作：需求文字、--resume 或 --import');
  if (a.importReport && !a.task) throw new Error('--import 需要同时给出 --task <任务编号>');
  if (a.single && a.reviewer) throw new Error('--single 与 --reviewer 不能同时使用');
  return a;
}

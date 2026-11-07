import { ClaudeCliThinker } from '../claude-cli.js';
import { CodexThinker } from '../codex.js';
import type { Thinker } from '../types.js';

/** 思考者注册表：id → 构造函数。具体实现只在这里（入口层）出现，流程引擎不引用它们。 */
export type ThinkerRegistry = Record<string, () => Thinker>;

export function defaultRegistry(): ThinkerRegistry {
  return {
    codex: () => new CodexThinker(),
    // 本入口是命令行，永远不是打包后的 Electron 应用，显式传入 isPackaged:false
    'claude-cli-personal': () => new ClaudeCliThinker({ isPackaged: false }),
  };
}

/** 预设：dev-personal = ClaudeCli 规划 + Codex 评审。开发者自用预设，不是产品默认。 */
export const PRESETS = {
  'dev-personal': { planner: 'claude-cli-personal', reviewer: 'codex', note: '开发者自用预设（Claude 本机登录规划 + Codex 评审），不是产品默认' },
} as const;
export const DEFAULT_PRESET = 'dev-personal';

export interface Resolved {
  planner: Thinker;
  reviewer?: Thinker;
  label: string;
}

export class ThinkerSelectionError extends Error {}

/** 列出所有已注册的思考者及其可用性（用于报错时告诉用户有哪些可用）。 */
export async function describeAvailable(reg: ThinkerRegistry): Promise<string> {
  const lines: string[] = [];
  for (const [id, make] of Object.entries(reg)) {
    const d = await make().detect();
    lines.push(`  - ${id}：${d.available ? '可用' : '不可用'}${d.note ? `（${d.note}）` : ''}`);
  }
  return lines.join('\n');
}

/**
 * 解析规划者/评审者。未指定时使用预设；若预设不可用，报错说明并列出可用思考者，
 * 绝不自动改用其他规划者（避免把自审当互审，或悄悄换了数据流向的服务）。
 */
export async function resolveThinkers(reg: ThinkerRegistry, o: { planner?: string; reviewer?: string; single: boolean }): Promise<Resolved> {
  const get = (id: string): Thinker => {
    const make = reg[id];
    if (!make) throw new ThinkerSelectionError(`没有名为 ${id} 的思考者。已注册：${Object.keys(reg).join('、')}`);
    return make();
  };
  const ensure = async (t: Thinker, role: string) => {
    const d = await t.detect();
    if (!d.available) throw new ThinkerSelectionError(`${role} ${t.id} 不可用：${d.note ?? '未知原因'}\n不会自动改用其他${role}。当前可用情况：\n${await describeAvailable(reg)}`);
    return t;
  };
  if (!o.planner && !o.reviewer) {
    const p = PRESETS[DEFAULT_PRESET];
    const planner = await ensure(get(p.planner), '规划者');
    if (o.single) return { planner, label: `单思考者（规划者 ${planner.id}）` };
    const reviewer = await ensure(get(p.reviewer), '评审者');
    return { planner, reviewer, label: `预设 ${DEFAULT_PRESET}：${p.note}` };
  }
  if (!o.planner) throw new ThinkerSelectionError('指定了 --reviewer 就必须同时指定 --planner');
  const planner = await ensure(get(o.planner), '规划者');
  if (o.single) return { planner, label: `单思考者（规划者 ${planner.id}）` };
  if (!o.reviewer) throw new ThinkerSelectionError('指定了 --planner 就必须同时指定 --reviewer（或使用 --single）；不会自动补一个评审者');
  const reviewer = await ensure(get(o.reviewer), '评审者');
  return { planner, reviewer, label: `规划者 ${planner.id} / 评审者 ${reviewer.id}` };
}

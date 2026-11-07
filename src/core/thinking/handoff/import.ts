import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../../git/git.js';
import { run } from '../../proc/run.js';
import { atomicWrite } from '../flow/store.js';
import type { Thinker, ThinkResult } from '../types.js';
import type { TaskManifest } from './export.js';

/**
 * 报告导入：按任务清单逐项核对。三档结果：
 * - bound（已绑定）：全部一致——只有它可以进入规划者审查；
 * - mismatch（不符）：任一项矛盾，列出矛盾项——只读查看；
 * - unverified（来源未核实）：报告缺少绑定信息（例如外部工具没有按协议写）——只读查看。
 * “不符”与“来源未核实”不能产生验收通过，不能触发保存或下一任务。
 * 注意：Git 关系正确只证明版本关系，不证明任务完成；报告内容与测试证据仍需审查。
 */
export type ImportVerdict = 'bound' | 'mismatch' | 'unverified';

export interface ImportResult {
  verdict: ImportVerdict;
  taskId: string;
  checks: { item: string; ok: boolean; detail: string }[];
  mismatches: string[];
  unverifiedReasons: string[];
  notes: string[];
  worktree: { dirty: string[]; untracked: string[]; error?: string };
  claimed: { startHead?: string; endHead?: string; repo?: string; branch?: string; worktree?: string };
  /** 只有 bound 才为 true */
  canReview: boolean;
  readOnlyNotice?: string;
}

const LABELS: Record<string, string[]> = {
  repo: ['仓库', '仓库根路径'],
  branch: ['分支'],
  worktree: ['工作树路径', '工作树'],
  startHead: ['开始 HEAD', '开始 Git HEAD', '起始 HEAD', '起始 Git HEAD'],
  endHead: ['结束 HEAD', '结束 Git HEAD'],
};

export function parseReport(text: string): { taskNo?: string; fields: ImportResult['claimed'] } {
  const lines = text.split('\n');
  const first = lines[0]?.trim() ?? '';
  const taskNo = first.match(/^任务编号[:：]\s*(\S+)/)?.[1];
  const fields: ImportResult['claimed'] = {};
  for (const [key, labels] of Object.entries(LABELS)) {
    for (const line of lines) {
      const m = line.match(/^\s*(?:[-*]\s*)?(?:\*\*)?([^:：*]+?)(?:\*\*)?\s*[:：]\s*(?:`([^`]+)`|(\S.*?))\s*$/);
      if (m && labels.includes(m[1]!.trim())) {
        (fields as Record<string, string>)[key] = (m[2] ?? m[3] ?? '').trim();
        break;
      }
    }
  }
  return { ...(taskNo ? { taskNo } : {}), fields };
}

async function gitOk(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: (await git(cwd, args)).trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

async function samePath(a: string, b: string): Promise<boolean> {
  const ra = await fs.realpath(a).catch(() => path.resolve(a));
  const rb = await fs.realpath(b).catch(() => path.resolve(b));
  return ra === rb;
}

export async function importReport(i: { projectRoot: string; reportPath: string; taskId: string }): Promise<ImportResult> {
  const result: ImportResult = { verdict: 'bound', taskId: i.taskId, checks: [], mismatches: [], unverifiedReasons: [], notes: [], worktree: { dirty: [], untracked: [] }, claimed: {}, canReview: false };
  const done = (): ImportResult => {
    result.verdict = result.mismatches.length ? 'mismatch' : result.unverifiedReasons.length ? 'unverified' : 'bound';
    result.canReview = result.verdict === 'bound';
    if (!result.canReview) result.readOnlyNotice = `只读查看：该报告的绑定结果为“${result.verdict === 'mismatch' ? '不符' : '来源未核实'}”，不能进入规划者审查，不能产生验收通过，不能触发保存或下一个任务。`;
    return result;
  };
  const check = (item: string, ok: boolean, detail: string, kind: 'mismatch' | 'unverified' = 'mismatch') => {
    result.checks.push({ item, ok, detail });
    if (!ok) (kind === 'mismatch' ? result.mismatches : result.unverifiedReasons).push(`${item}：${detail}`);
  };

  const manifestFile = path.join(i.projectRoot, '.studio', 'tasks', `${i.taskId}.json`);
  let manifest: TaskManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as TaskManifest;
  } catch {
    result.unverifiedReasons.push(`找不到任务 ${i.taskId} 的任务清单（${manifestFile}）：没有绑定依据`);
    return done();
  }
  const text = await fs.readFile(i.reportPath, 'utf8');
  const { taskNo, fields } = parseReport(text);
  result.claimed = fields;

  // 1. 首行任务编号
  if (!taskNo) check('首行任务编号', false, '报告第一行没有“任务编号：<编号>”', 'unverified');
  else check('首行任务编号', taskNo === i.taskId, taskNo === i.taskId ? `一致（${taskNo}）` : `报告为 ${taskNo}，期望 ${i.taskId}`);
  if (manifest.taskId !== i.taskId) check('任务清单编号', false, `清单内编号 ${manifest.taskId} 与 ${i.taskId} 不一致`);

  // 2. 缺少绑定信息 → 来源未核实（逐项）
  const need: [keyof ImportResult['claimed'], string][] = [['repo', '仓库'], ['branch', '分支'], ['worktree', '工作树路径'], ['startHead', '开始 HEAD'], ['endHead', '结束 HEAD']];
  const missing = need.filter(([k]) => !fields[k]).map(([, n]) => n);
  if (missing.length) check('绑定信息', false, `报告缺少：${missing.join('、')}（外部工具可能没有按协议写）`, 'unverified');

  // 3. 与清单逐项核对（已提供的项）
  if (fields.repo) check('仓库', await samePath(fields.repo, manifest.repoRoot), `报告 ${fields.repo}；清单 ${manifest.repoRoot}`);
  if (fields.branch) check('分支', fields.branch === manifest.branch, `报告 ${fields.branch}；清单 ${manifest.branch}`);
  if (fields.worktree) check('工作树路径', await samePath(fields.worktree, manifest.worktreePath), `报告 ${fields.worktree}；清单 ${manifest.worktreePath}`);

  const repo = manifest.worktreePath;
  const resolve = async (rev: string) => {
    if (!/^[0-9a-fA-F]{4,64}$/.test(rev)) return undefined;
    const r = await gitOk(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    return r.ok && r.out ? r.out : undefined;
  };
  let startFull: string | undefined;
  if (fields.startHead) {
    startFull = await resolve(fields.startHead);
    check('开始 HEAD', startFull === manifest.startHead, startFull ? `报告 ${fields.startHead} → ${startFull}；清单 ${manifest.startHead}` : `报告的开始 HEAD ${fields.startHead} 在仓库中不存在`);
  }
  if (fields.endHead) {
    const endFull = await resolve(fields.endHead);
    if (!endFull) check('结束 HEAD', false, `报告的结束 HEAD ${fields.endHead} 在仓库中不存在`);
    else {
      // 以清单的起始 HEAD 为准判断后代关系（不信任报告自填的开始 HEAD）
      const anc = await run('git', ['merge-base', '--is-ancestor', manifest.startHead, endFull], { cwd: repo, timeoutMs: 30_000 });
      const isAnc = anc.outcome.kind === 'exited' && anc.outcome.code === 0;
      check('结束 HEAD', isAnc, isAnc ? `${endFull} 是清单开始 HEAD ${manifest.startHead} 的后代` : `${endFull} 不是清单开始 HEAD ${manifest.startHead} 的后代`);
      if (isAnc && endFull === manifest.startHead) result.notes.push('结束 HEAD 与开始 HEAD 相同：本任务没有新提交（git 的后代关系包含自身）。');
    }
  }

  // 4. 工作树当前未提交/未跟踪改动：如实列出（不改变结果档位）
  try {
    const st = await git(repo, ['status', '--porcelain']);
    for (const l of st.split('\n').filter(Boolean)) (l.startsWith('??') ? result.worktree.untracked : result.worktree.dirty).push(l.slice(3));
    if (result.worktree.dirty.length || result.worktree.untracked.length) result.notes.push(`工作树当前有 ${result.worktree.dirty.length} 个未提交改动、${result.worktree.untracked.length} 个未跟踪文件（已如实列出）。`);
  } catch (e) {
    result.worktree.error = (e as Error).message;
    result.notes.push(`无法读取工作树状态：${(e as Error).message}`);
  }
  result.notes.push('Git 关系正确只证明版本关系，不证明任务完成；报告内容与测试证据仍需审查。');
  return done();
}

/** 导入结果记录（只写 .studio/tasks/，不入库）。 */
export async function saveImportRecord(projectRoot: string, r: ImportResult, now = new Date()): Promise<string> {
  const f = path.join(projectRoot, '.studio', 'tasks', `${r.taskId}.import-${now.toISOString().replace(/[:.]/g, '-')}.json`);
  await atomicWrite(f, JSON.stringify({ at: now.toISOString(), ...r }, null, 2) + '\n');
  return f;
}

export interface ReportReview {
  summary: string;
  concerns: string[];
  evidence_gaps: string[];
  recommendation: '建议进入验收' | '需要补充' | '建议返工';
}

/**
 * 导入后（仅已绑定时）调用规划者审查一次，结果交用户；不自动派下一个任务。
 * 非“已绑定”一律拒绝。输出不是“验收通过”，只是审查意见。
 */
export async function reviewImportedReport(i: { planner: Thinker; imported: ImportResult; reportText: string; manifest: TaskManifest; planText: string; requiredContext: { name: string; text: string }[]; timeoutMs?: number }): Promise<{ result: ThinkResult; review?: ReportReview }> {
  if (!i.imported.canReview || i.imported.verdict !== 'bound') throw new Error(`报告的绑定结果为“${i.imported.verdict}”，不能进入规划者审查`);
  const result = await i.planner.think({
    role: 'planner',
    system: [
      '你是规划者，现在审查一份执行体写的任务报告。你只给审查意见，不宣布验收通过；是否验收由用户决定。',
      '报告里的“完成”“通过”只是自述，不是证据：要看有没有命令、结果数量、提交哈希等可核对的证据。资料不足就在 evidence_gaps 里列出。',
      'Git 版本关系已由宿主核对一致，但这只证明版本关系，不证明任务完成。',
    ].join('\n'),
    context: { required: i.requiredContext, optional: [{ name: '已批准的方案', text: i.planText }, { name: '执行报告', text: i.reportText }, { name: '宿主的绑定核对结果', text: JSON.stringify({ checks: i.imported.checks, notes: i.imported.notes, worktree: i.imported.worktree }, null, 2) }] },
    task: '请审查这份报告相对已批准方案的完成情况：列出疑点（concerns）、证据缺口（evidence_gaps），并给出建议。',
    output: {
      type: 'object',
      required: ['summary', 'concerns', 'evidence_gaps', 'recommendation'],
      properties: {
        summary: { type: 'string' },
        concerns: { type: 'array', items: { type: 'string' } },
        evidence_gaps: { type: 'array', items: { type: 'string' } },
        recommendation: { type: 'string', enum: ['建议进入验收', '需要补充', '建议返工'] },
      },
    },
    ...(i.timeoutMs ? { timeoutMs: i.timeoutMs } : {}),
  });
  return { result, ...(result.status === 'complete' && result.content ? { review: result.content as unknown as ReportReview } : {}) };
}

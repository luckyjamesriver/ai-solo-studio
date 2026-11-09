import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { git } from '../../git/git.js';
import { ConsentStore, FlowEngine, BUDGET_NOTE, gitignoreHasStudio, loadRequiredContext, type FlowOutcome, type FlowUI } from '../flow/index.js';
import { exportTask, importReport, reviewImportedReport, saveImportRecord, type TaskManifest } from '../handoff/index.js';
import { ManifestStore } from '../../persistence/manifest.js';
import { parseArgs, USAGE } from './args.js';
import { defaultRegistry, resolveThinkers, ThinkerSelectionError, type ThinkerRegistry } from './presets.js';
import { nonInteractiveUI, ttyUI, type IO } from './ui.js';

export interface CliEnv {
  cwd: string;
  isTTY: boolean;
  io: IO;
  registry?: ThinkerRegistry;
  /** 测试用：替换交互层（真实集成测试以“接受”应答确认点） */
  ui?: FlowUI & { confirmReplaceCurrent: (firstLine: string) => Promise<boolean> };
}

export const EXIT = { ok: 0, usage: 2, mismatch: 3, unverified: 4, waiting: 5, stopped: 6, error: 1 } as const;

/** 入口：返回退出码（不直接 process.exit，便于测试）。 */
export async function runCli(argv: string[], env: CliEnv): Promise<number> {
  const say = env.io.print;
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    say(`参数错误：${(e as Error).message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (args.help) {
    say(USAGE);
    return EXIT.ok;
  }

  let projectRoot: string;
  try {
    projectRoot = await fs.realpath((await git(path.resolve(env.cwd, args.project ?? '.'), ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    say('这里不是 Git 仓库（或 --project 指向的目录不是）。请在项目目录中运行。');
    return EXIT.usage;
  }
  if (!(await gitignoreHasStudio(projectRoot))) say('⚠ .gitignore 中没有 .studio/ ：线程过程记录会被当作未跟踪文件。请你自己加上这一行；本工具不会自动修改 .gitignore。');

  const registry = env.registry ?? defaultRegistry();
  const ui = env.ui ?? (env.isTTY ? ttyUI(env.io) : nonInteractiveUI(say));
  if (!env.isTTY && !env.ui) say('（没有交互终端：所有需要你确认的点都会停下并保存线程，不会默认通过。）');

  try {
    if (args.importReport) return await doImport(projectRoot, args, registry, ui, env);

    const picked = await resolveThinkers(registry, { ...(args.planner ? { planner: args.planner } : {}), ...(args.reviewer ? { reviewer: args.reviewer } : {}), single: args.single });
    say(`思考者：${picked.label}`);
    if (args.single) say('⚠ 单思考者模式：不做独立评审，记录与任务文件会标注“未经独立评审”。');
    const budget = {
      ...(args.maxCalls ? { maxCalls: args.maxCalls } : {}),
      ...(args.stepTimeoutSec ? { stepTimeoutMs: args.stepTimeoutSec * 1000 } : {}),
      ...(args.maxTotalSec ? { maxTotalCallMs: args.maxTotalSec * 1000 } : {}),
      ...(args.maxCostUsd ? { maxCostUsd: args.maxCostUsd } : {}),
    };
    const engine = new FlowEngine({ projectRoot, planner: picked.planner, ...(picked.reviewer ? { reviewer: picked.reviewer } : {}), single: args.single, ui, budget, optionalFiles: args.context, consent: new ConsentStore(projectRoot) });
    say(BUDGET_NOTE);

    if (args.requirement !== undefined) {
      if (!args.task || !args.exportDir) {
        say('新线程需要同时给出 --task <任务编号> 与 --export-dir <目录>（流程的终点是导出任务文件）。');
        return EXIT.usage;
      }
      await engine.create(args.requirement);
      say(`线程 ${engine.thread.id} 已创建（.studio/threads/${engine.thread.id}/）。`);
    } else {
      await engine.load(args.resume!);
      say(`恢复线程 ${engine.thread.id}（状态 ${engine.thread.state}）；已完成的产物：${engine.thread.artifacts.map((a) => `${a.name} v${a.version}`).join('、') || '无'}`);
    }

    const out = await engine.run();
    return await finish(out, engine, args, projectRoot, ui, env);
  } catch (e) {
    say(`出错：${(e as Error).message}`);
    return e instanceof ThinkerSelectionError ? EXIT.usage : EXIT.error;
  }
}

async function finish(out: FlowOutcome, engine: FlowEngine, args: ReturnType<typeof parseArgs>, projectRoot: string, ui: NonNullable<CliEnv['ui']>, env: CliEnv): Promise<number> {
  const say = env.io.print;
  const resumeHint = `之后可用：npm run think -- --resume ${out.threadId} --task <任务编号> --export-dir <目录>`;
  switch (out.kind) {
    case 'waiting':
      say(`\n⏸ 停在确认点：${out.message}\n${resumeHint}`);
      return EXIT.waiting;
    case 'stopped':
      say(`\n■ 线程已停止：${out.reason}\n已有的正式产物全部保留在 .studio/threads/${out.threadId}/。`);
      return EXIT.stopped;
    case 'rejected':
      say('\n✘ 你否决了方案。线程已记录为 rejected。');
      return EXIT.stopped;
    case 'integrity_error':
      say(`\n✘ 停止：${out.message}\n没有使用任何可疑产物；线程状态未改动。请先查明文件为何被改动。`);
      return EXIT.error;
    case 'exported':
      say('\n该线程已经导出过任务。');
      return EXIT.ok;
    case 'approved': {
      say(`\n✔ 已批准。方案已写入 ${path.relative(projectRoot, out.planPath)}（不会自动提交）。`);
      if (!args.task || !args.exportDir) {
        say(`缺少 --task / --export-dir，暂不导出。${resumeHint}`);
        return EXIT.usage;
      }
      const info = await engine.planInfo();
      const ex = await exportTask({
        projectRoot,
        taskId: args.task,
        threadId: engine.thread.id,
        exportDir: path.resolve(env.cwd, args.exportDir),
        setCurrent: args.setCurrent,
        confirmReplaceCurrent: (l) => ui.confirmReplaceCurrent(l),
        plan: { path: info.planPath, text: info.plan, sha256: info.sha256, artifactVersion: info.artifactVersion },
        requirements: info.req.items,
        single: engine.thread.single,
      });
      await engine.markExported({ taskId: args.task, taskFile: ex.taskFile, manifest: ex.manifestFile });
      say(`任务文件：${ex.taskFile}\n任务清单：${ex.manifestFile}`);
      if (args.setCurrent) say(ex.currentUpdated ? '已更新 next-task.md。' : `⚠ ${ex.currentNote ?? '未更新 next-task.md。'}`);
      else say('没有更新 next-task.md（需要时加 --set-current）。');
      say('不会自动开始执行，也不会自动开始下一个任务。');
      return EXIT.ok;
    }
  }
}

async function doImport(projectRoot: string, args: ReturnType<typeof parseArgs>, registry: ThinkerRegistry, ui: NonNullable<CliEnv['ui']>, env: CliEnv): Promise<number> {
  const say = env.io.print;
  const reportPath = path.resolve(env.cwd, args.importReport!);
  const r = await importReport({ projectRoot, reportPath, taskId: args.task! });
  const label = { bound: '已绑定', mismatch: '不符', unverified: '来源未核实' }[r.verdict];
  say(`\n报告绑定结果：${label}`);
  for (const c of r.checks) say(`  ${c.ok ? '✔' : '✘'} ${c.item}：${c.detail}`);
  for (const m of r.mismatches) say(`  矛盾：${m}`);
  for (const u of r.unverifiedReasons) say(`  未核实：${u}`);
  if (r.worktree.dirty.length) say(`  未提交改动：${r.worktree.dirty.join('、')}`);
  if (r.worktree.untracked.length) say(`  未跟踪文件：${r.worktree.untracked.join('、')}`);
  for (const n of r.notes) say(`  注：${n}`);
  const rec = await saveImportRecord(projectRoot, r);
  say(`导入记录：${path.relative(projectRoot, rec)}`);
  if (!r.canReview) {
    say(r.readOnlyNotice!);
    return r.verdict === 'mismatch' ? EXIT.mismatch : EXIT.unverified;
  }

  // 已绑定：可调用规划者审查一次，结果交用户
  const manifest = await new ManifestStore(projectRoot).get(args.task);
  if (!manifest) {
    say(`找不到任务清单：${args.task}`);
    return EXIT.error;
  }
  const picked = await resolveThinkers(registry, { ...(args.planner ? { planner: args.planner } : {}), ...(args.reviewer ? { reviewer: args.reviewer } : {}), single: true });
  const consent = new ConsentStore(projectRoot);
  if (!(await consent.has(picked.planner.service))) {
    const ans = await ui.confirmSend(picked.planner.service);
    if (ans === undefined) {
      say(`已绑定，但首次向“${picked.planner.service}”发送资料需要你确认，当前无法询问，跳过规划者审查。`);
      return EXIT.waiting;
    }
    if (!ans) {
      say('你没有同意发送资料，跳过规划者审查。');
      return EXIT.ok;
    }
    await consent.record(picked.planner.service);
  }
  const planText = await fs.readFile(path.join(projectRoot, manifest.plan.path), 'utf8').catch(() => '（找不到方案文件）');
  const reportText = await fs.readFile(reportPath, 'utf8');
  const required = await loadRequiredContext(projectRoot);
  const { result, review } = await reviewImportedReport({ planner: picked.planner, imported: r, reportText, manifest, planText, requiredContext: [required] });
  if (!review) {
    say(`规划者审查没有完成（${result.status}）${result.error ? '：' + result.error : ''}。不会自动重试；报告仍已绑定，可稍后重新导入。`);
    return EXIT.error;
  }
  say(`\n规划者审查（只是意见，不是验收通过；是否验收由你决定）：\n  结论建议：${review.recommendation}\n  概述：${review.summary}`);
  for (const c of review.concerns) say(`  疑点：${c}`);
  for (const g of review.evidence_gaps) say(`  证据缺口：${g}`);
  say('不会自动派下一个任务。');
  return EXIT.ok;
}

/** 真实终端入口（scripts/think.mjs 调用）。 */
export async function mainFromProcess(argv: string[]): Promise<number> {
  const isTTY = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const rl = isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const io: IO = {
    print: (t) => console.log(t),
    ask: async (p) => {
      if (!rl) throw new Error('没有交互终端，无法提问');
      return rl.question(p);
    },
  };
  try {
    return await runCli(argv, { cwd: process.cwd(), isTTY, io });
  } finally {
    rl?.close();
  }
}

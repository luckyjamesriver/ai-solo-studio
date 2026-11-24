/**
 * AISS-A1-TRUSTED-EVIDENCE-R3-001 / R3-05 探针子进程：真实保存链路（验收 → 真实 Vitest 证据 → 保存试检查 → 写入主项目）。
 *
 * 父进程在「主项目 ff 合并刚发生」时用 SIGKILL 杀掉本进程，模拟应用/控制器被关闭；
 * 随后父进程重新打开记录库并调用 reconcileTasks，核对恢复出来的试检查证据是否是真实事实。
 *
 * 使用 dist-electron（tsc 产物，与源码同一份实现）以便子进程独立运行。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DIST = process.env.R3_DIST;
const REPO = process.env.R3_REPO;
const DATA = process.env.R3_DATA;
const BULK = Number(process.env.R3_BULK ?? '620');
const STATE = path.join(DATA, 'child-state.json');

const load = async (rel) => import(pathToFileURL(path.join(DIST, rel)).href);
const { TaskController } = await load('core/app/task-controller.js');
const { TaskPrefs } = await load('core/app/prefs.js');
const { FakeExecutor } = await load('core/executor/adapters/fake.js');

/** 与 tests/helpers.ts 的 testSandboxRunner 相同语义：测试专用，直接在本机运行命令。 */
const testSandboxRunner = () => ({
  runCommand: (req) =>
    new Promise((resolve) => {
      const t0 = Date.now();
      let stdout = '';
      let stderr = '';
      const child = spawn(req.argv[0], req.argv.slice(1), { cwd: req.cwd, env: req.env, shell: false });
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (e) => resolve({ status: 'unavailable', reason: e.message }));
      child.on('close', (code) =>
        resolve({ status: 'ran', exitCode: code, stdout, stderr, timedOut: false, durationMs: Date.now() - t0 }),
      );
    }),
});

const writeState = async (obj) => {
  const tmp = `${STATE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, STATE);
};

const steps = [];
for (let i = 0; i < BULK; i += 1) {
  steps.push({ do: 'write', path: `bulk/f${String(i).padStart(3, '0')}.txt`, content: `bulk ${i}\n` });
}
steps.push({ do: 'write', path: 'index.html', content: '<h1>accepted</h1>\n' });
steps.push({ do: 'exit', code: 0 });

const ctl = new TaskController({
  repo: REPO,
  makeExecutor: () => {
    const ex = new FakeExecutor(steps);
    ex.sandboxRunner = testSandboxRunner();
    return ex;
  },
  pickDirectory: async () => null,
  prefs: new TaskPrefs(DATA),
});

const created = await ctl.create('改标题');
await ctl.savePlan(created.id, { goal: '改标题', criteria: ['标题已更新'], mode: 'standard', network: false });
await ctl.start(created.id, false);

let view;
for (let i = 0; i < 6000; i += 1) {
  view = await ctl.getAcceptanceView(created.id);
  if (view.state === 'reviewing' && !view.busy) break;
  await new Promise((r) => setTimeout(r, 20));
}
if (!view || view.state !== 'reviewing') throw new Error(`验收没有就绪：${view?.state}`);
const testItem = view.items.find((i) => i.key === 'test');
if (testItem.status !== 'verified') throw new Error(`验收测试结论不是 verified：${testItem.status}`);
for (const c of view.criteria) view = (await ctl.confirmCriterion(created.id, c.id, view.version)).view;
for (const d of view.denied) view = (await ctl.ackDenied(created.id, d.id, view.version)).view;

const raw = (await ctl.listTasksRaw()).find((t) => t.id === created.id);
await writeState({ phase: 'ready', id: created.id, version: view.version, acceptedTree: raw.acceptedTree, readyAt: new Date().toISOString() });

const result = await ctl.saveTask(created.id, view.version);
const after = (await ctl.listTasksRaw()).find((t) => t.id === created.id);
await writeState({
  phase: 'finished',
  id: created.id,
  version: view.version,
  acceptedTree: raw.acceptedTree,
  ok: result.ok,
  outcome: result.view?.saveOutcome?.kind ?? null,
  state: after.state,
  checked: after.saveRecord?.checked ?? null,
  mergeCommit: after.saveRecord?.mergeCommit ?? null,
  trialCommit: after.saveRecord?.trialCommit ?? null,
  trialChecks: after.saveRecord?.trialChecks?.length ?? 0,
});
process.exit(0);

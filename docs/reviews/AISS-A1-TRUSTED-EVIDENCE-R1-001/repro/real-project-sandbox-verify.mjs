/**
 * AISS-A1-TRUSTED-EVIDENCE-R1-001 — 标准模式受限沙箱内「完整真实项目」检查、保存与撤销验证。
 *
 * 与 A1 的宿主运行器验证不同：**不使用宿主运行器替代产品路径**。
 * 检查由产品自带的独立 Seatbelt 沙箱运行器（createStandaloneSandboxRunner）执行；
 * 项目是仓库内附带的一个自包含真实项目（真实 `npm run build`（tsc）+ 真实 `npm test`（Vitest 25 项），
 * 有 src/tests/tsconfig/vitest 配置与 git 历史），完整运行项目声明的全部检查脚本。
 *
 * 为什么不用本仓库自身做“沙箱内完整项目”：本仓库测试套件包含大量需要监听本地端口的用例，
 * 而标准模式的沙箱策略按设计断网（deny network*），这些用例必然 EPERM；产品会如实判为失败，
 * 属于沙箱策略而非检查链路问题。该限制在报告中登记为 OPEN。
 *
 * 用法（A1 工作树先 npm run build:core）：
 *   node docs/reviews/AISS-A1-TRUSTED-EVIDENCE-R1-001/repro/real-project-sandbox-verify.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.A1_WORKTREE ?? path.resolve(SELF, '..', '..', '..', '..');
const CORE = path.join(REPO, 'dist-electron', 'core');
const FIXTURE = path.join(SELF, 'real-project');
const { TaskController } = await import(path.join(CORE, 'app', 'task-controller.js'));
const { TaskPrefs } = await import(path.join(CORE, 'app', 'prefs.js'));
const { FakeExecutor } = await import(path.join(CORE, 'executor', 'adapters', 'fake.js'));
const { createStandaloneSandboxRunner } = await import(path.join(CORE, 'executor', 'sandbox', 'index.js'));
const { RecordStore } = await import(path.join(CORE, 'persistence', 'index.js'));

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r1-sandbox-'));
const proj = path.join(root, 'real-project');
execFileSync('rsync', ['-a', `${FIXTURE}/`, `${proj}/`], { stdio: 'inherit' });
execFileSync('git', ['-C', proj, 'init', '-q', '-b', 'main']);
execFileSync('git', ['-C', proj, 'config', 'user.name', 'r1-verify']);
execFileSync('git', ['-C', proj, 'config', 'user.email', 'r1@localhost']);
execFileSync('git', ['-C', proj, 'add', '-A']);
execFileSync('git', ['-C', proj, 'commit', '-qm', 'r1 real project base']);
await fs.symlink(path.join(REPO, 'node_modules'), path.join(proj, 'node_modules'), 'dir');
// 验证环境的 node_modules 是宿主软链（不是项目内容）：写仓库本地 exclude，避免被当成“未保存的修改”。
await fs.appendFile(path.join(proj, '.git', 'info', 'exclude'), '\nnode_modules\n');
const headBefore = execFileSync('git', ['-C', proj, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const treeBefore = execFileSync('git', ['-C', proj, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
console.log(JSON.stringify({ event: 'project-copied', proj, headBefore, treeBefore }));

const sb = await createStandaloneSandboxRunner();
console.log(JSON.stringify({ event: 'sandbox', status: sb.status }));
if (!sb.status.available || !sb.runner) throw new Error(`标准模式受限沙箱不可用：${sb.status.detail}`);

const data = path.join(root, 'data');
const controller = new TaskController({
  repo: proj,
  makeExecutor: () => {
    const ex = new FakeExecutor([
      { do: 'write', path: 'src/math.ts', content: 'export function add(a: number, b: number): number { return a + b; }\nexport function mul(a: number, b: number): number { return a * b; }\nexport function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }\nexport function sub(a: number, b: number): number { return a - b; }\n' },
      { do: 'write', path: 'NOTES.md', content: '# R1 标准沙箱验证\n\n完整项目检查与保存。\n' },
      { do: 'exit', code: 0 },
    ]);
    ex.sandboxRunner = sb.runner;
    return ex;
  },
  pickDirectory: async () => null,
  prefs: new TaskPrefs(data),
});
const created = await controller.create('R1 标准模式沙箱完整项目验证');
await controller.savePlan(created.id, { goal: 'R1 标准模式沙箱完整项目验证', criteria: ['构建与全部测试在受限沙箱内真实通过', '验证记录已写入'], mode: 'standard', network: false });
console.log(JSON.stringify({ event: 'planned', taskId: created.id }));

const until = async (fn, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
await controller.start(created.id, false);
const view = await until(async () => {
  const v = await controller.getAcceptanceView(created.id);
  return v.state === 'reviewing' && !v.busy ? v : false;
}, 20 * 60_000, '验收阶段（沙箱内完整 build+test）');
const raw = (await controller.listTasksRaw()).find((t) => t.id === created.id);
const build = raw.currentChecks.find((c) => c.name === 'build');
const test = raw.currentChecks.find((c) => c.name === 'test');
console.log(JSON.stringify({
  event: 'acceptance',
  buildStatus: build?.status,
  testStatus: test?.status,
  counts: test?.evidence?.report?.counts,
  executedFiles: test?.evidence?.report?.executedFiles,
  integrity: test?.evidence?.report?.integrity,
  crossCheck: test?.evidence?.report?.crossCheck,
  runEnv: test?.evidence?.run?.env,
  sandboxKind: test?.evidence?.run?.sandboxKind,
  scope: test?.evidence?.scope?.kind,
  items: view.items.filter((i) => i.key === 'build' || i.key === 'test').map((i) => [i.key, i.status]),
}));
if (test?.evidence?.run?.env !== 'sandbox') throw new Error('检查没有在受限沙箱环境运行（不得用宿主运行器替代产品路径）');
if (test?.evidence?.run?.sandboxKind !== 'seatbelt') throw new Error(`检查运行环境不是独立 Seatbelt 沙箱：${test?.evidence?.run?.sandboxKind}`);
if (build?.status !== 'passed' || test?.status !== 'passed') throw new Error('标准模式沙箱内完整项目检查未取得可信通过证据');
if (test?.evidence?.report?.counts?.total !== 25 || test?.evidence?.report?.counts?.passed !== 25) throw new Error(`结构化报告数量不符：${JSON.stringify(test?.evidence?.report?.counts)}`);
if (test?.evidence?.report?.executedFiles?.length !== 5) throw new Error(`实际执行文件数不符：${test?.evidence?.report?.executedFiles?.length}`);
if (test?.evidence?.scope?.kind !== 'assessed_unchanged') throw new Error(`范围评估异常：${test?.evidence?.scope?.kind} / ${test?.evidence?.scope?.reasons?.join('；')}`);
if (view.items.find((i) => i.key === 'test')?.status !== 'verified') throw new Error('验收卡测试项不是 verified');

for (const c of view.criteria) await controller.confirmCriterion(created.id, c.id, view.version);
const confirmed = await controller.getAcceptanceView(created.id);
const saved = await controller.saveTask(created.id, confirmed.version);
console.log(JSON.stringify({ event: 'save', ok: saved.ok, outcome: saved.view.saveOutcome?.kind, message: saved.message }));
if (!saved.ok) throw new Error(`标准模式沙箱保存失败：${saved.message}`);
const after = (await controller.listTasksRaw()).find((t) => t.id === created.id);
if (after.saveRecord?.checked !== true) throw new Error('保存记录没有 checked=true');
const headAfter = execFileSync('git', ['-C', proj, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const markerCommitted = execFileSync('git', ['-C', proj, 'show', '--name-only', '--pretty=format:', '-m', 'HEAD'], { encoding: 'utf8' }).includes('NOTES.md');
const subApplied = execFileSync('git', ['-C', proj, 'show', 'HEAD:src/math.ts'], { encoding: 'utf8' }).includes('export function sub');
console.log(JSON.stringify({ event: 'saved', state: after.state, mergeCommit: after.saveRecord?.mergeCommit, checksSummary: after.saveRecord?.checksSummary, evidenceIds: after.saveRecord?.evidenceIds, headAfter, markerCommitted, subApplied }));
if (!markerCommitted || !subApplied) throw new Error('保存后任务内容未完整应用');

const undone = await controller.undoSave(created.id);
console.log(JSON.stringify({ event: 'undo', ok: undone.ok, message: undone.message }));
if (!undone.ok) throw new Error(`撤销失败：${undone.message}`);
const treeUndone = execFileSync('git', ['-C', proj, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
if (treeUndone !== treeBefore) throw new Error(`撤销后文件树与保存前不一致：${treeUndone} != ${treeBefore}`);
const markerGone = !execFileSync('git', ['-C', proj, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }).includes('NOTES.md');
if (!markerGone) throw new Error('撤销后标记文件仍然存在');
console.log(JSON.stringify({ event: 'undone', treeUndone, treeBefore, markerGone }));
await RecordStore.closeAll().catch(() => undefined);
console.log(JSON.stringify({ event: 'done', root, result: 'A1_R1_STANDARD_SANDBOX_FULL_PROJECT_VERIFICATION_OK' }));

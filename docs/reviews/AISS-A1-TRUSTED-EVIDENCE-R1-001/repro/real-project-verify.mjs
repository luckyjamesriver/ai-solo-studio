/**
 * AISS-A1 真实项目工作树执行验证（宿主侧一次性验证脚本，不属于产品代码）。
 *
 * 做什么：
 * 1. 从当前 A1 工作树 clone 一份真实项目到临时目录（带 node_modules 软链，保证真实依赖）；
 * 2. 用 TaskController + 模拟执行体（只做一次真实文件改动）跑完整任务闭环；
 * 3. 验收阶段真实运行项目的 `npm run build` 与 `npm test`（677+ 真实测试），要求拿到可信结构化证据；
 * 4. 执行真实保存（试合并 + 合并且再次真实运行检查），要求 saveRecord.checked === true；
 * 5. 打印每一步的宿主事实（退出码、计数、证据 sha、Git 提交）供人工独立复核。
 *
 * 用法：node repro/real-project-verify.mjs（可用 A1_WORKTREE 指定 A1 工作树）
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const A1 = process.env.A1_WORKTREE ?? path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CORE = path.join(A1, 'dist-electron', 'core');
const { TaskController } = await import(path.join(CORE, 'app', 'task-controller.js'));
const { TaskPrefs } = await import(path.join(CORE, 'app', 'prefs.js'));
const { FakeExecutor } = await import(path.join(CORE, 'executor', 'adapters', 'fake.js'));
const { RecordStore } = await import(path.join(CORE, 'persistence', 'index.js'));
const G = await import(path.join(CORE, 'git', 'git.js'));

import { spawn } from 'node:child_process';

// 验证脚本使用宿主运行器（不是产品内的受限沙箱）。为了验证“真实项目在其正常环境下”的检查证据链，
// 这里把 TMPDIR 指向宿主临时目录（与 CI 相同）：产品内检查把 TMPDIR 放在工作树 .studio/tmp（B3 设计，
// 为满足沙箱只允许写工作树），这会让依赖“临时目录在仓库之外”的项目测试（例如本仓库 git.test.ts 的
// isRepo(tmpDir())）在真实项目自检时失败——该环境差异见报告 §12 OPEN，不用它掩盖任何证据语义。
const HOST_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'a1-verify-tmp-'));
function sandboxRunner() {
  return {
    kind: 'verification-host-runner',
    runCommand: (req) =>
      new Promise((resolve) => {
        const t0 = Date.now();
        let stdout = '';
        let stderr = '';
        const env = { ...req.env, TMPDIR: HOST_TMP };
        const child = spawn(req.argv[0], req.argv.slice(1), { cwd: req.cwd, env, shell: false });
        child.stdout.setEncoding('utf8').on('data', (c) => (stdout += c));
        child.stderr.setEncoding('utf8').on('data', (c) => (stderr += c));
        child.on('error', (e) => resolve({ status: 'unavailable', reason: e.message }));
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve({ status: 'ran', exitCode: null, stdout, stderr, timedOut: true, durationMs: Date.now() - t0 });
        }, req.timeoutMs);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ status: 'ran', exitCode: code, stdout, stderr, timedOut: false, durationMs: Date.now() - t0 });
        });
      }),
  };
}

async function until(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a1-real-project-'));
const clone = path.join(root, 'ai-solo-studio');
execFileSync('git', ['clone', '--quiet', '--no-hardlinks', A1, clone], { stdio: 'inherit' });
await fs.symlink(path.join(A1, 'node_modules'), path.join(clone, 'node_modules'), 'dir');
// 验证环境的 node_modules 是宿主软链（不是项目内容）：写入仓库本地 exclude，避免被当成“未保存的修改”；
// 不修改项目任何被跟踪文件。
await fs.appendFile(path.join(clone, '.git', 'info', 'exclude'), '\nnode_modules\n');
// clone 会带上 A1 工作树当前分支的提交；再把它切到干净的分支上避免影响 A1
execFileSync('git', ['-C', clone, 'checkout', '--quiet', '-b', 'verify-branch'], { stdio: 'inherit' });
const headBefore = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
console.log(JSON.stringify({ event: 'clone', clone, headBefore }));

const data = path.join(root, 'data');
const controller = new TaskController({
  repo: clone,
  makeExecutor: () => {
    const ex = new FakeExecutor([
      { do: 'write', path: 'docs/reports/2026-11-24-a1-real-project-verify.md', content: '# A1 真实项目工作树执行验证\n\n由验证脚本写入。\n' },
      { do: 'exit', code: 0 },
    ]);
    ex.sandboxRunner = sandboxRunner();
    return ex;
  },
  pickDirectory: async () => null,
  prefs: new TaskPrefs(data),
});

const created = await controller.create('A1 真实项目工作树验证');
await controller.savePlan(created.id, { goal: 'A1 真实项目工作树执行验证', criteria: ['新增一份验证记录文档'], mode: 'standard', network: false });
console.log(JSON.stringify({ event: 'planned', taskId: created.id }));

await controller.start(created.id, false);
const view = await until(async () => {
  const v = await controller.getAcceptanceView(created.id);
  return v.state === 'reviewing' && !v.busy ? v : false;
}, 15 * 60_000, '验收阶段');
const raw = (await controller.listTasksRaw()).find((t) => t.id === created.id);
const testProof = raw.currentChecks.find((c) => c.name === 'test');
const buildProof = raw.currentChecks.find((c) => c.name === 'build');
console.log(
  JSON.stringify({
    event: 'acceptance',
    state: raw.state,
    acceptedTree: raw.acceptedTree,
    acceptanceRev: raw.acceptanceRev,
    buildStatus: buildProof?.status,
    testStatus: testProof?.status,
    testCounts: testProof?.evidence?.report?.counts,
    reportSha256: testProof?.evidence?.report?.sha256,
    reportIntegrity: testProof?.evidence?.report?.integrity,
    runner: testProof?.evidence?.config?.runnerPackage,
    scope: testProof?.evidence?.scope?.kind,
    itemStatuses: view.items.filter((i) => i.key === 'build' || i.key === 'test').map((i) => [i.key, i.status]),
  }),
);
if (buildProof?.status !== 'passed') throw new Error('真实项目构建检查没有取得可信通过证据');
if (testProof?.status !== 'passed') throw new Error('真实项目自动测试没有取得可信通过证据');
if (!(testProof?.evidence?.report?.counts?.passed > 0)) throw new Error('结构化报告没有真实通过的测试数量');
if (view.items.find((i) => i.key === 'test')?.status !== 'verified') throw new Error('验收卡测试项不是 verified');

for (const c of view.criteria) {
  await controller.confirmCriterion(created.id, c.id, view.version);
}
const confirmed = await controller.getAcceptanceView(created.id);
console.log(JSON.stringify({ event: 'confirmed', version: confirmed.version }));
const saved = await controller.saveTask(created.id, confirmed.version);
console.log(JSON.stringify({ event: 'save', ok: saved.ok, outcome: saved.view.saveOutcome?.kind, message: saved.message }));
if (!saved.ok) throw new Error(`真实项目保存失败：${saved.message}`);
const after = (await controller.listTasksRaw()).find((t) => t.id === created.id);
if (after.saveRecord?.checked !== true) throw new Error('保存记录没有标记 checked=true');
console.log(
  JSON.stringify({
    event: 'saved',
    state: after.state,
    mergeCommit: after.saveRecord?.mergeCommit,
    taskCommit: after.saveRecord?.taskCommit,
    checked: after.saveRecord?.checked,
    checksSummary: after.saveRecord?.checksSummary,
    headAfter: execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    markerCommitted: execFileSync('git', ['-C', clone, 'show', '--name-only', '--pretty=format:', 'HEAD'], { encoding: 'utf8' }).includes('2026-11-24-a1-real-project-verify.md'),
  }),
);
await RecordStore.closeAll().catch(() => undefined);
console.log(JSON.stringify({ event: 'done', root, result: 'A1_REAL_PROJECT_WORKTREE_VERIFICATION_OK' }));

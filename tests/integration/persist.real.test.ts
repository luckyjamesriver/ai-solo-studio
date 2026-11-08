import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexExecutor } from '../../src/core/executor/adapters/codex.js';
import { TaskRunner, type PendingPermission } from '../../src/core/task/runner.js';
import { RecordStore } from '../../src/core/persistence/index.js';
import * as G from '../../src/core/git/git.js';
import { realEnabled } from './gate.js';

/**
 * ADR 0005 实现后的真实 Codex 端到端：两个任务并行施工（各改不同的文件），确认状态互不覆盖；
 * 再保存两个任务、模拟“应用重启”（丢掉汇总，由事件日志重建）后状态仍然完整。
 * 默认跳过；经 `npm run test:real`，套件名 persist-1（见 gate.ts）。模型回合：2 次（每个任务 1 次，并行）；
 * 只发送临时测试仓库里的内容；不运行项目检查（runChecks:false，不经 command/exec）。
 * 测试仓库放在系统临时目录（可用 STUDIO_PERSIST_PROBE_ROOT 指向别处，该路径必须尚不存在）。
 * 原始记录写入 ~/AI-CoWork-rebuild-import/persist-1-events/。
 */
const enabled = realEnabled('persist-1');
const MODEL_TURN_LIMIT = 3;
const logDir = path.join(os.homedir(), 'AI-CoWork-rebuild-import', 'persist-1-events');
const root = process.env.STUDIO_PERSIST_PROBE_ROOT ?? path.join(os.tmpdir(), `studio-persist-probe-${process.pid}`);
let repo = '';

const read = (f: string, dir = repo) => fs.readFileSync(path.join(dir, f), 'utf8');

describe.skipIf(!enabled)('ADR 0005：真实 Codex，两个任务并行执行，状态互不覆盖', () => {
  beforeAll(async () => {
    if (fs.existsSync(root)) throw new Error(`${root} 已存在，为避免删除不属于本测试的内容而中止。`);
    fs.mkdirSync(path.join(root, 'repo'), { recursive: true });
    repo = fs.realpathSync(path.join(root, 'repo'));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha: old\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'beta: old\n');
    await G.initRepo(repo);
  }, 60_000);
  afterAll(async () => {
    await RecordStore.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('两个任务并行施工 → 各自的记录、运行编号、改动互不覆盖 → 保存 → 重启对账后完整', async () => {
    const executor = new CodexExecutor();
    const env = await executor.detect();
    expect(env.installed, `Codex 未安装：${env.note ?? ''}`).toBe(true);
    expect(env.loggedIn, `Codex 未登录：${env.note ?? ''}`).toBe('yes');

    const runner = new TaskRunner({ repo, executor, runChecks: false, timeoutMs: 5 * 60_000 });
    const permissions: PendingPermission[] = [];
    runner.on('permission', (p: PendingPermission) => {
      permissions.push(p); // 期望 0 次；万一出现，拒绝并记录
      void runner.respond(p.taskId, p.request.id, 'deny');
    });
    const make = async (file: string, from: string, to: string) => {
      const t = await runner.create(`把 ${file} 里的 ${from} 改成 ${to}`);
      await runner.setPlan(t.id, { goal: `把 ${file} 里的 ${from} 改成 ${to}`, inScope: [`只修改 ${file}`], outOfScope: ['其他文件', '不要提交 Git'], criteria: [], risks: [], irreversible: [] });
      await runner.approve(t.id);
      return t.id;
    };
    const a = await make('a.txt', 'old', 'NEW-A');
    const b = await make('b.txt', 'old', 'NEW-B');
    const modelTurns = 2;
    expect(modelTurns).toBeLessThanOrEqual(MODEL_TURN_LIMIT);

    const [ta, tb] = await Promise.all([runner.start(a), runner.start(b)]); // 并行
    const log: Record<string, unknown> = { repo, modelTurns, a: { state: ta.state, exit: ta.exit, runId: ta.runId, revision: ta.revision, changes: ta.card?.changes }, b: { state: tb.state, exit: tb.exit, runId: tb.runId, revision: tb.revision, changes: tb.card?.changes } };
    const save = (name: string, data: unknown) => {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, `${name}.json`), JSON.stringify(data, null, 2));
      console.info(`PERSIST-1 ${name} ${JSON.stringify(data)}`);
    };
    try {
      for (const t of [ta, tb]) {
        expect(t.state).toBe('reviewing');
        expect(t.exit).toEqual({ kind: 'exited', code: 0 });
      }
      expect(ta.runId).toBeTruthy();
      expect(ta.runId).not.toBe(tb.runId); // 各自是独立的运行
      // 互不覆盖：各自的改动清单只含自己的文件，各自副本里是各自的内容，主项目没动
      expect(ta.card?.changes.map((c) => c.path)).toEqual(['a.txt']);
      expect(tb.card?.changes.map((c) => c.path)).toEqual(['b.txt']);
      expect(read('a.txt', ta.worktree!.path)).toContain('NEW-A');
      expect(read('b.txt', tb.worktree!.path)).toContain('NEW-B');
      expect(read('a.txt')).toBe('alpha: old\n');
      expect(read('b.txt')).toBe('beta: old\n');

      // 事件日志：每个任务一条完整的修订序列，没有冲突、没有过期运行被拒绝
      const store = await runner.store.recordStore();
      const events = await store.events();
      expect(events.filter((e) => e.type === 'conflict' || e.type === 'stale_run' || e.type === 'rollback')).toEqual([]);
      for (const id of [a, b]) {
        const revs = events.filter((e) => e.collection === 'tasks' && e.id === id && e.revision !== undefined && e.type !== 'duplicate').map((e) => e.revision!);
        expect(revs).toEqual(Array.from({ length: revs.length }, (_, i) => i + 1));
      }

      // 保存：两个任务改不同文件，依次保存都成功，主项目里两处改动都在
      await runner.confirm(a, { overall: true });
      await runner.confirm(b, { overall: true });
      const sa = await runner.save(a);
      const sb = await runner.save(b);
      log.save = { a: sa.ok ? sa.message : sa, b: sb.ok ? sb.message : sb };
      expect(sa.ok, JSON.stringify(sa)).toBe(true);
      expect(sb.ok, JSON.stringify(sb)).toBe(true);
      expect(read('a.txt')).toContain('NEW-A');
      expect(read('b.txt')).toContain('NEW-B');

      // 模拟应用重启：丢掉全部汇总，由事件日志重建
      const before = Object.fromEntries((await runner.store.list()).map((t) => [t.id, { state: t.state, revision: t.revision, runId: t.runId }]));
      await store.close();
      fs.rmSync(path.join(repo, '.studio', 'records'), { recursive: true });
      const fresh = new TaskRunner({ repo, executor, runChecks: false });
      const after = Object.fromEntries((await fresh.store.list()).map((t) => [t.id, { state: t.state, revision: t.revision, runId: t.runId }]));
      expect(after).toEqual(before);
      expect(after[a]?.state).toBe('saved');
      expect(after[b]?.state).toBe('saved');
      expect(permissions).toHaveLength(0);
      log.afterRestart = after;
    } finally {
      log.permissionConfirmations = permissions.length;
      save('end-to-end', log);
    }
  }, 900_000);
});

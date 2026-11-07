import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exportTask, importReport, reviewImportedReport, saveImportRecord, type TaskManifest } from '../src/core/thinking/handoff/index.js';
import { FakeThinker } from '../src/core/thinking/index.js';
import { FlowEngine } from '../src/core/thinking/flow/index.js';
import { git, tmpDir } from './helpers.js';
import { engineFor, makeProject, makeUI, scripted } from './flow-helpers.js';

const plan = { path: 'docs/plans/2026-11-08-T-test.md', text: '## 方案\n加主题开关', sha256: 'a'.repeat(64), artifactVersion: 1 };
const reqs = [{ id: 'R1', text: '加深色模式' }];

async function setup(opts: { single?: boolean } = {}) {
  const root = await makeProject();
  const exportDir = await tmpDir('studio-export-');
  const base = { projectRoot: root, taskId: 'M9-X1', threadId: 'T-test', exportDir, plan, requirements: reqs, single: !!opts.single };
  return { root, exportDir, base };
}
const read = (p: string) => fs.readFile(p, 'utf8');
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

describe('导出', () => {
  it('默认导出为 <任务编号>-task.md：首行任务编号、符合协议要素；生成任务清单；不动 next-task.md', async () => {
    const { root, exportDir, base } = await setup();
    await fs.writeFile(path.join(exportDir, 'next-task.md'), '任务编号：OLD-1\n旧任务\n');
    const r = await exportTask(base);
    expect(r.taskFile).toBe(path.join(exportDir, 'M9-X1-task.md'));
    const text = await read(r.taskFile);
    expect(text.split('\n')[0]).toBe('任务编号：M9-X1');
    for (const k of ['docs/PROTOCOL.md', '## 1. 目标', '## 3. 约束', '## 4. 验证要求', '## 5. 报告要求', '开始 HEAD：', '结束 HEAD：', 'R1：加深色模式', '本方案经规划者起草']) expect(text).toContain(k);
    expect(text).not.toContain('未经独立评审');
    expect(await read(path.join(exportDir, 'next-task.md'))).toBe('任务编号：OLD-1\n旧任务\n');
    expect(r.currentUpdated).toBe(false);
    const m = JSON.parse(await read(r.manifestFile)) as TaskManifest;
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    expect(m).toMatchObject({ taskId: 'M9-X1', threadId: 'T-test', startHead: head, branch: 'main', plan: { path: plan.path, sha256: plan.sha256, artifactVersion: 1 }, singleThinker: false });
    expect(m.repoRoot).toBe(await fs.realpath(root));
    expect(m.worktreePath).toBe(await fs.realpath(root));
    expect(m.taskFile.path).toBe(r.taskFile);
    expect(m.exportedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(r.manifestFile).toBe(path.join(root, '.studio', 'tasks', 'M9-X1.json'));
    // 原子写入：没有残留临时文件
    expect((await fs.readdir(exportDir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await fs.readdir(path.join(root, '.studio', 'tasks'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('单思考者时任务文件标注“未经独立评审”', async () => {
    const { base } = await setup({ single: true });
    const r = await exportTask(base);
    expect(await read(r.taskFile)).toContain('未经独立评审');
    expect(r.manifest.singleThinker).toBe(true);
  });

  it('已存在任务清单或同名任务文件 → 拒绝覆盖，且不写入任何东西', async () => {
    const { root, exportDir, base } = await setup();
    await exportTask(base);
    const before = await read(path.join(exportDir, 'M9-X1-task.md'));
    await expect(exportTask(base)).rejects.toThrow(/已存在，拒绝覆盖/);
    expect(await read(path.join(exportDir, 'M9-X1-task.md'))).toBe(before);
    // 仅任务清单存在
    const { root: r2, exportDir: d2, base: b2 } = await setup();
    await fs.mkdir(path.join(r2, '.studio', 'tasks'), { recursive: true });
    await fs.writeFile(path.join(r2, '.studio', 'tasks', 'M9-X1.json'), '{}');
    await expect(exportTask(b2)).rejects.toThrow(/任务清单已存在/);
    expect(await exists(path.join(d2, 'M9-X1-task.md'))).toBe(false);
    // 仅同名任务文件存在
    const { exportDir: d3, base: b3, root: r3 } = await setup();
    await fs.writeFile(path.join(d3, 'M9-X1-task.md'), 'x');
    await expect(exportTask(b3)).rejects.toThrow(/任务文件已存在/);
    expect(await exists(path.join(r3, '.studio', 'tasks', 'M9-X1.json'))).toBe(false);
    void root;
  });

  it('必须给导出目录；任务编号必须合法', async () => {
    const { base } = await setup();
    await expect(exportTask({ ...base, exportDir: '' })).rejects.toThrow(/导出目录/);
    await expect(exportTask({ ...base, taskId: '../evil' })).rejects.toThrow(/不合法/);
  });

  it('--set-current：next-task.md 已存在 → 显示首行并要求确认；确认后旧文件另存为 <旧编号>-task.md', async () => {
    const { exportDir, base } = await setup();
    await fs.writeFile(path.join(exportDir, 'next-task.md'), '任务编号：OLD-1\n旧任务\n');
    const seen: string[] = [];
    const r = await exportTask({ ...base, setCurrent: true, confirmReplaceCurrent: async (l) => (seen.push(l), true) });
    expect(seen).toEqual(['任务编号：OLD-1']);
    expect(r.currentUpdated).toBe(true);
    expect((await read(path.join(exportDir, 'next-task.md'))).split('\n')[0]).toBe('任务编号：M9-X1');
    expect(await read(path.join(exportDir, 'OLD-1-task.md'))).toBe('任务编号：OLD-1\n旧任务\n');
    expect((await fs.readdir(exportDir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('--set-current：没有旧 next-task.md 时直接写入；未确认时保持原样', async () => {
    const { exportDir, base } = await setup();
    const r = await exportTask({ ...base, setCurrent: true });
    expect(r.currentUpdated).toBe(true);
    expect((await read(path.join(exportDir, 'next-task.md'))).split('\n')[0]).toBe('任务编号：M9-X1');
    const { exportDir: d2, base: b2 } = await setup();
    await fs.writeFile(path.join(d2, 'next-task.md'), '任务编号：OLD-2\n');
    const r2 = await exportTask({ ...b2, setCurrent: true, confirmReplaceCurrent: async () => false });
    expect(r2.currentUpdated).toBe(false);
    expect(r2.currentNote).toContain('OLD-2');
    expect(await read(path.join(d2, 'next-task.md'))).toBe('任务编号：OLD-2\n');
    const { exportDir: d3, base: b3 } = await setup();
    await fs.writeFile(path.join(d3, 'next-task.md'), '任务编号：OLD-3\n');
    const r3 = await exportTask({ ...b3, setCurrent: true }); // 没有确认回调 = 无法确认
    expect(r3.currentUpdated).toBe(false);
    expect(await read(path.join(d3, 'next-task.md'))).toBe('任务编号：OLD-3\n');
  });

  it('--set-current：旧文件另存的目标已存在 → 不覆盖并提示，next-task.md 保持原样', async () => {
    const { exportDir, base } = await setup();
    await fs.writeFile(path.join(exportDir, 'next-task.md'), '任务编号：OLD-1\n旧\n');
    await fs.writeFile(path.join(exportDir, 'OLD-1-task.md'), '另一个旧文件');
    const r = await exportTask({ ...base, setCurrent: true, confirmReplaceCurrent: async () => true });
    expect(r.currentUpdated).toBe(false);
    expect(r.currentNote).toContain('OLD-1-task.md');
    expect(await read(path.join(exportDir, 'OLD-1-task.md'))).toBe('另一个旧文件');
    expect(await read(path.join(exportDir, 'next-task.md'))).toBe('任务编号：OLD-1\n旧\n');
    // 旧编号与新编号相同：同样不覆盖
    const { exportDir: d2, base: b2 } = await setup();
    await fs.writeFile(path.join(d2, 'next-task.md'), '任务编号：M9-X1\n同号旧文件\n');
    const r2 = await exportTask({ ...b2, setCurrent: true, confirmReplaceCurrent: async () => true });
    expect(r2.currentUpdated).toBe(false);
    expect(await read(path.join(d2, 'next-task.md'))).toBe('任务编号：M9-X1\n同号旧文件\n');
  });

  it('线程：approved 之后导出，状态推进到 task_exported（引擎保存方案并拒绝在其他状态导出）', async () => {
    const root = await makeProject();
    const e = await engineFor(root, { planner: scripted() });
    await e.create('x');
    await expect(e.markExported({ taskId: 'a', taskFile: 'f', manifest: 'm' })).rejects.toThrow(/approved/);
    const out = await e.run();
    expect(out.kind).toBe('approved');
    const info = await e.planInfo();
    const dir = await tmpDir('studio-export-');
    const ex = await exportTask({ projectRoot: root, taskId: 'M9-E', threadId: e.thread.id, exportDir: dir, plan: { path: info.planPath, text: info.plan, sha256: info.sha256, artifactVersion: info.artifactVersion }, requirements: info.req.items, single: false });
    await e.markExported({ taskId: 'M9-E', taskFile: ex.taskFile, manifest: ex.manifestFile });
    expect(e.thread.state).toBe('task_exported');
    expect(await e.run()).toMatchObject({ kind: 'exported' });
    void FlowEngine;
  });
});

/** 导出一个任务，并返回写报告的辅助 */
async function exported() {
  const { root, exportDir, base } = await setup();
  const r = await exportTask(base);
  const startHead = r.manifest.startHead;
  const reportFile = path.join(exportDir, 'report.md');
  const report = (o: { taskNo?: string; repo?: string; branch?: string; worktree?: string; start?: string | null; end?: string | null; omit?: string[] } = {}) => {
    const lines = [`任务编号：${o.taskNo ?? 'M9-X1'}`, '', '# 报告', '', '## 绑定信息'];
    const add = (label: string, v: string | null | undefined) => v !== null && v !== undefined && lines.push(`${label}：${v}`);
    add('仓库', o.repo ?? r.manifest.repoRoot);
    add('分支', o.branch ?? 'main');
    add('工作树路径', o.worktree ?? r.manifest.worktreePath);
    add('开始 HEAD', o.start === undefined ? startHead : o.start);
    add('结束 HEAD', o.end === undefined ? startHead : o.end);
    return lines.filter((l) => !(o.omit ?? []).some((k) => l.startsWith(k))).join('\n') + '\n\n测试：10 passed\n';
  };
  const write = async (o?: Parameters<typeof report>[0]) => {
    await fs.writeFile(reportFile, report(o));
    return importReport({ projectRoot: root, reportPath: reportFile, taskId: 'M9-X1' });
  };
  const commit = async (name = 'f.txt') => {
    await fs.writeFile(path.join(root, name), name);
    await git(root, ['add', name]);
    await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', name]);
    return (await git(root, ['rev-parse', 'HEAD'])).trim();
  };
  return { root, exportDir, manifest: r.manifest, reportFile, write, commit, startHead };
}

describe('导入：三档结果', () => {
  it('已绑定：编号、仓库、分支、工作树、开始 HEAD 一致，结束 HEAD 是后代；可进入审查', async () => {
    const x = await exported();
    const end = await x.commit();
    const r = await x.write({ end });
    expect(r.verdict).toBe('bound');
    expect(r.canReview).toBe(true);
    expect(r.mismatches).toEqual([]);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.notes.join()).toContain('只证明版本关系');
    expect(r.readOnlyNotice).toBeUndefined();
    // 简写的 HEAD 也能解析为同一提交
    const r2 = await x.write({ start: x.startHead.slice(0, 10), end: end.slice(0, 10) });
    expect(r2.verdict).toBe('bound');
  });

  it('结束 HEAD 与开始 HEAD 相同：仍是已绑定，但注明没有新提交', async () => {
    const x = await exported();
    const r = await x.write();
    expect(r.verdict).toBe('bound');
    expect(r.notes.join()).toContain('没有新提交');
  });

  it.each([
    ['任务编号不符', { taskNo: 'M9-OTHER' }, '首行任务编号'],
    ['分支不符', { branch: 'feature/x' }, '分支'],
    ['仓库不符', { repo: '/definitely/not/this/repo' }, '仓库'],
    ['工作树不符', { worktree: '/definitely/not/this/worktree' }, '工作树路径'],
    ['开始 HEAD 不符', { start: 'deadbeefdeadbeef' }, '开始 HEAD'],
    ['结束 HEAD 不存在', { end: 'cafebabecafebabe' }, '结束 HEAD'],
  ] as const)('%s → 不符，列出矛盾项，不能审查', async (_n, over, item) => {
    const x = await exported();
    const r = await x.write(over as never);
    expect(r.verdict).toBe('mismatch');
    expect(r.mismatches.some((m) => m.startsWith(item))).toBe(true);
    expect(r.canReview).toBe(false);
    expect(r.readOnlyNotice).toContain('只读查看');
  });

  it('开始 HEAD 是仓库里另一个真实提交但与清单不符 → 不符', async () => {
    const x = await exported();
    const other = await x.commit();
    const r = await x.write({ start: other, end: other });
    expect(r.verdict).toBe('mismatch');
    expect(r.mismatches.join()).toContain('开始 HEAD');
  });

  it('结束 HEAD 存在但不是清单开始 HEAD 的后代 → 不符', async () => {
    const x = await exported();
    const later = await x.commit('later.txt');
    // 清单开始 HEAD 是更早的提交；构造“祖先而非后代”：用一个孤立提交
    await git(x.root, ['checkout', '-q', '--orphan', 'island']);
    await git(x.root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'island', '--allow-empty']);
    const island = (await git(x.root, ['rev-parse', 'HEAD'])).trim();
    await git(x.root, ['checkout', '-q', 'main']);
    const r = await x.write({ end: island });
    expect(r.verdict).toBe('mismatch');
    expect(r.mismatches.join()).toContain('不是清单开始 HEAD');
    void later;
  });

  it('工作树有未提交与未跟踪改动：如实列出（不改变档位）', async () => {
    const x = await exported();
    await fs.writeFile(path.join(x.root, 'docs', 'ref.md'), '# 改了\n');
    await fs.writeFile(path.join(x.root, 'new.txt'), 'n');
    const r = await x.write();
    expect(r.verdict).toBe('bound');
    expect(r.worktree.dirty).toEqual(['docs/ref.md']);
    expect(r.worktree.untracked).toEqual(['new.txt']);
    expect(r.notes.join()).toContain('1 个未提交改动、1 个未跟踪文件');
  });

  it.each([
    ['缺少所有绑定信息', { repo: null, branch: null, worktree: null, start: null, end: null }],
    ['只缺结束 HEAD', { end: null }],
    ['只缺开始 HEAD', { start: null }],
  ] as const)('%s → 来源未核实：只读查看，不能审查', async (_n, over) => {
    const x = await exported();
    const r = await x.write(over as never);
    expect(r.verdict).toBe('unverified');
    expect(r.unverifiedReasons.join()).toContain('绑定信息');
    expect(r.canReview).toBe(false);
    expect(r.readOnlyNotice).toContain('来源未核实');
  });

  it('报告首行没有任务编号 / 找不到任务清单 → 来源未核实', async () => {
    const x = await exported();
    await fs.writeFile(x.reportFile, '# 没有编号的报告\n随便写了几句\n');
    expect((await importReport({ projectRoot: x.root, reportPath: x.reportFile, taskId: 'M9-X1' })).verdict).toBe('unverified');
    const r = await importReport({ projectRoot: x.root, reportPath: x.reportFile, taskId: 'NO-SUCH' });
    expect(r.verdict).toBe('unverified');
    expect(r.unverifiedReasons.join()).toContain('找不到任务 NO-SUCH 的任务清单');
  });

  it('矛盾优先于缺失：同时有矛盾项与缺失项 → 不符', async () => {
    const x = await exported();
    expect((await x.write({ branch: 'other', end: null })).verdict).toBe('mismatch');
  });

  it('导入记录写入 .studio/tasks/，明确标注档位', async () => {
    const x = await exported();
    const r = await x.write({ end: null });
    const f = await saveImportRecord(x.root, r);
    expect(JSON.parse(await read(f))).toMatchObject({ verdict: 'unverified', canReview: false, taskId: 'M9-X1' });
    expect(f).toContain(path.join('.studio', 'tasks'));
  });
});

describe('导入后的规划者审查', () => {
  const ok = JSON.stringify({ summary: '基本完成', concerns: ['没有 smoke 证据'], evidence_gaps: ['缺少构建输出'], recommendation: '需要补充' });

  it('只有“已绑定”可审查；审查结果只是意见，交用户', async () => {
    const x = await exported();
    const imported = await x.write();
    const fake = new FakeThinker([{ raw: ok }]);
    const r = await reviewImportedReport({ planner: fake, imported, reportText: await read(x.reportFile), manifest: x.manifest, planText: '方案', requiredContext: [{ name: 'ctx', text: 'c' }] });
    expect(r.review).toMatchObject({ recommendation: '需要补充' });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.system).toMatch(/不宣布验收通过/);
    expect(JSON.stringify(fake.requests[0]!.context)).toContain('测试：10 passed');
  });

  it('“不符”与“来源未核实”被拒绝：思考者一次都没被调用', async () => {
    const x = await exported();
    for (const over of [{ branch: 'zzz' }, { end: null }] as const) {
      const imported = await x.write(over as never);
      const fake = new FakeThinker([{ raw: ok }]);
      await expect(reviewImportedReport({ planner: fake, imported, reportText: '', manifest: x.manifest, planText: '', requiredContext: [] })).rejects.toThrow(/不能进入规划者审查/);
      expect(fake.requests).toHaveLength(0);
    }
  });

  it('审查失败（非 complete）时没有 review 结果', async () => {
    const x = await exported();
    const imported = await x.write();
    const r = await reviewImportedReport({ planner: new FakeThinker([{ status: 'rate_limited' }]), imported, reportText: 'r', manifest: x.manifest, planText: 'p', requiredContext: [] });
    expect(r.review).toBeUndefined();
    expect(r.result.status).toBe('rate_limited');
  });
});

void makeUI;

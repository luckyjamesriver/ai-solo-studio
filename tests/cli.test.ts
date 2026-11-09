import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EXIT, parseArgs, resolveThinkers, runCli, ThinkerSelectionError, type CliEnv, type ThinkerRegistry } from '../src/core/thinking/cli/index.js';
import { ConsentStore } from '../src/core/thinking/flow/index.js';
import { FakeThinker } from '../src/core/thinking/index.js';
import { git, tmpDir } from './helpers.js';
import { makeProject, scripted } from './flow-helpers.js';

const registry = (over: Partial<Record<string, () => FakeThinker>> = {}): ThinkerRegistry => ({
  'claude-cli-personal': () => scripted({}, {}, { id: 'claude-cli-personal', service: 'svc-claude' }),
  codex: () => scripted({}, {}, { id: 'codex', service: 'svc-codex' }),
  ...over,
});

function makeIO(answer: (prompt: string) => string = () => '') {
  const out: string[] = [];
  const prompts: string[] = [];
  return { out, prompts, io: { print: (t: string) => void out.push(t), ask: async (p: string) => (prompts.push(p), answer(p)) }, text: () => out.join('\n') };
}
const okAnswers = (p: string) => (/首次向该服务/.test(p) ? 'y' : p.startsWith('> ') ? '' : /y = 批准/.test(p) ? 'y' : '');

describe('参数解析', () => {
  it('需求文字、--resume、--import 三选一；未知选项报错', () => {
    expect(parseArgs(['做个深色模式', '--task', 'M1', '--export-dir', '/x', '--single'])).toMatchObject({ requirement: '做个深色模式', task: 'M1', exportDir: '/x', single: true });
    expect(parseArgs(['--resume', 'T-1'])).toMatchObject({ resume: 'T-1' });
    expect(parseArgs(['--import', 'r.md', '--task', 'M1'])).toMatchObject({ importReport: 'r.md', task: 'M1' });
    expect(parseArgs(['x', '--context', 'a.md', '--context', 'b.md', '--max-calls', '5', '--max-cost', '1.5'])).toMatchObject({ context: ['a.md', 'b.md'], maxCalls: 5, maxCostUsd: 1.5 });
    expect(() => parseArgs([])).toThrow(/只请提供一种操作/);
    expect(() => parseArgs(['x', '--resume', 'T'])).toThrow(/只请提供一种操作/);
    expect(() => parseArgs(['x', '--nope'])).toThrow(/不认识的选项/);
    expect(() => parseArgs(['--import', 'r.md'])).toThrow(/--task/);
    expect(() => parseArgs(['x', '--single', '--reviewer', 'codex'])).toThrow(/不能同时/);
    expect(() => parseArgs(['x', '--max-calls', '0'])).toThrow(/正数/);
    expect(() => parseArgs(['x', '--planner'])).toThrow(/需要一个值/);
  });
});

describe('预设与思考者选择', () => {
  it('默认预设 dev-personal = ClaudeCli 规划 + Codex 评审，标注为开发者自用预设', async () => {
    const r = await resolveThinkers(registry(), { single: false });
    expect(r.planner.id).toBe('claude-cli-personal');
    expect(r.reviewer?.id).toBe('codex');
    expect(r.label).toContain('开发者自用预设');
    expect(r.label).toContain('不是产品默认');
  });

  it('预设不可用 → 报错说明并列出可用思考者；绝不自动改用其他规划者', async () => {
    const reg = registry({ 'claude-cli-personal': () => new FakeThinker([], { available: false, note: '未开启：需要 STUDIO_DEV_PERSONAL_CLAUDE=1' }, { id: 'claude-cli-personal', service: 's' }) });
    const err = await resolveThinkers(reg, { single: false }).catch((e) => e);
    expect(err).toBeInstanceOf(ThinkerSelectionError);
    expect(err.message).toContain('规划者 claude-cli-personal 不可用');
    expect(err.message).toContain('不会自动改用其他规划者');
    expect(err.message).toContain('codex：可用');
    expect(err.message).toContain('claude-cli-personal：不可用');
    // 单思考者同样不自动换
    await expect(resolveThinkers(reg, { single: true })).rejects.toThrow(/不会自动改用/);
  });

  it('指定 --planner 却不给 --reviewer（也不 --single）→ 报错，不自动补评审者；未知 id 报错', async () => {
    await expect(resolveThinkers(registry(), { planner: 'codex', single: false })).rejects.toThrow(/必须同时指定 --reviewer/);
    await expect(resolveThinkers(registry(), { reviewer: 'codex', single: false })).rejects.toThrow(/必须同时指定 --planner/);
    await expect(resolveThinkers(registry(), { planner: 'nope', reviewer: 'codex', single: false })).rejects.toThrow(/没有名为 nope/);
    const r = await resolveThinkers(registry(), { planner: 'codex', reviewer: 'claude-cli-personal', single: false });
    expect([r.planner.id, r.reviewer?.id]).toEqual(['codex', 'claude-cli-personal']);
  });
});

describe('入口（runCli）', () => {
  it('无 TTY：停在第一个确认点并保存线程，不默认通过；不修改 .gitignore', async () => {
    const root = await makeProject();
    await fs.rm(path.join(root, '.gitignore'));
    const exportDir = await tmpDir('studio-export-');
    const { io, text } = makeIO();
    const code = await runCli(['做个深色模式', '--task', 'M1', '--export-dir', exportDir], { cwd: root, isTTY: false, io, registry: registry() });
    expect(code).toBe(EXIT.waiting);
    expect(text()).toContain('没有交互终端');
    expect(text()).toContain('停在确认点');
    expect(text()).toContain('.gitignore 中没有 .studio/');
    await expect(fs.access(path.join(root, '.gitignore'))).rejects.toThrow(); // 没有被自动创建
    const threads = await fs.readdir(path.join(root, '.studio', 'threads'));
    expect(threads).toHaveLength(1);
    expect((await fs.readdir(exportDir)).length).toBe(0);
    // 资料外发确认没有被默认通过
    expect(await new ConsentStore(root).has('svc-claude')).toBe(false);
  });

  it('无 TTY 且已确认过服务：停在需求条目确认点（需求未确认不起草）', async () => {
    const root = await makeProject();
    await fs.mkdir(path.join(root, '.studio'), { recursive: true });
    await fs.writeFile(path.join(root, '.studio', 'consent.json'), JSON.stringify({ 'svc-claude': { confirmedAt: 'x' }, 'svc-codex': { confirmedAt: 'x' } }));
    const exportDir = await tmpDir('studio-export-');
    const { io, text } = makeIO();
    const code = await runCli(['x', '--task', 'M1', '--export-dir', exportDir], { cwd: root, isTTY: false, io, registry: registry() });
    expect(code).toBe(EXIT.waiting);
    expect(text()).toContain('需求条目需要你确认');
  });

  it('TTY 全流程：确认外发 → 条目回车接受 → 评审 → 批准 → 导出任务文件；默认不更新 next-task.md', async () => {
    const root = await makeProject();
    const exportDir = await tmpDir('studio-export-');
    await fs.writeFile(path.join(exportDir, 'next-task.md'), '任务编号：OLD\n');
    const m = makeIO(okAnswers);
    const code = await runCli(['做个深色模式', '--task', 'M7-A', '--export-dir', exportDir], { cwd: root, isTTY: true, io: m.io, registry: registry() });
    expect(code, m.text()).toBe(EXIT.ok);
    expect(m.text()).toContain('预设 dev-personal：开发者自用预设');
    expect(m.text()).toContain('单次调用的费用无法事前封顶');
    expect(m.text()).toContain('资料将离开本机，发往：svc-claude');
    expect(m.text()).toContain('资料将离开本机，发往：svc-codex');
    expect((await fs.readFile(path.join(exportDir, 'M7-A-task.md'), 'utf8')).split('\n')[0]).toBe('任务编号：M7-A');
    expect(await fs.readFile(path.join(exportDir, 'next-task.md'), 'utf8')).toBe('任务编号：OLD\n');
    expect(m.text()).toContain('不会自动开始执行');
    const plans = await fs.readdir(path.join(root, 'docs', 'plans'));
    expect(plans).toHaveLength(1);
    // 不自动提交：方案文件是未跟踪文件
    expect((await git(root, ['status', '--porcelain'])).trim()).toContain('docs/plans/');
    const consent = (await new ConsentStore(root).get())!.value;
    expect(Object.keys(consent).sort()).toEqual(['svc-claude', 'svc-codex']);
  });

  it('TTY：需求条目可在确认点增删改', async () => {
    const root = await makeProject();
    const exportDir = await tmpDir('studio-export-');
    let step = 0;
    const answers = ['y', 'd R2', 'a 支持系统主题', 'ok'];
    const planner = () => scripted(
      { draft: { plan: 'p', coverage: [{ id: 'R1', how: 'h' }, { id: 'R3', how: 'h' }] }, revise: { plan: 'p2', resolutions: [{ index: 1, result: '已解决', reason: 'r' }], item_marks: [{ id: 'R1', mark: '保留' }, { id: 'R3', mark: '保留' }], additions: [] } },
      {}, { id: 'claude-cli-personal', service: 'svc-claude' });
    const reviewer = () => scripted({ review: { requirement_checks: [{ id: 'R1', covered: true, note: '' }, { id: 'R3', covered: true, note: '' }], findings: [{ problem: 'p', severity: '建议', basis: '', impact: 'i', suggestion: 's', resolution: '' }], missing_evidence: [] } }, {}, { id: 'codex', service: 'svc-codex' });
    const m = makeIO((p) => {
      if (/首次向该服务/.test(p)) return 'y';
      if (p.startsWith('> ')) return answers[++step] ?? 'ok';
      if (/y = 批准/.test(p)) return 'y';
      return '';
    });
    const code = await runCli(['x', '--task', 'M7-B', '--export-dir', exportDir], { cwd: root, isTTY: true, io: m.io, registry: registry({ 'claude-cli-personal': planner, codex: reviewer }) });
    expect(code, m.text()).toBe(EXIT.ok);
    const task = await fs.readFile(path.join(exportDir, 'M7-B-task.md'), 'utf8');
    expect(task).toContain('R1：加深色模式');
    expect(task).toContain('R3：支持系统主题');
    expect(task).not.toContain('R2：');
  });

  it('--set-current：已存在 next-task.md 时 TTY 询问确认，确认后旧文件另存', async () => {
    const root = await makeProject();
    const exportDir = await tmpDir('studio-export-');
    await fs.writeFile(path.join(exportDir, 'next-task.md'), '任务编号：OLD-9\n旧\n');
    const m = makeIO((p) => (/替换它/.test(p) ? 'y' : okAnswers(p)));
    const code = await runCli(['x', '--task', 'M7-C', '--export-dir', exportDir, '--set-current'], { cwd: root, isTTY: true, io: m.io, registry: registry() });
    expect(code, m.text()).toBe(EXIT.ok);
    expect(m.text()).toContain('首行是：任务编号：OLD-9');
    expect((await fs.readFile(path.join(exportDir, 'next-task.md'), 'utf8')).split('\n')[0]).toBe('任务编号：M7-C');
    expect(await fs.readFile(path.join(exportDir, 'OLD-9-task.md'), 'utf8')).toBe('任务编号：OLD-9\n旧\n');
  });

  it('--single：不调用评审者；任务文件标注未经独立评审', async () => {
    const root = await makeProject();
    const exportDir = await tmpDir('studio-export-');
    const m = makeIO(okAnswers);
    const code = await runCli(['x', '--task', 'M7-D', '--export-dir', exportDir, '--single', '--planner', 'codex'], { cwd: root, isTTY: true, io: m.io, registry: registry() });
    expect(code, m.text()).toBe(EXIT.ok);
    expect(await fs.readFile(path.join(exportDir, 'M7-D-task.md'), 'utf8')).toContain('未经独立评审');
    expect(m.text()).not.toContain('svc-claude');
  });

  it('预设不可用时入口报错退出（不自动改用其他规划者）', async () => {
    const root = await makeProject();
    const reg = registry({ 'claude-cli-personal': () => new FakeThinker([], { available: false, note: '未开启' }, { id: 'claude-cli-personal', service: 's' }) });
    const m = makeIO();
    const code = await runCli(['x', '--task', 'M1', '--export-dir', '/tmp/none'], { cwd: root, isTTY: true, io: m.io, registry: reg });
    expect(code).toBe(EXIT.usage);
    expect(m.text()).toContain('不会自动改用其他规划者');
    await expect(fs.access(path.join(root, '.studio', 'threads'))).rejects.toThrow();
  });

  it('新线程缺少 --task/--export-dir → 用法错误，不创建线程', async () => {
    const root = await makeProject();
    const m = makeIO();
    expect(await runCli(['x'], { cwd: root, isTTY: true, io: m.io, registry: registry() })).toBe(EXIT.usage);
    await expect(fs.access(path.join(root, '.studio', 'threads'))).rejects.toThrow();
  });

  it('--resume：从确认点恢复并完成', async () => {
    const root = await makeProject();
    const exportDir = await tmpDir('studio-export-');
    const r1 = makeIO();
    expect(await runCli(['x', '--task', 'M7-E', '--export-dir', exportDir], { cwd: root, isTTY: false, io: r1.io, registry: registry() })).toBe(EXIT.waiting);
    const id = (await fs.readdir(path.join(root, '.studio', 'threads')))[0]!;
    const r2 = makeIO(okAnswers);
    const code = await runCli(['--resume', id, '--task', 'M7-E', '--export-dir', exportDir], { cwd: root, isTTY: true, io: r2.io, registry: registry() });
    expect(code, r2.text()).toBe(EXIT.ok);
    expect(r2.text()).toContain(`恢复线程 ${id}`);
    await fs.access(path.join(exportDir, 'M7-E-task.md'));
  });

  it('--import：来源未核实 → 退出码 4，只读；缺少任务清单同样如此；不符 → 退出码 3', async () => {
    const root = await makeProject();
    const exportDir = await tmpDir('studio-export-');
    const m = makeIO(okAnswers);
    await runCli(['x', '--task', 'M7-F', '--export-dir', exportDir], { cwd: root, isTTY: true, io: m.io, registry: registry() });
    const report = path.join(exportDir, 'report.md');
    await fs.writeFile(report, '任务编号：M7-F\n做完了\n');
    const m2 = makeIO();
    expect(await runCli(['--import', report, '--task', 'M7-F'], { cwd: root, isTTY: true, io: m2.io, registry: registry() })).toBe(EXIT.unverified);
    expect(m2.text()).toContain('来源未核实');
    expect(m2.text()).toContain('只读查看');
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    await fs.writeFile(report, `任务编号：M7-F\n仓库：${root}\n分支：other\n工作树路径：${root}\n开始 HEAD：${head}\n结束 HEAD：${head}\n`);
    const m3 = makeIO();
    expect(await runCli(['--import', report, '--task', 'M7-F'], { cwd: root, isTTY: true, io: m3.io, registry: registry() })).toBe(EXIT.mismatch);
    expect(m3.text()).toContain('矛盾：分支');
  });

  it('--import：已绑定 → 规划者审查一次，结果只是意见；无 TTY 且未确认外发则跳过', async () => {
    const root = await makeProject();
    const exportDir = await tmpDir('studio-export-');
    await runCli(['x', '--task', 'M7-G', '--export-dir', exportDir], { cwd: root, isTTY: true, io: makeIO(okAnswers).io, registry: registry() });
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    const real = await fs.realpath(root);
    const report = path.join(exportDir, 'report.md');
    await fs.writeFile(report, `任务编号：M7-G\n仓库：${real}\n分支：main\n工作树路径：${real}\n开始 HEAD：${head}\n结束 HEAD：${head}\n测试：5 passed\n`);
    const review = { summary: '看起来完成', concerns: ['无 smoke'], evidence_gaps: [], recommendation: '需要补充' };
    const reg = registry({ 'claude-cli-personal': () => new FakeThinker([{ raw: JSON.stringify(review) }], { available: true }, { id: 'claude-cli-personal', service: 'svc-claude' }) });
    const m = makeIO(okAnswers);
    expect(await runCli(['--import', report, '--task', 'M7-G'], { cwd: root, isTTY: true, io: m.io, registry: reg })).toBe(EXIT.ok);
    expect(m.text()).toContain('报告绑定结果：已绑定');
    expect(m.text()).toContain('结论建议：需要补充');
    expect(m.text()).toContain('不是验收通过');
    expect(m.text()).toContain('不会自动派下一个任务');
    // 无 TTY 且服务未确认
    const cs = new ConsentStore(root);
    await cs.clear({ expectedRevision: (await cs.get())?.revision ?? 0 });
    const m2 = makeIO();
    const reg2 = registry({ 'claude-cli-personal': () => new FakeThinker([{ raw: JSON.stringify(review) }], { available: true }, { id: 'claude-cli-personal', service: 'svc-claude' }) });
    expect(await runCli(['--import', report, '--task', 'M7-G'], { cwd: root, isTTY: false, io: m2.io, registry: reg2 })).toBe(EXIT.waiting);
    expect(m2.text()).toContain('跳过规划者审查');
  });
});

void ({} as CliEnv);

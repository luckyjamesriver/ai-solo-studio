import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateProjectPath } from '../src/core/env/project-path.js';
import { checkNodeCompat, nvmrcMajor, satisfiesRange } from '../src/core/env/node-compat.js';
import { candidateDirs, findExecutable, resolveTool, resolveHostTools, uniqueAbsoluteDirs } from '../src/core/env/path.js';
import { hostEnv, setSupplementalPath, withSupplementalPath } from '../src/core/env/host-env.js';
import { runHealthCheck, LAYER_KEYS, type CodexProbe, type HealthOptions } from '../src/core/env/health.js';
import { RecentProjects } from '../src/core/app/recent.js';
import { DisclosureStore, buildDisclosure } from '../src/core/app/disclosure.js';
import type { ToolLocation } from '../src/core/env/path.js';

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-env-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); setSupplementalPath([]); });

const mkdir = (...p: string[]) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const exe = (dir: string, name: string, mode = 0o755) => { const f = path.join(dir, name); fs.writeFileSync(f, '#!/bin/sh\nexit 0\n', { mode }); fs.chmodSync(f, mode); return f; };

describe('项目路径校验', () => {
  it('普通项目目录通过，并返回解析后的真实路径', async () => {
    const home = mkdir('home');
    const proj = mkdir('home', 'site');
    expect(await validateProjectPath(proj, { home })).toEqual({ ok: true, path: proj });
  });
  it('拒绝：不存在、不是目录、相对路径、空输入', async () => {
    const home = mkdir('home');
    expect((await validateProjectPath(path.join(home, 'nope'), { home })).ok).toBe(false);
    const f = path.join(home, 'a.txt'); fs.writeFileSync(f, 'x');
    expect(await validateProjectPath(f, { home })).toMatchObject({ ok: false, reason: expect.stringContaining('不是文件夹') });
    expect((await validateProjectPath('relative/dir', { home })).ok).toBe(false);
    expect((await validateProjectPath('', { home })).ok).toBe(false);
    expect((await validateProjectPath(undefined, { home })).ok).toBe(false);
  });
  it('拒绝用户主目录本身及其上级目录', async () => {
    const home = mkdir('home', 'me');
    expect(await validateProjectPath(home, { home })).toMatchObject({ ok: false, reason: expect.stringContaining('主目录') });
    expect((await validateProjectPath(path.dirname(home), { home })).ok).toBe(false);
    expect((await validateProjectPath('/', { home })).ok).toBe(false);
  });
  it('拒绝系统目录（及其子目录）与过于宽泛的目录', async () => {
    const home = mkdir('home');
    for (const p of ['/usr', '/usr/bin', '/etc', '/System', '/Applications']) {
      if (fs.existsSync(p)) expect((await validateProjectPath(p, { home })).ok, p).toBe(false);
    }
    const sys = mkdir('fake-system', 'lib');
    expect((await validateProjectPath(sys, { home, blockedTrees: [path.join(tmp, 'fake-system')] })).ok).toBe(false);
    const wide = mkdir('wide');
    expect((await validateProjectPath(wide, { home, blockedExact: [wide] })).ok).toBe(false);
    // blockedExact 只拦它本身，不拦子目录
    const child = mkdir('wide', 'proj');
    expect((await validateProjectPath(child, { home, blockedExact: [wide] })).ok).toBe(true);
  });
  it('符号链接：解析后再校验——指向主目录或系统目录的链接被拒，指向正常目录的链接返回真实路径', async () => {
    const home = mkdir('home');
    const proj = mkdir('home', 'real');
    const toHome = path.join(tmp, 'link-home'); fs.symlinkSync(home, toHome);
    expect((await validateProjectPath(toHome, { home })).ok).toBe(false);
    const toSys = path.join(tmp, 'link-etc'); fs.symlinkSync('/etc', toSys);
    expect((await validateProjectPath(toSys, { home })).ok).toBe(false);
    const ok = path.join(tmp, 'link-proj'); fs.symlinkSync(proj, ok);
    expect(await validateProjectPath(ok, { home })).toEqual({ ok: true, path: proj });
    const broken = path.join(tmp, 'broken'); fs.symlinkSync(path.join(tmp, 'gone'), broken);
    expect((await validateProjectPath(broken, { home })).ok).toBe(false);
  });
});

describe('Node 版本兼容判断', () => {
  const proj = (files: Record<string, string>) => {
    const d = mkdir(`p${Math.random().toString(36).slice(2)}`);
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
    return d;
  };
  it('.nvmrc 的各种写法', () => {
    expect(nvmrcMajor('22\n')).toBe(22);
    expect(nvmrcMajor('v22.23.4')).toBe(22);
    expect(nvmrcMajor('22.x')).toBe(22);
    expect(nvmrcMajor('# 注释\n22 # 行尾注释')).toBe(22);
    expect(nvmrcMajor('lts/*')).toBeNull();
    expect(nvmrcMajor('lts/iron')).toBeNull();
    expect(nvmrcMajor('node')).toBeNull();
    expect(nvmrcMajor('')).toBeNull();
  });
  it('主版本一致 / 不一致 / 无法判断 / 未声明', async () => {
    expect(await checkNodeCompat('v22.23.4', proj({ '.nvmrc': '22' }))).toMatchObject({ status: 'compatible', source: '.nvmrc' });
    expect(await checkNodeCompat('v22.23.4', proj({ '.nvmrc': 'v22.23.4' }))).toMatchObject({ status: 'compatible' });
    expect(await checkNodeCompat('v26.13.0', proj({ '.nvmrc': '22' }))).toMatchObject({ status: 'incompatible', declared: '22' });
    expect(await checkNodeCompat('v22.1.0', proj({ '.nvmrc': 'lts/*' }))).toMatchObject({ status: 'unknown', declared: 'lts/*' });
    expect(await checkNodeCompat('v22.1.0', proj({}))).toEqual({ status: 'undeclared' });
    expect(await checkNodeCompat('v22.1.0', proj({ 'package.json': '{"name":"x"}' }))).toEqual({ status: 'undeclared' });
  });
  it('package.json engines.node 的常见范围写法', async () => {
    const e = (range: string) => proj({ 'package.json': JSON.stringify({ engines: { node: range } }) });
    expect(await checkNodeCompat('v22.5.0', e('>=22 <23'))).toMatchObject({ status: 'compatible', source: 'package.json' });
    expect(await checkNodeCompat('v26.13.0', e('>=22 <23'))).toMatchObject({ status: 'incompatible' });
    expect(satisfiesRange('v22.5.0', '^22.0.0')).toBe(true);
    expect(satisfiesRange('v23.0.0', '^22.0.0')).toBe(false);
    expect(satisfiesRange('v22.5.0', '22.x')).toBe(true);
    expect(satisfiesRange('v20.1.0', '22.x')).toBe(false);
    expect(satisfiesRange('v22.5.0', '~22.5.0')).toBe(true);
    expect(satisfiesRange('v22.6.0', '~22.5.0')).toBe(false);
    expect(satisfiesRange('v18.0.0', '^18 || ^20 || ^22')).toBe(true);
    expect(satisfiesRange('v21.0.0', '^18 || ^20 || ^22')).toBe(false);
    expect(satisfiesRange('v22.0.0', '*')).toBe(true);
    expect(satisfiesRange('v22.0.0', 'lts/*')).toBeNull();
    expect(await checkNodeCompat('v22.5.0', e('whatever'))).toMatchObject({ status: 'unknown', source: 'package.json' });
  });
  it('.nvmrc 无法判断时回退到 engines；两者都无法判断才是“未知”；package.json 损坏不报错', async () => {
    expect(await checkNodeCompat('v22.5.0', proj({ '.nvmrc': 'lts/*', 'package.json': '{"engines":{"node":">=22"}}' }))).toMatchObject({ status: 'compatible', source: 'package.json' });
    expect(await checkNodeCompat('v22.5.0', proj({ '.nvmrc': 'lts/*', 'package.json': '{"engines":{"node":"nonsense"}}' }))).toMatchObject({ status: 'unknown', source: '.nvmrc' });
    expect(await checkNodeCompat('v22.5.0', proj({ 'package.json': '{ broken' }))).toEqual({ status: 'undeclared' });
    expect(await checkNodeCompat('not-a-version', proj({ '.nvmrc': '22' }))).toMatchObject({ status: 'unknown' });
  });
});

describe('PATH 解析（不执行用户 shell 配置）', () => {
  it('候选名单：绝对路径、家目录候选来自传入的 home', () => {
    const c = candidateDirs('/h/me');
    expect(c.every((d) => path.isAbsolute(d))).toBe(true);
    expect(c).toContain('/opt/homebrew/bin');
    expect(c).toContain('/h/me/.local/bin');
  });
  it('候选不存在：找不到；不可执行：找不到；目录同名：找不到', async () => {
    const d = mkdir('bin');
    expect(await resolveTool('git', { pathEnv: '', candidates: [path.join(tmp, 'nope')] })).toBeNull();
    exe(d, 'plain', 0o644);
    expect(await findExecutable(d, 'plain')).toBeNull();
    fs.mkdirSync(path.join(d, 'isdir'));
    expect(await findExecutable(d, 'isdir')).toBeNull();
    expect(await resolveTool('plain', { pathEnv: d, candidates: [d] })).toBeNull();
  });
  it('在 PATH 中找到 → via=path；仅在候选中找到 → via=fallback', async () => {
    const a = mkdir('a'); const b = mkdir('b');
    exe(a, 'tool-a'); exe(b, 'tool-b');
    expect(await resolveTool('tool-a', { pathEnv: a, candidates: [b] })).toMatchObject({ via: 'path', dir: a });
    expect(await resolveTool('tool-b', { pathEnv: a, candidates: [b] })).toMatchObject({ via: 'fallback', dir: b });
    expect(await resolveTool('tool-b', { pathEnv: '', candidates: [b] })).toMatchObject({ via: 'fallback' });
  });
  it('符号链接：链接到可执行文件算找到并给出真实路径；断链不算', async () => {
    const real = mkdir('real'); const links = mkdir('links');
    const target = exe(real, 'node-real');
    fs.symlinkSync(target, path.join(links, 'node'));
    fs.symlinkSync(path.join(real, 'missing'), path.join(links, 'broken'));
    expect(await findExecutable(links, 'node')).toEqual({ path: path.join(links, 'node'), realPath: target });
    expect(await findExecutable(links, 'broken')).toBeNull();
  });
  it('重复项：同一目录写两次、符号链接指向同一目录、空项与相对项都被合并或丢弃', async () => {
    const a = mkdir('a');
    const link = path.join(tmp, 'a-link'); fs.symlinkSync(a, link);
    expect(await uniqueAbsoluteDirs([a, a, link, '', 'relative', path.join(tmp, 'missing')])).toEqual([a]);
    exe(a, 't');
    const r = await resolveHostTools(['t', 'absent'], { pathEnv: '', candidates: [a, link, a] });
    expect(r.tools.t).toMatchObject({ via: 'fallback' });
    expect(r.tools.absent).toBeNull();
    expect(r.supplementalDirs).toEqual([a]);
  });
  it('补全路径只进入子进程环境副本，不修改 process.env', () => {
    const before = process.env.PATH;
    const env = withSupplementalPath({ PATH: '/usr/bin:/bin' }, ['/opt/x', '/usr/bin']);
    expect(env.PATH).toBe('/usr/bin:/bin:/opt/x');
    setSupplementalPath(['/opt/y']);
    const h = hostEnv({ PATH: '/usr/bin' });
    expect(h.PATH).toBe('/usr/bin:/opt/y');
    expect(process.env.PATH).toBe(before);
    expect(hostEnv({ PATH: '/usr/bin' })).not.toBe(h);
  });
});

describe('分层环境体检', () => {
  const loc = (name: string, p: string, via: 'path' | 'fallback' = 'path'): ToolLocation => ({ name, path: p, realPath: p, dir: path.dirname(p), via });
  const base = (over: Partial<HealthOptions> = {}): HealthOptions => ({
    tools: { tools: { git: loc('git', '/usr/bin/git'), node: loc('node', process.execPath), npm: loc('npm', '/usr/bin/true'), codex: null }, supplementalDirs: [] },
    processPath: '/usr/bin:/bin',
    projectDir: null,
    executor: 'codex',
    codex: null,
    verifiedCodexVersion: '0.166.0',
    ...over,
  });
  const probe = (d: Partial<Awaited<ReturnType<CodexProbe['detect']>>>, pre: () => Promise<{ problems: string[] }> = async () => ({ problems: [] })): CodexProbe => ({
    detect: async () => ({ installed: true, loggedIn: 'yes', version: 'codex-cli 0.166.0', verified: true, ...d }),
    preflight: pre,
  });
  const find = (r: Awaited<ReturnType<typeof runHealthCheck>>, id: string) => r.items.find((i) => i.id === id)!;

  it('每个检查项都有五层状态，且都是合法值', async () => {
    const r = await runHealthCheck(base({ codex: probe({}), tools: { tools: { git: loc('git', '/usr/bin/git'), node: loc('node', process.execPath), npm: loc('npm', '/usr/bin/true'), codex: loc('codex', '/usr/bin/true') }, supplementalDirs: [] } }));
    expect(r.items.map((i) => i.id)).toEqual(['git', 'node', 'npm', 'codex']);
    for (const i of r.items) {
      expect(Object.keys(i.layers)).toEqual([...LAYER_KEYS]);
      for (const k of LAYER_KEYS) expect(['pass', 'fail', 'unknown', 'na']).toContain(i.layers[k].state);
    }
    const codex = find(r, 'codex');
    expect(LAYER_KEYS.map((k) => codex.layers[k].state)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
    expect(codex.overall).toBe('pass');
    expect(find(r, 'git').layers).toMatchObject({ installed: { state: 'pass' }, starts: { state: 'pass' }, compatible: { state: 'na' }, loggedIn: { state: 'na' }, secured: { state: 'na' } });
  });
  it('没找到工具：已安装不通过，其余无法判断的层写“未知”而不是通过，并给出怎么办', async () => {
    const r = await runHealthCheck(base({ tools: { tools: { git: null, node: null, npm: null, codex: null }, supplementalDirs: [] } }));
    for (const i of r.items) {
      expect(i.layers.installed.state).toBe('fail');
      expect(i.overall).toBe('fail');
      expect(i.advice).toBeTruthy();
      expect(i.foundVia).toBeNull();
      expect(i.layers.starts.state).toBe('unknown');
    }
    const codex = find(r, 'codex');
    expect(LAYER_KEYS.map((k) => codex.layers[k].state)).toEqual(['fail', 'unknown', 'unknown', 'unknown', 'unknown']);
    expect(r.limitations).toEqual([]);
  });
  it('工具存在但无法启动 → 能启动不通过', async () => {
    const bad = path.join(tmp, 'notexec'); fs.writeFileSync(bad, 'x', { mode: 0o755 }); // 不是有效的可执行格式
    const r = await runHealthCheck(base({ tools: { tools: { git: loc('git', bad), node: loc('node', process.execPath), npm: loc('npm', '/usr/bin/true'), codex: null }, supplementalDirs: [] } }));
    expect(find(r, 'git').layers.starts.state).toBe('fail');
    expect(find(r, 'git').advice).toBeTruthy();
  });
  it('Node 版本兼容：未打开项目=未知；项目未声明=不适用；不一致=不通过并提示安装；一致=通过', async () => {
    const major = process.versions.node.split('.')[0]!;
    expect(find(await runHealthCheck(base()), 'node').layers.compatible).toMatchObject({ state: 'unknown' });
    const none = mkdir('none');
    expect(find(await runHealthCheck(base({ projectDir: none })), 'node').layers.compatible).toEqual({ state: 'na', note: '项目未声明' });
    const bad = mkdir('bad'); fs.writeFileSync(path.join(bad, '.nvmrc'), String(Number(major) + 1));
    const nb = find(await runHealthCheck(base({ projectDir: bad })), 'node');
    expect(nb.layers.compatible.state).toBe('fail');
    expect(nb.overall).toBe('fail');
    expect(nb.advice).toContain(`Node ${Number(major) + 1}`);
    const good = mkdir('good'); fs.writeFileSync(path.join(good, '.nvmrc'), major);
    expect(find(await runHealthCheck(base({ projectDir: good })), 'node').layers.compatible.state).toBe('pass');
    const lts = mkdir('lts'); fs.writeFileSync(path.join(lts, '.nvmrc'), 'lts/*');
    const nl = find(await runHealthCheck(base({ projectDir: lts })), 'node');
    expect(nl.layers.compatible.state).toBe('unknown');
    expect(nl.overall).toBe('unknown');
  });
  it('通过补全路径找到 → foundVia=fallback', async () => {
    const r = await runHealthCheck(base({ tools: { tools: { git: loc('git', '/usr/bin/git', 'fallback'), node: null, npm: null, codex: null }, supplementalDirs: ['/usr/bin'] } }));
    expect(find(r, 'git').foundVia).toBe('fallback');
    expect(r.pathInfo.supplementalDirs).toEqual(['/usr/bin']);
  });
  const withCodex = (p: CodexProbe) => base({ codex: p, tools: { tools: { git: loc('git', '/usr/bin/git'), node: loc('node', process.execPath), npm: loc('npm', '/usr/bin/true'), codex: loc('codex', '/usr/bin/true') }, supplementalDirs: [] } });
  it('Codex：未登录=不通过；登录状态不明=未知；版本未经验证=未知（复用传入的已验证版本，不写死）', async () => {
    const no = find(await runHealthCheck(withCodex(probe({ loggedIn: 'no' }))), 'codex');
    expect(no.layers.loggedIn.state).toBe('fail');
    expect(no.overall).toBe('fail');
    expect(no.advice).toContain('登录');
    expect(find(await runHealthCheck(withCodex(probe({ loggedIn: 'unknown' }))), 'codex').layers.loggedIn.state).toBe('unknown');
    const ver = find(await runHealthCheck(withCodex(probe({ verified: false, version: 'codex-cli 9.9.9' }))), 'codex');
    expect(ver.layers.compatible.state).toBe('unknown');
    expect(ver.layers.compatible.note).toContain('0.166.0');
    expect(find(await runHealthCheck(withCodex(probe({ verified: undefined as unknown as boolean }))), 'codex').layers.compatible.state).toBe('unknown');
  });
  it('Codex 安全配置：自检有问题=不通过；自检无法完成=未知（不得显示通过）', async () => {
    const bad = find(await runHealthCheck(withCodex(probe({}, async () => ({ problems: ['沙箱模式'] })))), 'codex');
    expect(bad.layers.secured.state).toBe('fail');
    expect(bad.layers.secured.note).toContain('沙箱模式');
    const unk = find(await runHealthCheck(withCodex(probe({}, async () => { throw new Error('读取 Codex 配置超时'); }))), 'codex');
    expect(unk.layers.secured.state).toBe('unknown');
    expect(unk.overall).toBe('unknown');
  });
  it('已知限制：只在所选执行体 Codex 已安装时显示，且只来自适配器给出的条目', async () => {
    const notes = ['检测到用户级 AGENTS.md：…'];
    expect((await runHealthCheck(withCodex(probe({ isolationNotes: notes })))).limitations).toEqual(notes);
    expect((await runHealthCheck(withCodex(probe({})))).limitations).toEqual([]);
    expect((await runHealthCheck(base())).limitations).toEqual([]);
  });
});

describe('最近项目', () => {
  it('只存路径与时间；同一路径置顶更新；按编号解析并重新校验', async () => {
    const data = mkdir('data'); const home = mkdir('home');
    const p1 = mkdir('home', 'a'); const p2 = mkdir('home', 'b');
    const r = new RecentProjects(data, { home });
    const e1 = await r.record(p1, new Date('2026-01-01T00:00:00Z'));
    await r.record(p2, new Date('2026-01-02T00:00:00Z'));
    const again = await r.record(p1, new Date('2026-01-03T00:00:00Z'));
    expect(again.id).toBe(e1.id);
    const list = await r.list();
    expect(list.map((x) => x.path)).toEqual([p1, p2]);
    expect(list[0]).toMatchObject({ name: 'a', exists: true, lastOpened: '2026-01-03T00:00:00.000Z' });
    expect(await r.resolve(e1.id)).toEqual({ ok: true, path: p1 });
    const stored = JSON.parse(fs.readFileSync(path.join(data, 'recent-projects.json'), 'utf8'));
    expect(Object.keys(stored.entries[0]).sort()).toEqual(['id', 'lastOpened', 'path']);
  });
  it('路径失效或编号不存在 → 拒绝；被删除/变成非目录后 exists=false；传路径当编号无效', async () => {
    const data = mkdir('data'); const home = mkdir('home'); const p = mkdir('home', 'gone');
    const r = new RecentProjects(data, { home });
    const e = await r.record(p);
    fs.rmSync(p, { recursive: true });
    expect((await r.list())[0]!.exists).toBe(false);
    expect(await r.resolve(e.id)).toMatchObject({ ok: false });
    expect(await r.resolve('no-such-id')).toMatchObject({ ok: false });
    expect(await r.resolve(p)).toMatchObject({ ok: false });
    expect(await r.resolve(undefined)).toMatchObject({ ok: false });
  });
  it('列表里的路径若后来变成了主目录的符号链接，打开时被拒绝', async () => {
    const data = mkdir('data'); const home = mkdir('home'); const p = mkdir('home', 'p');
    const r = new RecentProjects(data, { home });
    const e = await r.record(p);
    fs.rmSync(p, { recursive: true });
    fs.symlinkSync(home, p);
    expect(await r.resolve(e.id)).toMatchObject({ ok: false });
  });
  it('文件损坏时按空列表处理；最多保留 10 项', async () => {
    const data = mkdir('data'); const home = mkdir('home');
    fs.writeFileSync(path.join(data, 'recent-projects.json'), '{ nope');
    const r = new RecentProjects(data, { home });
    expect(await r.list()).toEqual([]);
    for (let i = 0; i < 12; i++) await r.record(mkdir('home', `p${i}`));
    expect(await r.list()).toHaveLength(10);
  });
});

describe('首次外发告知', () => {
  it('按当前可用的执行体与思考者列出服务名；没有可用服务时如实为空', () => {
    expect(buildDisclosure({ codexInstalled: false, devPersonalClaude: false }).services).toEqual([]);
    expect(buildDisclosure({ codexInstalled: true, devPersonalClaude: false }).services.map((s) => s.name)).toEqual(['OpenAI（Codex）']);
    expect(buildDisclosure({ codexInstalled: true, devPersonalClaude: true }).services).toHaveLength(2);
    const c = buildDisclosure({ codexInstalled: true, devPersonalClaude: false });
    expect(c.when.join('')).toContain('确认');
    expect(c.never.join('')).toContain('凭证');
  });
  it('确认后记录在应用数据目录；未确认时 requireAccepted 抛错', async () => {
    const data = mkdir('data');
    const s = new DisclosureStore(data);
    expect(await s.get()).toBeNull();
    await expect(s.requireAccepted()).rejects.toThrow('外发说明');
    await s.accept(buildDisclosure({ codexInstalled: true, devPersonalClaude: false }), new Date('2026-01-01T00:00:00Z'));
    expect(await s.get()).toMatchObject({ acceptedAt: '2026-01-01T00:00:00.000Z', services: ['OpenAI（Codex）'] });
    await expect(s.requireAccepted()).resolves.toBeUndefined();
    expect(new DisclosureStore(data)).toBeDefined();
  });
  it('记录文件损坏或版本不符 → 视为未确认', async () => {
    const data = mkdir('data');
    fs.writeFileSync(path.join(data, 'disclosure.json'), '{ nope');
    expect(await new DisclosureStore(data).get()).toBeNull();
    fs.writeFileSync(path.join(data, 'disclosure.json'), JSON.stringify({ version: 0, acceptedAt: 'x' }));
    expect(await new DisclosureStore(data).get()).toBeNull();
  });
});

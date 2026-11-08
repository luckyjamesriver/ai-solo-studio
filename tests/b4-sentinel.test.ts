import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TaskRunner } from '../src/core/task/runner.js';
import { FakeExecutor } from '../src/core/executor/adapters/fake.js';
import { MESSAGES } from '../src/core/task/messages.js';
import * as G from '../src/core/git/git.js';

/**
 * M3-B4-1 哨兵测试：把会执行外部程序的 Git 入口配置成“写一个哨兵文件的脚本”，
 * 跑完读证据 / 保存 / 放弃 / 撤销，断言哨兵文件一个都没有出现。
 *
 * - hooksPath 钩子、.git/hooks 钩子、fsmonitor、gpg.program：全流程必须跑通，且哨兵不出现；
 * - filter / merge / diff(textconv) / diff(command) 驱动：无法在不改变内容语义的前提下关闭，必须在检测处停止，副本保留，哨兵不出现。
 * - 每个场景都配有“对照”：同样的配置交给不受控的 git 命令，哨兵必须出现——否则“没出现”什么也证明不了。
 * 测试仓库与脚本全部建在 ~/ai-solo-studio-b4-probe/（测试创建、结束删除）；恶意配置只写进这些测试仓库自己的 .git/config 与仓库文件，
 * 不修改用户全局或系统 git 配置。仅在受限执行环境无法写入 home 时，可用 STUDIO_B4_PROBE_ROOT 指向别处（该路径必须尚不存在）。
 */
const root = process.env.STUDIO_B4_PROBE_ROOT ?? path.join(os.homedir(), 'ai-solo-studio-b4-probe');
let sentDir = '';
let scriptDir = '';

const sent = (name: string) => path.join(sentDir, name);
const sentinels = () => fs.readdirSync(sentDir).sort();
const clearSentinels = () => fs.readdirSync(sentDir).forEach((f) => fs.rmSync(sent(f)));
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
/** 仅用于布置恶意配置和“对照”：不经受控层，所以必须只作用于本测试自己的仓库 */
const rawGit = (cwd: string, ...args: string[]) => {
  try {
    return execFileSync('git', args, { cwd, stdio: 'pipe', env: GIT_ENV }).toString();
  } catch {
    return ''; // 对照命令允许失败（例如签名程序不产生签名），我们只关心哨兵
  }
};

function script(name: string, body = ''): string {
  const p = path.join(scriptDir, `${name}.sh`);
  fs.writeFileSync(p, `#!/bin/sh\n: > "${sent(name)}"\n${body}\nexit ${body.includes('exit') ? '' : '0'}\n`.replace(/exit \n/, '\n'));
  fs.chmodSync(p, 0o755);
  return p;
}

const HOOK_NAMES = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-checkout', 'post-merge', 'pre-merge-commit'];

interface Scenario {
  name: string;
  kind: 'hooks' | 'driver';
  /** 项目里的文件（含 .gitattributes），在第一个保存点之前写入 */
  files: Record<string, string>;
  /** 驱动场景里 AI 写入的文件扩展名 */
  ext?: string;
  /** 布置恶意配置（只写这个测试仓库的 .git/config 或 .git/hooks 等） */
  configure(repo: string): void;
  /** 对照：不受控的 git 命令必须触发哨兵 */
  control(repo: string): void;
  customChecks?: boolean;
}

const mergeControl = (repo: string) => {
  fs.writeFileSync(path.join(repo, 'm.dat'), 'base\n');
  rawGit(repo, 'add', '-A');
  rawGit(repo, 'commit', '-m', 'base', '--no-verify');
  rawGit(repo, 'checkout', '-b', 'side');
  fs.writeFileSync(path.join(repo, 'm.dat'), 'side\n');
  rawGit(repo, 'commit', '-am', 'side', '--no-verify');
  rawGit(repo, 'checkout', 'main');
  fs.writeFileSync(path.join(repo, 'm.dat'), 'main\n');
  rawGit(repo, 'commit', '-am', 'main', '--no-verify');
  rawGit(repo, 'merge', 'side');
};

const SCENARIOS: Scenario[] = [
  {
    name: 'hookspath',
    kind: 'hooks',
    files: { 'index.html': 'old\n' },
    customChecks: true,
    configure(repo) {
      const dir = path.join(root, `hooks-${path.basename(repo)}`);
      fs.mkdirSync(dir, { recursive: true });
      for (const h of HOOK_NAMES) fs.copyFileSync(script(`hookspath-${h}`), path.join(dir, h));
      for (const h of HOOK_NAMES) fs.chmodSync(path.join(dir, h), 0o755);
      rawGit(repo, 'config', 'core.hooksPath', dir);
    },
    control: (repo) => void rawGit(repo, 'commit', '--allow-empty', '-m', 'c'),
  },
  {
    name: 'githooks',
    kind: 'hooks',
    files: { 'index.html': 'old\n' },
    customChecks: true,
    configure(repo) {
      for (const h of HOOK_NAMES) {
        fs.copyFileSync(script(`githooks-${h}`), path.join(repo, '.git', 'hooks', h));
        fs.chmodSync(path.join(repo, '.git', 'hooks', h), 0o755);
      }
    },
    control: (repo) => void rawGit(repo, 'commit', '--allow-empty', '-m', 'c'),
  },
  {
    name: 'fsmonitor',
    kind: 'hooks',
    files: { 'index.html': 'old\n' },
    configure: (repo) => rawGit(repo, 'config', 'core.fsmonitor', script('fsmonitor-hook')) && undefined,
    control: (repo) => void rawGit(repo, 'status'),
  },
  {
    name: 'gpg',
    kind: 'hooks',
    files: { 'index.html': 'old\n' },
    configure(repo) {
      rawGit(repo, 'config', 'commit.gpgsign', 'true');
      rawGit(repo, 'config', 'tag.gpgsign', 'true');
      rawGit(repo, 'config', 'user.signingkey', 'ABCDEF');
      rawGit(repo, 'config', 'gpg.program', script('gpg-program'));
    },
    control: (repo) => void rawGit(repo, 'commit', '--allow-empty', '-m', 'c'),
  },
  {
    name: 'filter',
    kind: 'driver',
    ext: 'txt',
    files: { 'index.html': 'old\n', 'seed.txt': 'seed\n', '.gitattributes': '*.txt filter=evil\n' },
    configure(repo) {
      const s = script('filter-driver', 'cat');
      rawGit(repo, 'config', 'filter.evil.clean', s);
      rawGit(repo, 'config', 'filter.evil.smudge', s);
    },
    control(repo) {
      fs.writeFileSync(path.join(repo, 'x.txt'), 'x\n');
      rawGit(repo, 'add', 'x.txt');
    },
  },
  {
    name: 'merge',
    kind: 'driver',
    ext: 'dat',
    files: { 'index.html': 'old\n', 'seed.dat': 'seed\n', '.gitattributes': '*.dat merge=evil\n' },
    configure: (repo) => void rawGit(repo, 'config', 'merge.evil.driver', `${script('merge-driver', 'exit 1')} %O %A %B`),
    control: mergeControl,
  },
  {
    name: 'diff-textconv',
    kind: 'driver',
    ext: 'md',
    files: { 'index.html': 'old\n', 'a.md': 'one\n', '.gitattributes': '*.md diff=evil\n' },
    configure: (repo) => void rawGit(repo, 'config', 'diff.evil.textconv', script('diff-textconv', 'cat "$1"')),
    control(repo) {
      fs.writeFileSync(path.join(repo, 'a.md'), 'two\n');
      rawGit(repo, 'diff');
    },
  },
  {
    name: 'diff-command',
    kind: 'driver',
    ext: 'md',
    files: { 'index.html': 'old\n', 'a.md': 'one\n', '.gitattributes': '*.md diff=evil\n' },
    configure: (repo) => void rawGit(repo, 'config', 'diff.evil.command', script('diff-command')),
    control(repo) {
      fs.writeFileSync(path.join(repo, 'a.md'), 'two\n');
      rawGit(repo, 'diff');
    },
  },
];

let counter = 0;
async function mkProject(s: Scenario, tag: string): Promise<string> {
  const dir = path.join(root, `${s.name}-${tag}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  const repo = fs.realpathSync(dir);
  for (const [f, c] of Object.entries(s.files)) fs.writeFileSync(path.join(repo, f), c);
  await G.initRepo(repo); // 第一个保存点在恶意配置布置之前
  return repo;
}

const plan = { goal: '加文件', inScope: [], outOfScope: [], criteria: ['文件已加'], risks: [], irreversible: [] };

function harness(repo: string) {
  let file = 'index.html';
  const runner = new TaskRunner({
    repo,
    executor: new FakeExecutor(() => [{ do: 'write', path: file, content: `content of ${file}\n` }, { do: 'exit', code: 0 }]),
    runChecks: false,
  });
  /** 创建 → 计划 → 批准 → 开工（到验收）；confirm=true 时逐条确认 */
  const task = async (f: string, confirm = true) => {
    file = f;
    const t = await runner.create('加文件');
    await runner.setPlan(t.id, plan);
    await runner.approve(t.id);
    const r = await runner.start(t.id);
    if (confirm) await runner.confirm(t.id, { criterion: 0, decision: 'confirmed' });
    return r;
  };
  return { runner, task };
}

describe('B4-1 哨兵测试：项目配置里的程序不得被宿主运行', () => {
  beforeAll(() => {
    if (fs.existsSync(root)) throw new Error(`${root} 已存在，为避免删除不属于本测试的内容而中止；请先确认并手动删除。`);
    fs.mkdirSync(root, { recursive: true });
    sentDir = path.join(root, 'sentinels');
    scriptDir = path.join(root, 'scripts');
    fs.mkdirSync(sentDir);
    fs.mkdirSync(scriptDir);
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const sc of SCENARIOS) {
    describe(sc.name, () => {
      it('对照：同样的配置交给不受控的 git，哨兵会出现（证明哨兵布置有效）', async () => {
        clearSentinels();
        const repo = await mkProject(sc, 'control');
        sc.configure(repo);
        sc.control(repo);
        expect(sentinels().length, `${sc.name} 的对照没有触发哨兵，测试无效`).toBeGreaterThan(0);
        clearSentinels();
      });

      if (sc.kind === 'hooks') {
        it('读证据 / 保存 / 撤销 / 放弃全流程跑通，哨兵一个都不出现', async () => {
          clearSentinels();
          const repo = await mkProject(sc, 'flow');
          sc.configure(repo);
          const { runner, task } = harness(repo);

          const t1 = await task('index.html');
          expect(t1.state).toBe('reviewing');
          expect(t1.card!.notes ?? []).toEqual(sc.customChecks ? [MESSAGES.skippedCommitChecks] : []); // 仅当项目确有自定义提交检查才如实说明
          await G.diffText(t1.worktree!); // 读证据
          expect(sentinels()).toEqual([]);

          const saved = await runner.save(t1.id);
          expect(saved.ok, JSON.stringify(saved)).toBe(true);
          expect(sentinels()).toEqual([]);
          expect(fs.readFileSync(path.join(repo, 'index.html'), 'utf8')).toBe('content of index.html\n');

          const undone = await runner.undo(t1.id);
          expect(undone.ok, JSON.stringify(undone)).toBe(true);
          expect(fs.readFileSync(path.join(repo, 'index.html'), 'utf8')).toBe('old\n');
          expect(sentinels()).toEqual([]);

          const t2 = await task('other.html', false);
          const d = await runner.discard(t2.id);
          expect(d.ok).toBe(true);
          expect(await G.isClean(repo)).toBe(true);
          expect(sentinels()).toEqual([]);
        });
      } else {
        it('配置在开工前就存在：开工被拒绝，没有创建副本，哨兵不出现', async () => {
          clearSentinels();
          const repo = await mkProject(sc, 'early');
          sc.configure(repo);
          const { runner, task } = harness(repo);
          await expect(task(`one.${sc.ext}`)).rejects.toThrow(MESSAGES.externalDriver);
          expect(fs.existsSync(path.join(repo, '.studio', 'worktrees'))).toBe(false);
          expect(sentinels()).toEqual([]);
          expect(runner).toBeDefined();
        });

        it('配置在开工后才出现：保存、撤销都在检测处停止，副本保留；放弃仍可用；哨兵不出现', async () => {
          clearSentinels();
          const repo = await mkProject(sc, 'late');
          const { runner, task } = harness(repo);
          // 属性文件已提交但驱动没有定义 → git 不会运行任何东西；先正常保存一个任务
          const t1 = await task(`one.${sc.ext}`);
          expect((await runner.save(t1.id)).ok).toBe(true);
          const t2 = await task(`two.${sc.ext}`);
          expect(t2.state).toBe('reviewing');
          expect(sentinels()).toEqual([]);

          sc.configure(repo); // 现在驱动被定义了
          const head = await G.headSha(repo);

          const s = await runner.save(t2.id);
          expect(s).toMatchObject({ ok: false, reason: 'external_driver', detail: MESSAGES.externalDriver });
          expect(await G.headSha(repo)).toBe(head);
          expect(fs.existsSync(t2.worktree!.path)).toBe(true); // 副本保留
          expect((await runner.store.get(t2.id))!.state).toBe('reviewing');

          const u = await runner.undo(t1.id);
          expect(u).toMatchObject({ ok: false, reason: 'external_driver' });
          expect(await G.headSha(repo)).toBe(head);

          const re = await runner.recheck(t2.id); // 读证据也在检测处停止
          expect(re.card!.items.map((i) => i.key)).toEqual(['drivers']);
          expect(re.card!.changes).toEqual([]);
          expect(re.card!.readyToSave).toBe(false);
          await expect(runner.confirm(t2.id, { criterion: 0, decision: 'confirmed' })).rejects.toThrow();

          expect(sentinels()).toEqual([]);
          const d = await runner.discard(t2.id); // 放弃不需要运行任何驱动
          expect(d.ok).toBe(true);
          expect(fs.existsSync(t2.worktree!.path)).toBe(false);
          expect(sentinels()).toEqual([]);
        });
      }
    });
  }

  it('git-lfs（filter=lfs）无论配置是否存在都归入不支持', async () => {
    const s: Scenario = { name: 'lfs', kind: 'driver', files: { 'index.html': 'old\n' }, configure() {}, control() {} };
    const repo = await mkProject(s, 'lfs');
    // 属性文件在第一个保存点之后才写入且不提交：不执行任何 git add（本机的 lfs 过滤器配置可能让 add 失败），检测只读属性
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    fs.writeFileSync(path.join(repo, 'logo.bin'), 'pointer\n');
    const d = await G.detectExternalDrivers(repo);
    expect(d.supported).toBe(false);
    expect(d.drivers.join(' ')).toContain('filter=lfs');
    expect(d.reason).toBe(MESSAGES.externalDriver);
  });

  it('没有任何驱动配置的普通项目：检测通过，也没有自定义提交检查', async () => {
    const s: Scenario = { name: 'plain', kind: 'hooks', files: { 'index.html': 'x\n', '.gitattributes': '*.png binary\n*.md text\n*.dat merge=union\n' }, configure() {}, control() {} };
    const repo = await mkProject(s, 'plain');
    expect(await G.detectExternalDrivers(repo)).toEqual({ supported: true, drivers: [], reason: '' });
    expect(await G.hasCustomCommitChecks(repo)).toBe(false);
  });
});

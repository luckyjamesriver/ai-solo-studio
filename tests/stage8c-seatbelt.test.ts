import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCapabilities } from '../src/core/capabilities/model.js';
import { runCheck, runProjectChecks, scriptsDigest } from '../src/core/checks/scripts.js';
import type { FullTrustRecords } from '../src/core/executor/modes.js';
import { createStandaloneSandboxRunner } from '../src/core/executor/sandbox/index.js';
import {
  buildSeatbeltProfile,
  canonicalizeSandboxPaths,
  SeatbeltSandboxRunner,
} from '../src/core/executor/sandbox/seatbelt.js';

const cleanDirs: string[] = [];
const cleanServers: http.Server[] = [];

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@local',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@local',
};

afterEach(async () => {
  while (cleanServers.length > 0) {
    const s = cleanServers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
  while (cleanDirs.length > 0) {
    await fs.rm(cleanDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('阶段 8C · 脱离 Codex 的独立沙箱检查运行器（Seatbelt 与跨平台兜底）', () => {
  it('buildSeatbeltProfile 生成最小权限 SBPL 并校验控制字符与 .git 写保护', () => {
    const caps = resolveCapabilities({
      constructionMode: 'standard',
      externalNetwork: 'off',
      extraWritableDirs: ['/tmp/extra-dir'],
    });
    const profile = buildSeatbeltProfile({
      cwd: '/tmp/wt-1',
      capabilities: caps,
      denyRead: ['/tmp/fake-home/.ssh'],
    });

    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(deny file-read*');
    expect(profile).toContain('subpath "/tmp/fake-home/.ssh"');
    expect(profile).toContain('(allow file-write*');
    expect(profile).toContain('(literal "/dev/null")');
    expect(profile).toContain('(deny file-write*');
    expect(profile).toContain('/.git"');
    expect(profile).toContain('(deny network*)');

    expect(() =>
      buildSeatbeltProfile({
        cwd: '/tmp/bad\nline',
        capabilities: caps,
        denyRead: [],
      }),
    ).toThrow('非法控制字符');

    expect(canonicalizeSandboxPaths('/tmp/nonexistent-subdir/a')).toEqual(
      expect.arrayContaining(['/tmp/nonexistent-subdir/a']),
    );
  });

  it('非 macOS 平台、缺失二进制与带域名过滤的联网需求诚实返回 unavailable（绝不宿主直跑）', async () => {
    const linuxRes = await createStandaloneSandboxRunner({ platform: 'linux' });
    expect(linuxRes.runner).toBeUndefined();
    expect(linuxRes.status.available).toBe(false);
    expect(linuxRes.status.kind).toBe('none');

    const linuxDirect = new SeatbeltSandboxRunner({ platform: 'linux' });
    const runLinux = await linuxDirect.runCommand({
      cwd: os.tmpdir(),
      argv: ['echo', 'should-not-run'],
      env: {},
      timeoutMs: 2000,
    });
    expect(runLinux.status).toBe('unavailable');

    const missing = new SeatbeltSandboxRunner({
      platform: 'darwin',
      command: '/nonexistent/sandbox-exec',
    });
    const missingProbe = await missing.detect();
    expect(missingProbe.available).toBe(false);
    const missingRun = await missing.runCommand({
      cwd: os.tmpdir(),
      argv: ['echo', 'nope'],
      env: {},
      timeoutMs: 2000,
    });
    expect(missingRun.status).toBe('unavailable');

    // 未通过 fullTrust 记录确认门禁时，禁止走完全信任放行（以模拟 macOS 二进制隔离平台差异）
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8c-gate-'));
    cleanDirs.push(dir);
    const runner = new SeatbeltSandboxRunner({ platform: 'darwin', command: process.execPath });
    const noRecords: FullTrustRecords = { get: async () => null };
    const deniedFullTrust = await runner.runCommand({
      cwd: dir,
      argv: [process.execPath, '-e', 'console.log("x")'],
      env: {},
      timeoutMs: 5000,
      capabilities: resolveCapabilities({ constructionMode: 'full_trust' }),
      taskId: 'task-unconfirmed',
      fullTrustRecords: noRecords,
    });
    expect(deniedFullTrust.status).toBe('unavailable');
    if (deniedFullTrust.status === 'unavailable') {
      expect(deniedFullTrust.reason).toContain('尚未确认完全信任');
    }

    // 勾选域名白名单时 Seatbelt 无法内核级域名代理，保守拒绝为 unavailable
    const domainScoped = await runner.runCommand({
      cwd: dir,
      argv: [process.execPath, '-e', 'console.log("x")'],
      env: {},
      timeoutMs: 5000,
      capabilities: resolveCapabilities({
        externalNetwork: 'on',
        allowedNetworkDomains: ['api.example.com'],
      }),
    });
    expect(domainScoped.status).toBe('unavailable');
    if (domainScoped.status === 'unavailable') {
      expect(domainScoped.reason).toContain('域名白名单');
    }

    // 跨平台集成语义：无 runner 时 runProjectChecks 标为 sandbox_unavailable
    const fakeProj = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8c-nocheck-'));
    cleanDirs.push(fakeProj);
    await fs.writeFile(
      path.join(fakeProj, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    const digest = await scriptsDigest(fakeProj);
    const outcome = await runProjectChecks(fakeProj, linuxRes.runner, { authorizedDigest: digest });
    expect(outcome.kind).toBe('unavailable');
    expect(outcome.unavailableReason).toBe('sandbox_unavailable');
    expect(outcome.checked).toBe(false);
  });

  const macIt = process.platform === 'darwin' ? it : it.skip;

  macIt(
    'macOS 真实 Seatbelt 哨兵测试：拦截读取 ~/.ssh、拦截写主项目与 .git、放行 worktree 写入、断网阻断外联并完成真实 npm build/test',
    async () => {
      const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-s8c-real-'));
      cleanDirs.push(rootDir);
      const realRoot = await fs.realpath(rootDir);

      const fakeHome = path.join(realRoot, 'home');
      const fakeSsh = path.join(fakeHome, '.ssh');
      const mainRepo = path.join(realRoot, 'repo');
      await fs.mkdir(fakeSsh, { recursive: true });
      await fs.mkdir(mainRepo, { recursive: true });
      await fs.writeFile(path.join(fakeSsh, 'id_rsa'), 'TOP_SECRET_SSH_KEY', 'utf8');

      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: mainRepo });
      await fs.writeFile(path.join(mainRepo, 'main-only.txt'), 'original\n', 'utf8');
      await fs.writeFile(
        path.join(mainRepo, 'package.json'),
        JSON.stringify({
          name: 's8c-real-proj',
          scripts: {
            build: `node -e "require('fs').writeFileSync('built.txt', 'built-ok')"`,
            test: 'node --test sample.test.mjs',
          },
        }),
        'utf8',
      );
      await fs.writeFile(
        path.join(mainRepo, 'sample.test.mjs'),
        `import test from 'node:test';\nimport assert from 'node:assert';\ntest('adds cleanly', () => assert.equal(2 + 3, 5));\n`,
        'utf8',
      );
      execFileSync('git', ['add', '-A'], { cwd: mainRepo });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: mainRepo, env: gitEnv });

      const worktree = path.join(realRoot, 'wt');
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt-check', worktree], { cwd: mainRepo });

      const srv = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end('reachable');
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
      cleanServers.push(srv);
      const port = (srv.address() as { port: number }).port;

      const created = await createStandaloneSandboxRunner({ denyRead: [fakeSsh] });
      expect(created.status.available).toBe(true);
      expect(created.status.kind).toBe('seatbelt');
      expect(created.runner).toBeDefined();
      const runner = created.runner!;

      // 1. 尝试读取 ~/.ssh 失败
      const rReadSsh = await runner.runCommand({
        cwd: worktree,
        argv: [process.execPath, '-e', `require('fs').readFileSync(${JSON.stringify(path.join(fakeSsh, 'id_rsa'))}, 'utf8')`],
        env: {},
        timeoutMs: 5000,
      });
      expect(rReadSsh.status).toBe('ran');
      if (rReadSsh.status === 'ran') {
        expect(rReadSsh.exitCode).not.toBe(0);
        expect(rReadSsh.stderr).toMatch(/EPERM|not permitted/i);
      }

      // 2. 尝试写主项目 repo 失败
      const mainTarget = path.join(mainRepo, 'escaped.txt');
      const rWriteMain = await runner.runCommand({
        cwd: worktree,
        argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(mainTarget)}, 'escape')`],
        env: {},
        timeoutMs: 5000,
      });
      expect(rWriteMain.status).toBe('ran');
      if (rWriteMain.status === 'ran') expect(rWriteMain.exitCode).not.toBe(0);
      await expect(fs.stat(mainTarget)).rejects.toThrow();

      // 3. 尝试写 worktree 内 .git 失败
      const rWriteGit = await runner.runCommand({
        cwd: worktree,
        argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(path.join(worktree, '.git'))}, 'corrupt')`],
        env: {},
        timeoutMs: 5000,
      });
      expect(rWriteGit.status).toBe('ran');
      if (rWriteGit.status === 'ran') expect(rWriteGit.exitCode).not.toBe(0);

      // 4. 写入 worktree 内合法文件成功
      const wtTarget = path.join(worktree, 'safe-output.txt');
      const rWriteWt = await runner.runCommand({
        cwd: worktree,
        argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(wtTarget)}, 'ok')`],
        env: {},
        timeoutMs: 5000,
      });
      expect(rWriteWt.status).toBe('ran');
      if (rWriteWt.status === 'ran') expect(rWriteWt.exitCode).toBe(0);
      expect(await fs.readFile(wtTarget, 'utf8')).toBe('ok');

      // 5. 默认断网下尝试外联失败
      const rNetOff = await runner.runCommand({
        cwd: worktree,
        argv: [process.execPath, '-e', `fetch('http://127.0.0.1:${port}').then(() => process.exit(0), () => process.exit(42))`],
        env: {},
        timeoutMs: 5000,
        capabilities: resolveCapabilities({ externalNetwork: 'off' }),
      });
      expect(rNetOff.status).toBe('ran');
      if (rNetOff.status === 'ran') expect(rNetOff.exitCode).toBe(42);

      // 6. 开启 externalNetwork: 'on' 后外联成功
      const rNetOn = await runner.runCommand({
        cwd: worktree,
        argv: [process.execPath, '-e', `fetch('http://127.0.0.1:${port}').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(2))`],
        env: {},
        timeoutMs: 5000,
        capabilities: resolveCapabilities({ externalNetwork: 'on' }),
      });
      expect(rNetOn.status).toBe('ran');
      if (rNetOn.status === 'ran') expect(rNetOn.exitCode).toBe(0);

      // 7. 脱离 Codex 直接运行 runCheck('build') 与 runCheck('test')（真 npm + node --test）
      const digest = await scriptsDigest(worktree);
      const bRes = await runCheck(worktree, 'build', runner, { authorizedDigest: digest });
      const tRes = await runCheck(worktree, 'test', runner, { authorizedDigest: digest });
      expect(bRes.status).toBe('passed');
      expect(tRes.status).toBe('passed');
      expect(await fs.readFile(path.join(worktree, 'built.txt'), 'utf8')).toBe('built-ok');

      // 8. 命令超时正确中止并返回 timedOut: true
      const rTimeout = await runner.runCommand({
        cwd: worktree,
        argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
        env: {},
        timeoutMs: 120,
      });
      expect(rTimeout.status).toBe('ran');
      if (rTimeout.status === 'ran') expect(rTimeout.timedOut).toBe(true);

      // 9. extraWritableDirs 允许写入，同时未包含在其中的主仓库仍被禁止
      const extraDir = path.join(realRoot, 'extra-out');
      await fs.mkdir(extraDir, { recursive: true });
      const extraFile = path.join(extraDir, 'extra.txt');
      const rExtra = await runner.runCommand({
        cwd: worktree,
        argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(extraFile)}, 'extra-ok')`],
        env: {},
        timeoutMs: 5000,
        capabilities: resolveCapabilities({ extraWritableDirs: [extraDir] }),
      });
      expect(rExtra.status).toBe('ran');
      if (rExtra.status === 'ran') expect(rExtra.exitCode).toBe(0);
      expect(await fs.readFile(extraFile, 'utf8')).toBe('extra-ok');
    },
    30_000,
  );
});

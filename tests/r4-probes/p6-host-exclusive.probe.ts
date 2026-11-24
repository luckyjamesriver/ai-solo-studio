/**
 * AISS-A1-TRUSTED-EVIDENCE-R4 / R4-01 反向探针：宿主安全（宿主独占目录 + 最终清理）。
 *
 * 同一探针在旧候选 6d7cc01 上必须失败，在新候选上必须通过。
 *
 * 旧候选仍把 Vitest 报告目录放在被测工作树的 `.studio/evidence/<nonce>/` 下，并在清理时
 * 走“路径复核 + unlink”的可变路径删除；父目录被替换成外部符号链接时外部文件被真实删除。
 * 新候选要求报告目录是**宿主独占目录**（工作树之外、mkdtemp 创建、executor 不可写），
 * 从根上消除“在不可信可变路径上做宿主删除”的攻击面，而不是增加检查次数。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { prepareVitestRun, cleanupVitestRun, readVitestReport } from '../../src/core/evidence/vitest.js';
import { createWorktree, removeWorktree } from '../../src/core/git/git.js';
import { tmpDir } from '../helpers.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
});
async function tmp(prefix: string): Promise<string> {
  const d = await tmpDir(prefix);
  dirs.push(d);
  return d;
}

describe('R4-01 探针 A：宿主不在可变工作树路径上删除报告目录（保守保留）', () => {
  it('cleanup 之后报告目录仍然存在；宿主没有任何递归删除入口', async () => {
    const root = await tmp('r4p6-root-');
    const plan = await prepareVitestRun(root, 'vitest run');
    expect(plan.reportDir.startsWith(root + path.sep)).toBe(true);
    await fs.writeFile(plan.reportPath, '{"testResults":[]}');
    await cleanupVitestRun(plan);
    // 旧候选：cleanup 删除报告目录；新候选：保守保留，随任务副本由 git worktree remove 回收
    await expect(fs.stat(plan.reportDir)).resolves.toBeTruthy();
    // 静态证据：cleanupVitestRun 不再包含 rm/removeOwnedDir 等删除调用
    const src = await fs.readFile(path.resolve(HERE, '../../src/core/evidence/vitest.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function cleanupVitestRun'), src.indexOf('export function sha256Text'));
    expect(body).not.toMatch(/\bfs\.rm\b|removeOwnedDir|rmdir|unlink/);
  });
});

describe('R4-01 探针 B：父目录被替换成外部符号链接后清理不得触碰外部文件', () => {
  it('外部哨兵与外部同名报告目录必须原样保留，保留的报告目录不被移动/删除', async () => {
    const root = await tmp('r4p6-b-root-');
    const outside = await tmp('r4p6-b-out-');
    const sentinel = path.join(outside, 'SENTINEL.txt');
    await fs.writeFile(sentinel, 'KEEP_ALIVE');

    const plan = await prepareVitestRun(root, 'vitest run');
    const decoyDir = path.join(outside, 'evidence', plan.nonce);
    await fs.mkdir(decoyDir, { recursive: true });
    const decoy = path.join(decoyDir, 'EXTERNAL_REPORT.txt');
    await fs.writeFile(decoy, 'OUTSIDE_MUST_SURVIVE');

    // 攻击：把工作树的 .studio 换成指向外部的符号链接
    await fs.rm(path.join(root, '.studio'), { recursive: true, force: true });
    await fs.symlink(outside, path.join(root, '.studio'), 'dir');

    await cleanupVitestRun(plan);

    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('KEEP_ALIVE');
    await expect(fs.readFile(decoy, 'utf8')).resolves.toBe('OUTSIDE_MUST_SURVIVE');
  });
});

describe('R4-01 探针 C：报告读取仍必须拒绝被替换的报告文件', () => {
  it('宿主目录中的报告被换成指向外部文件的符号链接 → invalid', async () => {
    const root = await tmp('r4p6-c-root-');
    const outside = await tmp('r4p6-c-out-');
    const plan = await prepareVitestRun(root, 'vitest run');
    const forged = path.join(outside, 'forged.json');
    await fs.writeFile(forged, '{"testResults":[]}');
    await fs.rm(plan.reportPath, { force: true });
    await fs.symlink(forged, plan.reportPath);
    const now = Date.now();
    const parsed = await readVitestReport(plan, { startMs: now - 10_000, endMs: now }, root);
    expect(parsed.status).not.toBe('ok');
    await cleanupVitestRun(plan);
    await expect(fs.readFile(forged, 'utf8')).resolves.toBe('{"testResults":[]}');
  });
});

describe('R4-01 探针 D：最终清理（任务副本）不得沿被替换的路径删除外部文件', () => {
  it('任务副本目录被替换成指向外部合法仓库的符号链接 → 拒绝清理，外部文件保留', async () => {
    const base = await tmp('r4p6-d-');
    const repo = path.join(base, 'repo');
    await fs.mkdir(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    await fs.writeFile(path.join(repo, 'index.html'), 'x\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
    const wt = await createWorktree(repo, '20240101000000-r4p6d');
    dirs.push(repo);

    // 外部“受害者”：另一个合法 git 仓库（含用户文件）
    const victim = path.join(base, 'victim');
    await fs.mkdir(victim);
    execFileSync('git', ['init', '-q', '-b', 'main', victim]);
    execFileSync('git', ['-C', victim, 'config', 'user.name', 't']);
    execFileSync('git', ['-C', victim, 'config', 'user.email', 't@t']);
    await fs.writeFile(path.join(victim, 'USER_DATA.txt'), 'PRECIOUS');
    execFileSync('git', ['-C', victim, 'add', '-A']);
    execFileSync('git', ['-C', victim, 'commit', '-qm', 'user']);

    // 攻击：把任务副本目录替换成指向受害者仓库的符号链接
    await fs.rm(wt.path, { recursive: true, force: true });
    await fs.symlink(victim, wt.path, 'dir');

    const r = await removeWorktree(repo, wt);
    // 旧/新候选都应由 git 的 worktree 归属校验拒绝（反证：这里本来就安全，不需要改产品代码）
    expect(r.ok).toBe(false);
    await expect(fs.readFile(path.join(victim, 'USER_DATA.txt'), 'utf8')).resolves.toBe('PRECIOUS');
    await expect(fs.stat(victim)).resolves.toBeTruthy();
  });
});


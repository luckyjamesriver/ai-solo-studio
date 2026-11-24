/**
 * AISS-A1-TRUSTED-EVIDENCE-R3-001 / R3-01 反向探针：宿主目录安全（真实 Node.js 路径语义）。
 *
 * 同一个探针必须在旧候选 9d1533f 上【失败】、在新候选上【通过】。
 * 只使用旧候选也存在的公开入口：prepareVitestRun / cleanupVitestRun。
 *
 * 攻击模型（ChatGPT 已独立复现）：报告目录合法创建后，父目录 .studio 被替换为指向外部位置的符号链接。
 * 旧实现 removeSafeSubtree 同时 realpath 父目录与目标目录，外部父子关系“自洽”，于是删除外部哨兵文件。
 * 修复要求：基于创建时固定的授权根与目录身份，不重新信任可被替换的父路径。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { prepareVitestRun, cleanupVitestRun, readVitestReport } from '../../src/core/evidence/vitest.js';
import { tmpDir } from '../helpers.js';

const dirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const d = await tmpDir(prefix);
  dirs.push(d);
  return d;
}

afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
});

/** 外部哨兵目录：位于被保护工作树之外，整个探针过程中必须零删除。 */
async function externalSentinel(prefix: string): Promise<{ dir: string; file: string; content: string }> {
  const dir = await tmp(prefix);
  const file = path.join(dir, 'EXTERNAL_SENTINEL.txt');
  const content = `KEEP_ALIVE_${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(file, content);
  return { dir, file, content };
}

async function assertSentinel(s: { file: string; content: string }): Promise<void> {
  await expect(fs.readFile(s.file, 'utf8')).resolves.toBe(s.content);
}

describe('R3-01 探针 A：.studio 父目录被替换为指向外部目录的符号链接', () => {
  it('清理不得删除外部目录里的任何文件（外部父子关系自洽也不可信）', async () => {
    const root = await tmp('r3p1-root-');
    const outside = await externalSentinel('r3p1-outside-');
    const plan = await prepareVitestRun(root, 'vitest run');

    // 外部目录里放一份与本次 nonce 同名的报告目录与哨兵文件：旧实现会把它们当作“受控子目录”删掉
    const externalReportDir = path.join(outside.dir, 'evidence', plan.nonce);
    await fs.mkdir(externalReportDir, { recursive: true });
    const externalReport = path.join(externalReportDir, 'EXTERNAL_REPORT.txt');
    await fs.writeFile(externalReport, 'OUTSIDE_MUST_SURVIVE');

    // 攻击：把 .studio 整体换成指向外部目录的符号链接
    await fs.rm(path.join(root, '.studio'), { recursive: true, force: true });
    await fs.symlink(outside.dir, path.join(root, '.studio'), 'dir');

    await cleanupVitestRun(plan);

    await assertSentinel(outside);
    await expect(fs.readFile(externalReport, 'utf8')).resolves.toBe('OUTSIDE_MUST_SURVIVE');
    // 外部目录本身也必须还在
    await expect(fs.stat(outside.dir)).resolves.toBeTruthy();
  });
});

describe('R3-01 探针 B：目录身份相同但路径已离开授权根（移动后符号链接指回）', () => {
  it('即使 dev/ino 与创建时一致，只要真实路径离开授权根就拒绝清理', async () => {
    const root = await tmp('r3p1-move-root-');
    const outside = await externalSentinel('r3p1-move-outside-');
    const plan = await prepareVitestRun(root, 'vitest run');
    const internalReport = path.join(plan.reportDir, 'INTERNAL_REPORT.txt');
    await fs.writeFile(internalReport, 'INTERNAL');

    // 攻击：把真正的 .studio 目录整体移出工作树，再用符号链接指回去。
    // 此时 .studio/evidence 的 dev/ino 与创建时完全相同——只靠身份校验仍会误删。
    await fs.rename(path.join(root, '.studio'), path.join(outside.dir, 'moved-studio'));
    await fs.symlink(path.join(outside.dir, 'moved-studio'), path.join(root, '.studio'), 'dir');

    await cleanupVitestRun(plan);

    await assertSentinel(outside);
    // 被移出授权根的原始报告内容不得被删除
    await expect(fs.readFile(internalReport, 'utf8')).resolves.toBe('INTERNAL');
  });
});

describe('R3-01 探针 C：.studio/evidence 被替换为外部符号链接（R2 场景回归）', () => {
  it('清理不得删除外部 evidence 目录内容', async () => {
    const root = await tmp('r3p1-ev-root-');
    const outside = await externalSentinel('r3p1-ev-outside-');
    const plan = await prepareVitestRun(root, 'vitest run');
    const externalReportDir = path.join(outside.dir, plan.nonce);
    await fs.mkdir(externalReportDir, { recursive: true });
    await fs.writeFile(path.join(externalReportDir, 'A.txt'), 'A');

    await fs.rm(path.join(root, '.studio', 'evidence'), { recursive: true, force: true });
    await fs.symlink(outside.dir, path.join(root, '.studio', 'evidence'), 'dir');

    await cleanupVitestRun(plan);
    await assertSentinel(outside);
    await expect(fs.readFile(path.join(externalReportDir, 'A.txt'), 'utf8')).resolves.toBe('A');
  });
});

describe('R3-01 探针 D：报告文件被换成指向外部文件的符号链接 / 硬链接', () => {
  it('读取必须拒绝符号链接报告，且清理只删链接本身、不触碰外部文件内容', async () => {
    const root = await tmp('r3p1-file-root-');
    const outside = await externalSentinel('r3p1-file-outside-');
    const plan = await prepareVitestRun(root, 'vitest run');

    // 用一个看起来合法、内容完整的报告替换成指向外部文件的符号链接
    const validReport = JSON.stringify({
      numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0,
      numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
      startTime: Date.now(), success: true,
      testResults: [{ name: path.join(root, 'tests', 'x.test.ts'), assertionResults: [
        { fullName: 'a', status: 'passed' }, { fullName: 'b', status: 'passed' },
      ] }],
    });
    const outsideReport = path.join(outside.dir, 'forged-report.json');
    await fs.writeFile(outsideReport, validReport);
    await fs.rm(plan.reportPath, { force: true });
    await fs.symlink(outsideReport, plan.reportPath);

    const now = Date.now();
    const parsed = await readVitestReport(plan, { startMs: now - 10_000, endMs: now }, root);
    expect(parsed.status).not.toBe('ok');

    await cleanupVitestRun(plan);
    await assertSentinel(outside);
    await expect(fs.readFile(outsideReport, 'utf8')).resolves.toBe(validReport);
  });
});

/**
 * AISS-A1-PREMERGE-GATE-CLOSEOUT-001 / §2 修订一反向探针（正常保存入口）：
 * 证据集合裁决必须发生在 `git merge --ff-only` 写入主项目之前。
 *
 * 场景（真实 Git + 真实 Vitest + 真实保存入口）：
 *  - 验收通过（build/test 均 verified），用户逐条确认；
 *  - 保存开始时真实试合并 + 真实试检查都通过（`checked=true`）；
 *  - 在「写入前再确认一次」的时刻，外部进程移动了隐藏的试合并副本目录（真实 TOCTOU，
 *    等价于宿主路径身份在试检查之后、写入之前发生变化）；
 *  - 于是 `adjudicateTrialEvidenceSet` 的副本身份核对必然失败。
 *
 * 旧候选：集合裁决在写入之后才执行 → 主项目 HEAD 已被改写，且结果被静默降级为“未检查”，
 *        调用方没有做过任何未检查确认。
 * 新候选：集合裁决在写入之前执行 → 直接阻断，主项目 HEAD/tree/工作区保持不变，不落保存记录。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { TaskController } from '../../src/core/app/task-controller.js';
import { TaskPrefs } from '../../src/core/app/prefs.js';
import { FakeExecutor } from '../../src/core/executor/adapters/fake.js';
import { RecordStore } from '../../src/core/persistence/index.js';
import type { SaveProgressEvent } from '../../src/core/task/model.js';
import { git, makeRepo, testSandboxRunner, tmpDir, useRealVitest } from '../helpers.js';

const cleanDirs: string[] = [];
afterEach(async () => {
  await RecordStore.closeAll().catch(() => undefined);
  while (cleanDirs.length > 0) await fsp.rm(cleanDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
});
async function temp(prefix: string): Promise<string> {
  const d = await tmpDir(prefix);
  cleanDirs.push(d);
  return d;
}
async function until<T>(fn: () => Promise<T | false | undefined>, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function headOf(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}
async function treeOfHead(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', 'HEAD^{tree}'])).trim();
}
async function porcelain(repo: string): Promise<string> {
  return (await git(repo, ['status', '--porcelain'])).trim();
}

/** 找到当前的试合并临时副本目录（位于 <repo>/.studio/trials/<taskId>-<随机>）。 */
function trialDirs(repo: string): string[] {
  const root = path.join(repo, '.studio', 'trials');
  try {
    return fs.readdirSync(root)
      .filter((n) => !n.endsWith('.moved'))
      .map((n) => path.join(root, n));
  } catch {
    return [];
  }
}

describe('CLOSEOUT-01 修订一：集合裁决必须在写入主项目之前（正常保存入口）', () => {
  it('试检查后副本身份失效 → 未经任何未检查确认，不得改写主项目 HEAD/tree/工作区', async () => {
    const repo = await makeRepo({ 'index.html': '<h1>old</h1>\n' });
    await useRealVitest(repo);
    const preHead = await headOf(repo);
    const preTree = await treeOfHead(repo);
    expect(await porcelain(repo)).toBe('');

    const data = await temp('closeout-p16-data-');
    let mutated = false;
    let moved: { from: string; to: string } | undefined;
    const onSaveProgress = (ev: SaveProgressEvent): void => {
      const finalVerify = ev.saveSteps.find((s) => s.key === 'final_verify');
      if (mutated || finalVerify?.status !== 'running') return;
      const dirs = trialDirs(repo);
      if (dirs.length === 0) return;
      // 真实宿主路径身份变化：把试合并副本整个移走（等价于外部进程在保存窗口内移动/替换副本）
      const from = dirs[dirs.length - 1]!;
      const to = `${from}.moved`;
      fs.renameSync(from, to);
      // 再把原路径替换成指向新位置的符号链接：宿主对“副本真实路径”的核对会得到不同身份
      fs.symlinkSync(to, from);
      moved = { from, to };
      mutated = true;
    };
    const ctl = new TaskController({
      repo,
      makeExecutor: () => {
        const ex = new FakeExecutor([
          { do: 'write' as const, path: 'index.html', content: '<h1>p16</h1>\n' },
          { do: 'exit' as const, code: 0 },
        ]);
        (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = testSandboxRunner();
        return ex;
      },
      pickDirectory: async () => null,
      prefs: new TaskPrefs(data),
      onSaveProgress,
    });

    try {
      const created = await ctl.create('改标题');
      await ctl.savePlan(created.id, { goal: '改标题', criteria: ['标题已更新'], mode: 'standard', network: false });
      await ctl.start(created.id, false);
      let view = await until(async () => {
        const v = await ctl.getAcceptanceView(created.id);
        return v.state === 'reviewing' && !v.busy ? v : false;
      });
      expect(view.items.find((i) => i.key === 'test')!.status).toBe('verified');
      expect(view.scopeChange).toBeNull();
      for (const c of view.criteria) view = (await ctl.confirmCriterion(created.id, c.id, view.version)).view;
      for (const d of view.denied) view = (await ctl.ackDenied(created.id, d.id, view.version)).view;

      // 正常保存入口：没有 confirmUnchecked，没有任何“未检查也保存”的授权
      const res = await ctl.saveTask(created.id, view.version);
      expect(mutated).toBe(true); // 探针确实在保存窗口内触发了身份变化

      // 新候选：集合裁决在写入前 → 主项目完全没被改动（旧候选会先写入，HEAD 已被改写）
      expect(await headOf(repo)).toBe(preHead);
      expect(await treeOfHead(repo)).toBe(preTree);
      expect(await porcelain(repo)).toBe('');
      expect(res.ok).toBe(false);

      const raw = (await ctl.listTasksRaw()).find((t) => t.id === created.id)!;
      expect(raw.saveRecord).toBeUndefined();
      expect(raw.state).not.toBe('saved');
      expect(raw.lastSave?.reason).not.toBe('saved');
      // 也不能被静默登记成“未检查已保存”
      expect(raw.saveRecord?.checked).not.toBe(false);
    } finally {
      if (moved) {
        await fsp.rm(moved.from, { force: true, recursive: true }).catch(() => undefined);
        if (await fsp.stat(moved.to).then(() => true, () => false).catch(() => false)) {
          await fsp.rename(moved.to, moved.from).catch(() => undefined);
        }
      }
    }
  }, 180_000);
});

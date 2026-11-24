/**
 * AISS-A1-PREMERGE-GATE-CLOSEOUT-001 / §2 修订一反向探针（未检查确认不得绕过硬阻断）：
 *
 * 场景（真实 Git + 真实保存入口）：
 *  - 受限检查不可用 → 验收与试检查都是“未检查”，用户走原有明确确认机制（saveUncheckedTask）；
 *  - 在「写入前再确认一次」的时刻，试合并副本被外部移走 → 证据副本身份失效。
 *
 * 旧候选：人工未检查确认被当成万能放行 → 主项目 HEAD 被改写，并落一条“未检查”保存记录。
 * 新候选：身份失效属于既定硬阻断，即使带 confirmUnchecked 也不能绕过；主项目保持原样。
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
import type { SandboxCommandRunner } from '../../src/core/checks/scripts.js';
import { git, makeRepo, realVitestScript, tmpDir } from '../helpers.js';

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

describe('CLOSEOUT-01 修订一：未检查确认只放行“未检查”，不得绕过身份失效', () => {
  it('confirmUnchecked 保存期间副本身份失效 → 仍不得改写主项目', async () => {
    const repo = await makeRepo({
      'index.html': '<h1>old</h1>\n',
      'package.json': JSON.stringify({ name: 'closeout-p17', scripts: { test: realVitestScript() } }),
      'tests/base.test.ts': "import { describe, it, expect } from 'vitest';\ndescribe('base', () => { it('ok', () => { expect(1).toBe(1); }); });\n",
    });
    const preHead = await headOf(repo);
    const preTree = await treeOfHead(repo);

    const data = await temp('closeout-p17-data-');
    let armed = false;
    let mutated = false;
    let moved: { from: string; to: string } | undefined;
    const onSaveProgress = (ev: SaveProgressEvent): void => {
      if (!armed || mutated) return;
      const finalVerify = ev.saveSteps.find((s) => s.key === 'final_verify');
      if (finalVerify?.status !== 'running') return;
      const dirs = trialDirs(repo);
      if (dirs.length === 0) return;
      const from = dirs[dirs.length - 1]!;
      const to = `${from}.moved`;
      fs.renameSync(from, to);
      // 再把原路径替换成指向新位置的符号链接：宿主对“副本真实路径”的核对会得到不同身份
      fs.symlinkSync(to, from);
      moved = { from, to };
      mutated = true;
    };
    const unavailable: SandboxCommandRunner = { runCommand: async () => ({ status: 'unavailable', reason: 'sandbox unavailable (probe)' }) };
    const ctl = new TaskController({
      repo,
      makeExecutor: () => {
        const ex = new FakeExecutor([
          { do: 'write' as const, path: 'index.html', content: '<h1>p17</h1>\n' },
          { do: 'exit' as const, code: 0 },
        ]);
        (ex as unknown as { sandboxRunner: unknown }).sandboxRunner = unavailable;
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
      for (const c of view.criteria) view = (await ctl.confirmCriterion(created.id, c.id, view.version)).view;
      for (const d of view.denied) view = (await ctl.ackDenied(created.id, d.id, view.version)).view;

      // 第一次：未检查 → 必须先返回待确认，不写主项目
      const first = await ctl.saveTask(created.id, view.version);
      expect(first.ok).toBe(false);
      expect(first.view.saveOutcome?.kind).toBe('unchecked_needs_confirm');
      expect(await headOf(repo)).toBe(preHead);

      // 第二次：用户明确确认未检查仍要保存，但在保存窗口内副本身份失效
      armed = true;
      const res = await ctl.saveUncheckedTask(created.id, view.version);
      expect(mutated).toBe(true);

      // 新候选：身份失效是硬阻断，confirmUnchecked 不能绕过（旧候选会写入主项目并落未检查保存记录）
      expect(await headOf(repo)).toBe(preHead);
      expect(await treeOfHead(repo)).toBe(preTree);
      expect(await porcelain(repo)).toBe('');
      expect(res.ok).toBe(false);
      const raw = (await ctl.listTasksRaw()).find((t) => t.id === created.id)!;
      expect(raw.saveRecord).toBeUndefined();
      expect(raw.state).not.toBe('saved');
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

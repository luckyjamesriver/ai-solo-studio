import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodexExecutor } from '../../src/core/executor/adapters/codex.js';
import { TaskRunner, type PendingPermission } from '../../src/core/task/runner.js';
import * as G from '../../src/core/git/git.js';
import { realEnabled } from './gate.js';

/**
 * M3-B4-1：真实 Codex 端到端（改标题 → 生成验收证据 → 确认 → 保存 → 主项目可见改动 → 撤销 → 恢复原标题）。
 * 默认跳过；经 `npm run test:real`，套件名 b4-1（见 gate.ts）。模型回合上限 2 次（本测试只发起 1 次：施工）；
 * 只发送临时测试仓库里的内容；验收检查（npm test）经 Codex 的 command/exec 运行，不经模型。
 * 测试仓库放在 ~/ai-solo-studio-b4-probe/（测试创建、结束删除）；仓库里同样配置一个 hooksPath 钩子作为哨兵，全程不得触发。
 * 仅在受限执行环境无法写入 home 时，可用 STUDIO_B4_PROBE_ROOT 指向别处（该路径必须尚不存在）。
 * 原始记录写入 ~/AI-CoWork-rebuild-import/b4-1-events/。
 */
const enabled = realEnabled('b4-1');
const MODEL_TURN_LIMIT = 2;

const root = process.env.STUDIO_B4_PROBE_ROOT ?? path.join(os.homedir(), 'ai-solo-studio-b4-probe');
const logDir = path.join(os.homedir(), 'AI-CoWork-rebuild-import', 'b4-1-events');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-checkout', 'post-merge', 'pre-merge-commit'];

let repo = '';
let sentDir = '';
const sentinels = () => fs.readdirSync(sentDir).sort();
const titleOf = () => /<title>(.*?)<\/title>/.exec(fs.readFileSync(path.join(repo, 'index.html'), 'utf8'))?.[1];

describe.skipIf(!enabled)('M3-B4-1：真实 Codex 端到端（保存 → 撤销）', () => {
  beforeAll(async () => {
    if (fs.existsSync(root)) throw new Error(`${root} 已存在，为避免删除不属于本测试的内容而中止；请先确认并手动删除。`);
    fs.mkdirSync(path.join(root, 'repo'), { recursive: true });
    repo = fs.realpathSync(path.join(root, 'repo'));
    sentDir = path.join(root, 'sentinels');
    const hooksDir = path.join(root, 'hooks');
    fs.mkdirSync(sentDir);
    fs.mkdirSync(hooksDir);
    fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html>\n<html><head><title>Old Title</title></head><body><h1>Demo</h1></body></html>\n');
    fs.writeFileSync(path.join(repo, 'test.js'), "const fs = require('fs');\nconst m = /<title>(.*?)<\\/title>/.exec(fs.readFileSync('index.html', 'utf8'));\nif (!m || !m[1] || m[1] === 'Old Title') { console.error('title not updated'); process.exit(1); }\nconsole.log('ok: ' + m[1]);\n");
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'b4-demo', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2));
    await G.initRepo(repo);
    // 哨兵：hooksPath 指向一组会写哨兵文件的钩子（只写这个测试仓库自己的 .git/config）
    for (const h of HOOKS) {
      const p = path.join(hooksDir, h);
      fs.writeFileSync(p, `#!/bin/sh\n: > "${path.join(sentDir, h)}"\nexit 0\n`);
      fs.chmodSync(p, 0o755);
    }
    execFileSync('git', ['config', 'core.hooksPath', hooksDir], { cwd: repo, env: GIT_ENV });
  }, 60_000);
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('改标题 → 验收证据 → 确认 → 保存 → 主项目可见 → 撤销 → 恢复；哨兵全程未触发；权限确认 0 次', async () => {
    const executor = new CodexExecutor();
    const env = await executor.detect();
    expect(env.installed, `Codex 未安装：${env.note ?? ''}`).toBe(true);
    expect(env.loggedIn, `Codex 未登录：${env.note ?? ''}`).toBe('yes');

    const runner = new TaskRunner({ repo, executor, runChecks: true, timeoutMs: 5 * 60_000 });
    const permissions: PendingPermission[] = [];
    runner.on('permission', (p: PendingPermission) => {
      permissions.push(p); // 期望为 0；万一出现，拒绝并记录，不替用户放行
      void runner.respond(p.taskId, p.request.id, 'deny');
    });

    const t0 = await runner.create('把页面标题改成 B4 Title');
    await runner.setPlan(t0.id, {
      goal: '把 index.html 的标题改成 B4 Title',
      inScope: ['把 index.html 里 <title> 的文字改成 B4 Title'],
      outOfScope: ['其他文件', '不要提交 Git'],
      criteria: ['页面标题是 B4 Title'],
      risks: [],
      irreversible: [],
    });
    await runner.approve(t0.id);
    const headBefore = await G.headSha(repo);

    const modelTurns = 1; // 施工 = 1 次模型回合（runner.start 只发起一次；检查走 command/exec，不经模型）
    expect(modelTurns).toBeLessThanOrEqual(MODEL_TURN_LIMIT);
    const t = await runner.start(t0.id);

    const log: Record<string, unknown> = {
      repo,
      timelineIsolation: t.timeline.filter((e) => e.kind === 'isolation').map((e) => e.text),
      exit: t.exit,
      denied: t.denied,
      changes: t.card?.changes,
      items: t.card?.items.map((i) => ({ key: i.key, status: i.status, evidence: i.evidence })),
      acceptedTree: t.acceptedTree,
      checksVoid: t.checksVoid,
      notes: t.card?.notes,
      sentinelsAfterReview: sentinels(),
    };
    const save = (name: string, data: unknown) => {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, `${name}.json`), JSON.stringify(data, null, 2));
      console.info(`B4-1 ${name} ${JSON.stringify(data)}`);
    };

    try {
      expect(t.state).toBe('reviewing');
      expect(t.exit).toEqual({ kind: 'exited', code: 0 });
      expect(t.acceptedTree).toMatch(/^[0-9a-f]{40}$/);
      expect(t.card?.changes.map((c) => c.path)).toContain('index.html');
      expect(t.card?.notes).toEqual(['为保证安全，保存时没有运行项目自定义的提交检查。']); // hooksPath 已设置 → 如实说明
      expect(sentinels()).toEqual([]);
      expect(titleOf()).toBe('Old Title'); // 保存之前主项目没有变化

      await runner.confirm(t0.id, { criterion: 0, decision: 'confirmed' });
      const saved = await runner.save(t0.id);
      log.save = saved.ok ? { ok: true, message: saved.message, record: saved.task.saveRecord } : saved;
      expect(saved.ok, JSON.stringify(saved)).toBe(true);
      expect(titleOf()).toBe('B4 Title'); // 主项目可见改动
      expect(sentinels()).toEqual([]);

      const undone = await runner.undo(t0.id);
      log.undo = undone.ok ? { ok: true, message: undone.message } : undone;
      expect(undone.ok, JSON.stringify(undone)).toBe(true);
      expect(titleOf()).toBe('Old Title'); // 主项目恢复原标题
      expect(await G.isClean(repo)).toBe(true);
      expect(await G.headSha(repo)).not.toBe(headBefore); // 撤销是新提交，不改写历史
      expect(sentinels()).toEqual([]);
      expect(permissions).toHaveLength(0);
    } finally {
      log.sentinelsAtEnd = sentinels();
      log.permissionConfirmations = permissions.length;
      log.modelTurns = modelTurns;
      save('end-to-end', log);
    }
  }, 600_000);
});

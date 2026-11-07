import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EXIT, runCli } from '../../src/core/thinking/cli/index.js';
import { ThreadStore } from '../../src/core/thinking/flow/index.js';
import { tmpDir } from '../helpers.js';
import { makeProject } from '../flow-helpers.js';

/**
 * 真实流程集成（默认跳过）：dev-personal 预设（ClaudeCli 规划 + Codex 评审）跑一个很小的需求，
 * 走到导出任务文件为止。确认点由测试脚本以“接受”应答；不执行导出的任务。
 * 会向 Anthropic 与 OpenAI 发送资料，并消耗本机订阅额度，所以必须显式开启：
 *   STUDIO_DEV_PERSONAL_CLAUDE=1 STUDIO_REAL_FLOW=1 npx vitest run tests/integration/think-flow.real.test.ts
 */
describe.skipIf(process.env.STUDIO_REAL_FLOW !== '1' || process.env.STUDIO_DEV_PERSONAL_CLAUDE !== '1')('真实思考流程（dev-personal）', () => {
  it('小需求走到导出任务文件', async () => {
    const root = await makeProject();
    const exportDir = await tmpDir('studio-export-real-');
    const out: string[] = [];
    const io = {
      print: (t: string) => void out.push(t),
      ask: async (p: string) => {
        out.push(`[应答] ${p}`);
        if (/首次向该服务/.test(p)) return 'y';
        if (p.startsWith('> ')) return ''; // 回车 = 原样接受条目
        if (/a = 接受/.test(p)) return 'a';
        if (/用一句话写理由/.test(p)) return '测试脚本：接受';
        if (/y = 批准/.test(p)) return 'y';
        return '';
      },
    };
    const code = await runCli(['在 README 里加一行说明：本项目使用 MIT 许可证。', '--task', 'REAL-1', '--export-dir', exportDir, '--max-calls', '8', '--max-total', '900'], { cwd: root, isTTY: true, io });
    console.info(out.join('\n'));
    const store = new ThreadStore(root);
    const id = (await store.list())[0]!;
    const rec = await store.load(id);
    const cost = rec.attempts.reduce((s, a) => s + (a.usage?.costUsd ?? 0), 0);
    console.info(`[real-flow] exit=${code} state=${rec.state} calls=${rec.attempts.length} models=${JSON.stringify([...new Set(rec.attempts.map((a) => `${a.thinkerId}:${a.model ?? '?'}`))])} claudeCostUsd=${cost.toFixed(4)} statuses=${JSON.stringify(rec.attempts.map((a) => `${a.step}#${a.n}:${a.status}`))}`);
    expect(code).toBe(EXIT.ok);
    expect(rec.state).toBe('task_exported');
    expect((await fs.readFile(path.join(exportDir, 'REAL-1-task.md'), 'utf8')).split('\n')[0]).toBe('任务编号：REAL-1');
  }, 15 * 60_000);
});

import type { FlowUI } from '../flow/index.js';

export interface IO {
  ask(prompt: string): Promise<string>;
  print(text: string): void;
}

/** 没有 TTY：每一个需要用户确认的点都返回 undefined → 引擎停止并保存线程，绝不默认通过。 */
export function nonInteractiveUI(print: (t: string) => void): FlowUI & { confirmReplaceCurrent: (firstLine: string) => Promise<boolean> } {
  return {
    notify: print,
    confirmSend: async () => undefined,
    confirmRequirements: async () => undefined,
    onAttemptFailed: async () => undefined,
    adjudicate: async () => undefined,
    approve: async () => undefined,
    confirmReplaceCurrent: async () => false,
  };
}

const yes = (s: string) => /^(y|yes|是|好|确认)$/i.test(s.trim());

export function ttyUI(io: IO): FlowUI & { confirmReplaceCurrent: (firstLine: string) => Promise<boolean> } {
  return {
    notify: io.print,

    async confirmSend(service) {
      io.print(`\n⚠ 资料将离开本机，发往：${service}`);
      return yes(await io.ask('首次向该服务发送，确认继续？(y/N) '));
    },

    async confirmRequirements(items) {
      let cur = items.map((i) => ({ id: i.id as string | undefined, text: i.text }));
      const show = () => {
        io.print('\n需求条目（确认后冻结，之后只有你能改）：');
        for (const c of cur) io.print(`  ${c.id ?? '(新)'}：${c.text}`);
        io.print('命令：回车 = 原样接受 | a <文字> 新增 | d <ID> 删除 | e <ID> <文字> 修改 | ok 完成');
      };
      show();
      for (;;) {
        const line = (await io.ask('> ')).trim();
        if (line === '' || line === 'ok') return cur;
        const m = line.match(/^(a|d|e)\s+(.*)$/s);
        if (!m) {
          io.print('没看懂。');
          continue;
        }
        if (m[1] === 'a') cur.push({ id: undefined, text: m[2]!.trim() });
        else if (m[1] === 'd') cur = cur.filter((c) => c.id !== m[2]!.trim());
        else {
          const em = m[2]!.match(/^(\S+)\s+(.+)$/s);
          const target = em && cur.find((c) => c.id === em[1]);
          if (!em || !target) {
            io.print('用法：e <ID> <新文字>（ID 必须存在）');
            continue;
          }
          target.text = em[2]!.trim();
        }
        show();
      }
    },

    async onAttemptFailed({ step, attempt }) {
      io.print(`\n✘ 步骤 ${step} 第 ${attempt.n} 次尝试没有完成：${attempt.status}${attempt.error ? `（${attempt.error}）` : ''}`);
      io.print('已有的正式产物都保留着。不会自动重试，也不会自动换模型。');
      for (;;) {
        const a = (await io.ask('选择：1 重试  2 补充说明后重试  3 终止线程 > ')).trim();
        if (a === '1') return 'retry';
        if (a === '2') {
          const note = (await io.ask('补充说明：')).trim();
          if (note) return { retryWith: note };
        }
        if (a === '3') return 'stop';
      }
    },

    async adjudicate(q) {
      io.print(`\n— 需要你裁决 —\n${q.summary}\n${q.detail}`);
      for (;;) {
        const d = (await io.ask('a = 接受  r = 驳回 > ')).trim().toLowerCase();
        if (d !== 'a' && d !== 'r') continue;
        const reason = (await io.ask('用一句话写理由：')).trim();
        if (!reason) {
          io.print('必须写理由。');
          continue;
        }
        return { decision: d === 'a' ? 'accept' : 'reject', reason };
      }
    },

    async approve(ctx) {
      io.print('\n====== 待批准的方案 ======');
      io.print(ctx.planPreview.length > 4000 ? ctx.planPreview.slice(0, 4000) + '\n……（已截断，完整内容见线程目录）' : ctx.planPreview);
      io.print(ctx.independentReview ? '\n独立评审：已完成。' : '\n⚠ 未经独立评审（单思考者模式）。');
      if (ctx.checks.scopeDiffs.length) io.print(`范围差异 ${ctx.checks.scopeDiffs.length} 项（已逐项裁决）。`);
      if (!ctx.canApprove) {
        io.print('\n不能批准：');
        for (const b of ctx.blockedBecause) io.print(`  - ${b}`);
        for (;;) {
          const a = (await io.ask('n = 否决  s = 终止 > ')).trim().toLowerCase();
          if (a === 'n') return 'reject';
          if (a === 's') return 'stop';
        }
      }
      for (;;) {
        const a = (await io.ask('y = 批准  n = 否决  s = 终止 > ')).trim().toLowerCase();
        if (a === 'y') return 'approve';
        if (a === 'n') return 'reject';
        if (a === 's') return 'stop';
      }
    },

    async confirmReplaceCurrent(firstLine) {
      io.print(`\n导出目录里已有 next-task.md，首行是：${firstLine}`);
      return yes(await io.ask('用新任务替换它？旧文件会另存为 <旧编号>-task.md (y/N) '));
    },
  };
}

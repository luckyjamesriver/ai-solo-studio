import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import {
  FakeThinker,
  CodexThinker,
  ClaudeCliThinker,
  ClaudeApiThinker,
  DEFAULT_CLAUDE_API_MODEL,
  ANTHROPIC_API_VERSION,
  claudeCliArgs,
  buildThinkPrompt,
  parseStructured,
  classifyServiceError,
  DEV_PERSONAL_ENV,
  type OutputSchema,
  type ThinkRequest,
} from '../src/core/thinking/index.js';
import { tmpDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_APP = path.join(here, 'fixtures', 'fake-app-server.mjs');
const FAKE_CLAUDE = path.join(here, 'fixtures', 'fake-claude-cli.mjs');

const schema: OutputSchema = {
  type: 'object',
  required: ['verdict', 'points'],
  properties: { verdict: { type: 'string', enum: ['ok', 'block'] }, points: { type: 'array', items: { type: 'string' } } },
};
const req = (over: Partial<ThinkRequest> = {}): ThinkRequest => ({
  role: 'reviewer',
  system: '你是评审者，职责是找错，不是求共识。',
  context: { required: [{ name: 'PROJECT_CONTEXT.md', text: '目标：验收与恢复' }], optional: [{ name: '任务.md', text: '加深色模式' }] },
  task: '评审这个方案',
  output: schema,
  ...over,
});

describe('结构化解析', () => {
  it('纯 JSON、被围栏或文字包裹的 JSON 都能解析', () => {
    expect(parseStructured('{"verdict":"ok","points":["a"]}', schema)).toMatchObject({ ok: true });
    expect(parseStructured('结论如下：\n```json\n{"verdict":"block","points":[]}\n```', schema)).toMatchObject({ ok: true });
    expect(parseStructured('前言 {"verdict":"ok","points":["含}括号"]} 后记', schema)).toMatchObject({ ok: true });
  });
  it('没有 JSON / 缺字段 / 类型或取值不对 → 失败（调用方应标为 incomplete）', () => {
    expect(parseStructured('没有结构', schema)).toMatchObject({ ok: false });
    expect(parseStructured('{"verdict":"ok"}', schema)).toMatchObject({ ok: false, error: expect.stringContaining('points') });
    expect(parseStructured('{"verdict":"maybe","points":[]}', schema)).toMatchObject({ ok: false });
    expect(parseStructured('{"verdict":"ok","points":[1]}', schema)).toMatchObject({ ok: false });
  });
  it('提示词：发送清单记录名称与字节数，并声明没有工具', () => {
    const { prompt, sent } = buildThinkPrompt(req());
    expect(sent.find((s) => s.name === 'PROJECT_CONTEXT.md')).toEqual({ name: 'PROJECT_CONTEXT.md', bytes: Buffer.byteLength('目标：验收与恢复'), layer: 'required' });
    expect(sent.find((s) => s.name === '任务.md')?.layer).toBe('optional');
    expect(sent.map((s) => s.layer)).toEqual(expect.arrayContaining(['system', 'required', 'optional', 'task']));
    expect(prompt).toMatch(/你没有任何工具/);
    expect(prompt).toContain('目标：验收与恢复');
  });
});

describe('错误分类', () => {
  it.each([
    ['Not logged in · Please run /login', 'auth_error'],
    ['Invalid API key', 'auth_error'],
    ["You've hit your weekly limit · resets Mon", 'quota_exhausted'],
    ["You've hit your usage limit", 'quota_exhausted'],
    ['Credit balance is too low', 'quota_exhausted'],
    ['API Error: Request rejected (429)', 'rate_limited'],
    ['Server is temporarily limiting requests', 'rate_limited'],
  ])('%s → %s', (text, want) => expect(classifyServiceError(text)).toBe(want));
  it('无法归类 → undefined', () => expect(classifyServiceError('something odd')).toBeUndefined());
});

describe('FakeThinker', () => {
  it('complete：结构化内容、模型、用量、发送清单、服务名', async () => {
    const t = new FakeThinker([{ raw: '{"verdict":"ok","points":["x"]}', model: 'm1', usage: { inputTokens: 5 } }]);
    const r = await t.think(req());
    expect(r).toMatchObject({ status: 'complete', content: { verdict: 'ok', points: ['x'] }, model: 'm1', usage: { inputTokens: 5 }, service: 'fake-service' });
    expect(r.sent.length).toBeGreaterThan(3);
  });
  it('解析失败 → incomplete，没有 content，不得当作正式产物', async () => {
    const r = await new FakeThinker([{ raw: '随便说说' }]).think(req());
    expect(r.status).toBe('incomplete');
    expect(r.content).toBeUndefined();
    expect(r.rawText).toBe('随便说说');
  });
  it.each(['failed', 'rate_limited', 'quota_exhausted', 'auth_error', 'timeout'] as const)('状态 %s', async (status) => {
    const r = await new FakeThinker([{ status, error: 'e' }]).think(req());
    expect(r).toMatchObject({ status, error: 'e' });
    expect(r.content).toBeUndefined();
  });
  it('请求资料清单如实记录；思考者记录收到的请求', async () => {
    const t = new FakeThinker([{ raw: '{"verdict":"ok","points":[]}' }]);
    await t.think(req({ context: { required: [{ name: 'a.md', text: 'xx' }] } }));
    expect(t.requests).toHaveLength(1);
    expect((await t.think(req({ context: { required: [{ name: 'a.md', text: 'xx' }] } }))).sent.filter((s) => s.layer !== 'system' && s.layer !== 'task')).toEqual([{ name: 'a.md', bytes: 2, layer: 'required' }]);
  });
});

describe('CodexThinker（假 app-server）', () => {
  const make = (script: unknown[], extraEnv: Record<string, string> = {}, o: { timeoutMs?: number } = {}) => {
    const rec = path.join(os.tmpdir(), `think-rec-${Math.random().toString(36).slice(2)}.jsonl`);
    const thinker = new CodexThinker({
      command: process.execPath,
      prefixArgs: [FAKE_APP],
      env: { FAKE_APP_SCRIPT: JSON.stringify(script), FAKE_RECORD: rec, FAKE_MCP_CONFIGURED: '[]', ...extraEnv },
      discoverMcpServers: async () => [],
      mcpSettleMs: 50,
      interruptGraceMs: 300,
      killGraceMs: 200,
    });
    const records = () => (fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    return { thinker, records, timeoutMs: o.timeoutMs };
  };

  it('参数：只读沙箱、每条命令询问、网络关闭、全部扩展关闭；工作目录是用完即删的空临时目录', async () => {
    const { thinker, records } = make([{ say: '{"verdict":"ok","points":["p"]}' }, { complete: { status: 'completed' } }]);
    const r = await thinker.think(req());
    expect(r).toMatchObject({ status: 'complete', content: { verdict: 'ok' }, model: 'fake-model', service: expect.stringContaining('OpenAI') });
    const rec = records();
    const argv = rec.find((x) => x.kind === 'argv')!.argv as string[];
    expect(argv).toEqual(expect.arrayContaining(['sandbox_mode="read-only"', 'notify=[]', 'web_search="disabled"', 'allow_login_shell=false', '--disable', 'hooks', 'memories', 'plugins', 'apps']));
    const msg = (m: string) => rec.find((x) => x.kind === 'recv' && x.msg.method === m)!.msg.params;
    expect(msg('thread/start')).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'untrusted', ephemeral: true });
    expect(msg('turn/start')).toMatchObject({ sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'untrusted' });
    const cwd = msg('thread/start').cwd as string;
    expect(path.basename(cwd)).toMatch(/^studio-think-/);
    expect(fs.existsSync(cwd)).toBe(false); // 用完即删
    expect(msg('turn/start').input[0].text).toContain('你没有任何工具');
  });

  it('思考者请求工具/审批 → 一律拒绝并记录（refusedToolRequests）', async () => {
    const { thinker, records } = make([{ askCommand: { command: '/bin/zsh -lc "ls /"', cwd: '/x' } }, { say: '{"verdict":"ok","points":[]}' }, { complete: { status: 'completed' } }]);
    const r = await thinker.think(req());
    expect(records().filter((x) => x.kind === 'decision').map((x) => x.result)).toEqual([{ decision: 'decline' }]);
    expect(r.refusedToolRequests?.join()).toMatch(/run_command.*ls/);
    expect(r.status).toBe('complete');
  });

  it('回复不是合法结构 → incomplete', async () => {
    const { thinker } = make([{ say: '我觉得挺好的' }, { complete: { status: 'completed' } }]);
    const r = await thinker.think(req());
    expect(r.status).toBe('incomplete');
    expect(r.content).toBeUndefined();
  });

  it('隔离无法确认 → 不开始，failed 并说明', async () => {
    const { thinker, records } = make([{ complete: { status: 'completed' } }], { FAKE_IGNORE: 'hooks' });
    const r = await thinker.think(req());
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/隔离无法确认/);
    expect(records().some((x) => x.kind === 'recv' && x.msg.method === 'turn/start')).toBe(false);
  });

  it('额度用尽 / 频率限制 / 未登录 → 对应状态', async () => {
    for (const [msg, want] of [["You've hit your usage limit", 'quota_exhausted'], ['429 Too Many Requests', 'rate_limited'], ['Not logged in', 'auth_error']] as const) {
      const { thinker } = make([{ complete: { status: 'failed', error: msg } }]);
      expect((await thinker.think(req())).status).toBe(want);
    }
  });

  it('超时 → timeout', async () => {
    const { thinker } = make([{ hang: {} }]);
    expect((await thinker.think(req({ timeoutMs: 400 }))).status).toBe('timeout');
  });
});

describe('ClaudeCliThinker（假 claude）', () => {
  const make = (mode: string, o: { env?: Record<string, string>; isPackaged?: boolean; timeoutMs?: number } = {}) => {
    const rec = path.join(os.tmpdir(), `claude-rec-${Math.random().toString(36).slice(2)}.jsonl`);
    const thinker = new ClaudeCliThinker({
      command: process.execPath,
      prefixArgs: [FAKE_CLAUDE],
      env: { FAKE_CLAUDE: mode, FAKE_CLAUDE_RECORD: rec, [DEV_PERSONAL_ENV]: '1', ...(o.env ?? {}) },
      isPackaged: () => o.isPackaged ?? false,
      timeoutMs: o.timeoutMs ?? 5000,
    });
    return { thinker, records: () => (fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
  };

  it('开关：未设环境变量 → 不可用；设为其他值 → 不可用；打包环境 → 一律不可用（即使设了）；think() 同样拒绝', async () => {
    expect((await make('ok', { env: { [DEV_PERSONAL_ENV]: '' } }).thinker.detect())).toMatchObject({ available: false, note: expect.stringContaining(DEV_PERSONAL_ENV) });
    expect((await make('ok', { env: { [DEV_PERSONAL_ENV]: 'true' } }).thinker.detect()).available).toBe(false);
    const packaged = make('ok', { isPackaged: true });
    expect(await packaged.thinker.detect()).toMatchObject({ available: false, note: expect.stringContaining('打包') });
    const r = await packaged.thinker.think(req());
    expect(r.status).toBe('failed');
    expect(packaged.records()).toEqual([]); // claude 根本没被启动
  });

  it('开启且已登录 → 可用，并如实提示无法确认的隔离项；未登录 → 不可用', async () => {
    const d = await make('ok').thinker.detect();
    expect(d.available).toBe(true);
    expect(d.unconfirmed?.length).toBeGreaterThan(0);
    expect((await make('ok', { env: { FAKE_LOGIN: 'no' } }).thinker.detect()).available).toBe(false);
  });

  it('生成的参数：官方隔离参数齐全，没有任何跳过权限的参数；提示词走标准输入；ANTHROPIC_API_KEY 不传给子进程', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-should-be-removed';
    try {
      const { thinker, records } = make('ok');
      const r = await thinker.think(req());
      expect(r).toMatchObject({ status: 'complete', content: { verdict: 'ok' }, model: 'claude-fake', isolationEvidence: 'tools=0, mcp_servers=0, skills=0, slash_commands=0', usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.01 }, service: expect.stringContaining('Anthropic') });
      const rec = records()[0];
      const argv = (rec.argv as string[]).slice(0);
      expect(argv).toEqual(expect.arrayContaining(['-p', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']));
      expect(argv[argv.indexOf('--tools') + 1]).toBe(''); // 禁用全部工具
      expect(argv[argv.indexOf('--max-turns') + 1]).toBe('1');
      expect(argv.join(' ')).not.toMatch(/dangerously|bypassPermissions|--bare|skip-permissions|allowedTools/);
      expect(argv.join(' ')).not.toContain('评审这个方案'); // 提示词不在命令行里
      expect(rec.stdin).toContain('评审这个方案');
      expect(rec.hasApiKey).toBe(false);
      expect(path.basename(rec.cwd)).toMatch(/^studio-think-/);
      expect(fs.existsSync(rec.cwd)).toBe(false);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    expect(claudeCliArgs({ model: 'm' })).toEqual(expect.arrayContaining(['--model', 'm']));
  });

  it('围栏包裹的 JSON 可解析；不是 JSON / 缺字段 → incomplete', async () => {
    expect((await make('fenced').thinker.think(req())).status).toBe('complete');
    const bad = await make('badjson').thinker.think(req());
    expect(bad.status).toBe('incomplete');
    expect(bad.content).toBeUndefined();
    expect((await make('missing').thinker.think(req())).status).toBe('incomplete');
  });

  it('错误分类：频率限制 / 额度用尽 / 未登录 / 其他', async () => {
    expect((await make('ratelimit').thinker.think(req())).status).toBe('rate_limited');
    expect((await make('quota').thinker.think(req())).status).toBe('quota_exhausted');
    expect((await make('credit').thinker.think(req())).status).toBe('quota_exhausted');
    expect((await make('auth').thinker.think(req())).status).toBe('auth_error');
    expect((await make('other').thinker.think(req())).status).toBe('failed');
  });

  it('调用后核验：init 里实际带有工具 → failed（隔离无法确认）；没有 init → failed', async () => {
    const t = await make('tools').thinker.think(req());
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/隔离无法确认.*tools/);
    expect(t.content).toBeUndefined();
    expect((await make('noinit').thinker.think(req())).status).toBe('failed');
  });

  it('超时 → timeout', async () => {
    expect((await make('hang', { timeoutMs: 400 }).thinker.think(req())).status).toBe('timeout');
  });
});

describe('ClaudeApiThinker（本地假 Anthropic API）', () => {
  async function startMockApi(
    responder: (req: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }, res: http.ServerResponse) => void,
  ) {
    const captured: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    const server = http.createServer((incoming, res) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (c) => chunks.push(c as Buffer));
      incoming.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        captured.push({ headers: incoming.headers, body });
        responder({ headers: incoming.headers, body }, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}/v1/messages`,
      captured,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('请求不含 tools，默认使用当前官方模型与版本头；支持 thinking 块前置，记录 token 用量但不虚构费用', async () => {
    const SECRET = 'sk-ant-CANARY-THINKER-2468';
    const srv = await startMockApi((_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          model: DEFAULT_CLAUDE_API_MODEL,
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking', thinking: 'internal chain' },
            { type: 'text', text: '{"verdict":"ok","points":["方案清晰"]}' },
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/etc/passwd' } },
          ],
          usage: { input_tokens: 320, output_tokens: 85 },
        }),
      );
    });
    try {
      const thinker = new ClaudeApiThinker({
        endpoint: srv.url,
        getSecret: async () => SECRET,
      });
      expect((await thinker.detect()).available).toBe(true);
      expect(thinker.service).toBe('Anthropic');

      const r = await thinker.think(req());
      expect(r.status).toBe('complete');
      expect(r.content).toEqual({ verdict: 'ok', points: ['方案清晰'] });
      expect(r.model).toBe(DEFAULT_CLAUDE_API_MODEL);
      expect(r.usage).toEqual({ inputTokens: 320, outputTokens: 85 });
      expect(r.usage?.costUsd).toBeUndefined(); // 不虚构金额
      expect(r.refusedToolRequests).toEqual(['Read']);

      const sentReq = srv.captured[0]!;
      expect(sentReq.headers['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
      expect(sentReq.headers['x-api-key']).toBe(SECRET);
      expect(sentReq.body.model).toBe(DEFAULT_CLAUDE_API_MODEL);
      expect(sentReq.body.tools).toBeUndefined();
      expect(sentReq.body.temperature).toBeUndefined();

      // 模型可配置
      const custom = new ClaudeApiThinker({
        endpoint: srv.url,
        model: 'claude-sonnet-4-6',
        getSecret: async () => SECRET,
      });
      await custom.think(req());
      expect(srv.captured[1]!.body.model).toBe('claude-sonnet-4-6');
    } finally {
      await srv.close();
    }
  });

  it('错误分类：Key 无效 / 额度用尽 / 限流 / 网络错误 / 超时 / 缺 Key，且绝不泄露 Key', async () => {
    const SECRET = 'sk-ant-CANARY-ERR-1357';
    let nextStatus = 401;
    let nextBody: unknown = { type: 'error', error: { type: 'authentication_error', message: `bad key ${SECRET}` } };

    const srv = await startMockApi((_r, res) => {
      if (nextStatus === 0) return; // intentionally hang for timeout test
      res.writeHead(nextStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextBody));
    });
    try {
      const thinker = new ClaudeApiThinker({ endpoint: srv.url, getSecret: async () => SECRET });

      // 401 -> auth_error 且 Key 被脱敏
      const rAuth = await thinker.think(req());
      expect(rAuth.status).toBe('auth_error');
      expect(rAuth.error).not.toContain(SECRET);
      expect(rAuth.rawText).not.toContain(SECRET);

      // 402 billing_error -> quota_exhausted
      nextStatus = 402;
      nextBody = { type: 'error', error: { type: 'billing_error', message: 'credit balance is too low' } };
      expect((await thinker.think(req())).status).toBe('quota_exhausted');

      // 529 overloaded_error -> rate_limited
      nextStatus = 529;
      nextBody = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
      expect((await thinker.think(req())).status).toBe('rate_limited');

      // 超时 -> timeout
      nextStatus = 0;
      expect((await thinker.think(req({ timeoutMs: 120 }))).status).toBe('timeout');

      // 网络错误 -> failed 且含网络错误描述
      const offline = new ClaudeApiThinker({ endpoint: 'http://127.0.0.1:1/v1/messages', getSecret: async () => SECRET });
      const rNet = await offline.think(req());
      expect(rNet.status).toBe('failed');
      expect(rNet.error).toContain('网络错误');
      expect(rNet.error).not.toContain(SECRET);

      // 缺 Key -> auth_error 且 detect 不可用
      const noKey = new ClaudeApiThinker({ endpoint: srv.url, getSecret: async () => null });
      expect((await noKey.detect()).available).toBe(false);
      expect((await noKey.think(req())).status).toBe('auth_error');
    } finally {
      await srv.close();
    }
  });
});

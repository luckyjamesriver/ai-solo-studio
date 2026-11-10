import { describe, it, expect, afterEach } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Electron 端到端测试（Playwright，驱动真实的 Electron 窗口）。
 * 系统文件夹对话框用测试替身：直接替换主进程里 dialog.showOpenDialog 的返回值，生产代码里没有任何测试开关。
 * 需要真实的显示环境（本机或 macOS CI）；无显示的 Linux CI 不运行本套测试。
 * 每个测试使用独立的应用数据目录（--user-data-dir），不碰真实的最近项目与外发确认记录。
 */
const root = path.resolve(import.meta.dirname, '..');
const electronBin = createRequire(import.meta.url)('electron') as string;
const shotDir = process.env.E2E_SCREENSHOT_DIR;
const stage2ShotDir = process.env.E2E_STAGE2_SHOT_DIR;
const stage3ShotDir = process.env.E2E_STAGE3_SHOT_DIR;
const stage4ShotDir = process.env.E2E_STAGE4_SHOT_DIR;
const stage5ShotDir = process.env.E2E_STAGE5_SHOT_DIR;
const stage5bShotDir = process.env.E2E_STAGE5B_SHOT_DIR;
const stage6ShotDir = process.env.E2E_STAGE6_SHOT_DIR;

const tmpDirs: string[] = [];
const apps: ElectronApplication[] = [];
const servers: http.Server[] = [];
const mk = (prefix: string) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `studio-e2e-${prefix}-`)));
  tmpDirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
function gitProject(name: string, files: Record<string, string> = { 'index.html': '<h1>hi</h1>' }): string {
  const d = path.join(mk('proj'), name);
  fs.mkdirSync(d);
  for (const [n, c] of Object.entries(files)) {
    const dest = path.join(d, n);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, c);
  }
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  return d;
}
function plainProject(name: string): string {
  const d = path.join(mk('plain'), name);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'index.html'), '<h1>plain</h1>');
  return d;
}

async function launch(userData: string, env: NodeJS.ProcessEnv = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const base = { ...process.env, ...env };
  delete base.STUDIO_DEV_URL;
  delete base.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: electronBin, args: [root, `--user-data-dir=${userData}`], cwd: root, env: base as Record<string, string> });
  apps.push(app);
  const page = await app.firstWindow();
  await page.waitForSelector('h1');
  return { app, page };
}
/** 替换系统文件夹对话框：下一次及之后的选择都返回给定路径。 */
const stubDialog = (app: ElectronApplication, folder: string | null) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => (p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] })) as unknown as typeof dialog.showOpenDialog;
  }, folder);
const shot = async (page: Page, name: string) => {
  if (!shotDir) return;
  const target = path.join(shotDir, `${name}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target });
};
const stage2Shot = async (page: Page, name: string) => {
  if (!stage2ShotDir) return;
  const target = path.join(stage2ShotDir, `${name}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target });
};
const stage3Shot = async (page: Page, name: string) => {
  if (!stage3ShotDir) return;
  const target = path.join(stage3ShotDir, `${name}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target });
};
const stage4Shot = async (page: Page, name: string) => {
  if (!stage4ShotDir) return;
  const target = path.join(stage4ShotDir, `${name}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target });
};
const stage5Shot = async (page: Page, name: string) => {
  if (!stage5ShotDir) return;
  const target = path.join(stage5ShotDir, `${name}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target });
};
const stage5bShot = async (page: Page, name: string) => {
  if (!stage5bShotDir) return;
  const target = path.join(stage5bShotDir, `${name}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target });
};
const stage6Shot = async (page: Page, name: string) => {
  if (!stage6ShotDir) return;
  const target = path.join(stage6ShotDir, `${name}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target });
};
const acceptDisclosure = async (page: Page) => {
  await page.getByRole('button', { name: '我了解了，同意' }).click();
  await expect_(page.getByTestId('disclosure')).toHaveCount(0);
};
// 极简的 expect 封装，避免引入 @playwright/test
const expect_ = (loc: ReturnType<Page['getByTestId']>) => ({
  toHaveCount: async (n: number) => { await loc.waitFor({ state: n === 0 ? 'detached' : 'attached', timeout: 20_000 }); expect(await loc.count()).toBe(n); },
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('首次外发告知', () => {
  it('首次打开出现一次；确认后重启不再出现，但可在“资料外发”里再次查看', async () => {
    const data = mk('data');
    const a = await launch(data);
    await a.page.getByTestId('disclosure').waitFor({ timeout: 20_000 });
    const text = await a.page.getByTestId('disclosure').innerText();
    expect(text).toContain('会发送给这些 AI 服务');
    expect(text).toContain('不会发送什么');
    expect(text).toContain('凭证');
    await shot(a.page, '1-首次外发告知');
    await acceptDisclosure(a.page);
    await a.page.getByTestId('nav-settings').click();
    await a.page.getByTestId('tab-settings-disclosure').click();
    expect(await a.page.getByTestId('outbound-status').innerText()).toContain('已确认');
    expect(fs.existsSync(path.join(data, 'records', 'app', 'disclosure.json'))).toBe(true);
    await a.app.close();

    const b = await launch(data);
    await b.page.getByTestId('nav-settings').click();
    await b.page.getByTestId('tab-settings-disclosure').click();
    await b.page.getByTestId('outbound-status').waitFor();
    await b.page.waitForTimeout(800);
    expect(await b.page.getByTestId('disclosure').count()).toBe(0);
    await b.page.getByRole('button', { name: '查看外发说明' }).click();
    await b.page.getByTestId('disclosure').waitFor();
    expect(await b.page.getByRole('button', { name: '我了解了，同意' }).count()).toBe(0);
  });

  it('不确认：仍可浏览，外发保持关闭且不写记录；下次启动再次询问', async () => {
    const data = mk('data');
    const a = await launch(data);
    await a.page.getByTestId('disclosure').waitFor({ timeout: 20_000 });
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await a.page.locator('ul.env li').first().waitFor({ timeout: 60_000 }); // 首次引导中的体检仍可浏览
    await a.page.getByTestId('nav-settings').click();
    await a.page.getByTestId('tab-settings-disclosure').click();
    expect(await a.page.getByTestId('outbound-status').innerText()).toContain('尚未确认');
    expect(fs.existsSync(path.join(data, 'records', 'app', 'disclosure.json'))).toBe(false);
    await a.app.close();
    const b = await launch(data);
    await b.page.getByTestId('disclosure').waitFor({ timeout: 20_000 });
  });
});

describe('打开项目', () => {
  it('对话框选 Git 项目 → 打开；重启后出现在最近项目里，按条目打开（渲染进程不传路径）', async () => {
    const data = mk('data');
    const proj = gitProject('my-site');
    const a = await launch(data);
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await stubDialog(a.app, proj);
    await a.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await a.page.getByTestId('project').waitFor();
    expect(await a.page.getByTestId('project').innerText()).toContain('my-site');
    expect(await a.page.getByTestId('dirty').count()).toBe(0);
    const stored = JSON.parse(fs.readFileSync(path.join(data, 'records', 'app', 'recent-projects.json'), 'utf8')).data; // 记录库的外层是修订号等元数据，内容在 data 里
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0].path).toBe(proj);
    await a.app.close();

    const b = await launch(data);
    await b.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await b.page.getByTestId('recent').waitFor();
    // 对话框被替换成“取消”，证明这次打开确实没有走对话框
    await stubDialog(b.app, null);
    await b.page.getByRole('button', { name: 'my-site' }).click();
    await b.page.getByTestId('project').waitFor();
  });

  it('取消对话框：什么也不发生；选择主目录：被拒绝并说明原因', async () => {
    const a = await launch(mk('data'));
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await stubDialog(a.app, null);
    await a.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await a.page.waitForTimeout(500);
    expect(await a.page.getByTestId('project').count()).toBe(0);
    expect(await a.page.getByTestId('notice').count()).toBe(0);
    await stubDialog(a.app, os.homedir());
    await a.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await a.page.getByTestId('notice').waitFor();
    expect(await a.page.getByTestId('notice').innerText()).toContain('主目录');
    expect(await a.page.getByTestId('project').count()).toBe(0);
  });

  it('非 Git 项目：说明后让用户确认；拒绝则不打开、不创建 .git；同意才初始化且不改动原文件', async () => {
    const data = mk('data');
    const proj = plainProject('plain-site');
    const a = await launch(data);
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await stubDialog(a.app, proj);
    await a.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await a.page.getByTestId('init-consent').waitFor();
    expect(await a.page.getByTestId('init-consent').innerText()).toContain('将在这个文件夹里创建版本记录（.git），不会修改你的文件');
    await shot(a.page, '3-非Git项目确认');
    expect(fs.existsSync(path.join(proj, '.git'))).toBe(false); // 确认前什么都没创建

    await a.page.getByRole('button', { name: '不同意，不打开' }).click();
    await a.page.getByTestId('notice').waitFor();
    expect(fs.existsSync(path.join(proj, '.git'))).toBe(false);
    expect(await a.page.getByTestId('project').count()).toBe(0);
    expect(fs.existsSync(path.join(data, 'records', 'app', 'recent-projects.json'))).toBe(false);

    await a.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await a.page.getByTestId('init-consent').waitFor();
    await a.page.getByRole('button', { name: '同意，创建版本记录并打开' }).click();
    await a.page.getByTestId('project').waitFor();
    expect(fs.existsSync(path.join(proj, '.git'))).toBe(true);
    expect(fs.readFileSync(path.join(proj, 'index.html'), 'utf8')).toBe('<h1>plain</h1>');
  });

  it('已有 Git 但有未提交改动：如实提示，且不自动提交', async () => {
    const proj = gitProject('dirty-site');
    fs.writeFileSync(path.join(proj, 'index.html'), '<h1>changed</h1>');
    fs.writeFileSync(path.join(proj, 'new.txt'), 'x');
    const before = git(proj, 'rev-parse', 'HEAD').toString();
    const a = await launch(mk('data'));
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await stubDialog(a.app, proj);
    await a.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await a.page.getByTestId('dirty').waitFor();
    expect(await a.page.getByTestId('dirty').innerText()).toContain('2 个文件');
    expect(git(proj, 'rev-parse', 'HEAD').toString()).toBe(before);
    expect(git(proj, 'status', '--porcelain').toString().trim().split('\n')).toHaveLength(2);
  });
});

/**
 * 施工模式界面（M3-B3-2）。执行体用 FakeExecutor：和替换系统对话框同一思路——在运行中的主进程里替换依赖的方法，
 * 把 CodexExecutor.prototype.start 指向 FakeExecutor（同一份已构建的模块实例），生产代码里没有任何测试开关，也不调用真实 Codex。
 * 测试项目没有 package.json，所以检查项显示“未检查”（不会启动任何真实的受限运行环境）。
 */
const distUrl = (p: string) => pathToFileURL(path.join(root, 'dist-electron', 'core', p)).href;
async function useFakeExecutor(app: ElectronApplication, script: unknown[]) {
  await app.evaluate(
    async (_e, a) => {
      // evaluate 里不能用 import()（没有动态导入回调）；Node 24 支持 require() 同步加载 ES 模块，且与应用自己 import 的是同一份模块实例
      const { createRequire } = process.getBuiltinModule('module');
      const req = createRequire(a.codexUrl);
      const { CodexExecutor } = req(a.codexPath);
      const { FakeExecutor } = req(a.fakePath);
      const fake = new FakeExecutor(a.script, { emitPermissions: true });
      CodexExecutor.prototype.start = function (opts: unknown) { return fake.start(opts); };
    },
    { codexUrl: distUrl('executor/adapters/codex.js'), codexPath: fileURLToPath(distUrl('executor/adapters/codex.js')), fakePath: fileURLToPath(distUrl('executor/adapters/fake.js')), script },
  );
}
/** 每次 CodexExecutor.start 按顺序消费下一份 script，用于多任务/多轮重做 E2E。 */
async function useFakeExecutorQueue(app: ElectronApplication, scripts: unknown[][]) {
  await app.evaluate(
    async (_e, a) => {
      const { createRequire } = process.getBuiltinModule('module');
      const req = createRequire(a.codexUrl);
      const { CodexExecutor } = req(a.codexPath);
      const { FakeExecutor } = req(a.fakePath);
      let idx = 0;
      CodexExecutor.prototype.start = function (opts: unknown) {
        const s = a.scripts[idx] ?? a.scripts[a.scripts.length - 1] ?? [];
        idx++;
        const fake = new FakeExecutor(s, { emitPermissions: true });
        return fake.start(opts);
      };
    },
    { codexUrl: distUrl('executor/adapters/codex.js'), codexPath: fileURLToPath(distUrl('executor/adapters/codex.js')), fakePath: fileURLToPath(distUrl('executor/adapters/fake.js')), scripts },
  );
}
async function enableFakeChecks(app: ElectronApplication) {
  await app.evaluate(
    async (_e, a) => {
      const { createRequire } = process.getBuiltinModule('module');
      const { spawn } = process.getBuiltinModule('child_process');
      const req = createRequire(a.codexUrl);
      const { CodexExecutor } = req(a.codexPath);
      CodexExecutor.prototype.execInSandbox = function (req: { cwd: string; argv: string[]; env?: NodeJS.ProcessEnv }) {
        return new Promise((resolve) => {
          const t0 = Date.now();
          let stdout = '';
          let stderr = '';
          const child = spawn(req.argv[0]!, req.argv.slice(1), { cwd: req.cwd, env: req.env, shell: false });
          child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
          child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
          child.on('error', (e: Error) => resolve({ status: 'unavailable', reason: e.message }));
          child.on('close', (code: number | null) =>
            resolve({ status: 'ran', exitCode: code, stdout, stderr, timedOut: false, durationMs: Date.now() - t0 }),
          );
        });
      };
    },
    { codexUrl: distUrl('executor/adapters/codex.js'), codexPath: fileURLToPath(distUrl('executor/adapters/codex.js')) },
  );
}
async function useFakeThinkers(
  app: ElectronApplication,
  opts: { failDraftOnce?: boolean; withFindings?: boolean } = {},
) {
  await app.evaluate(
    async (_e, a) => {
      const { createRequire } = process.getBuiltinModule('module');
      const req = createRequire(a.codexUrl);
      const { CodexThinker } = req(a.codexPath);
      const { ClaudeCliThinker } = req(a.claudePath);
      let draftFailedOnce = false;

      const makeResult = (
        thinkReq: { role: string; output: { required: string[] } },
        service: string,
        withCost: boolean,
      ) => {
        const reqd = thinkReq.output?.required ?? [];
        const sent = ['docs/PROJECT_CONTEXT.md（第 1、2、4 节）'];
        const usage = withCost ? { costUsd: 0.0125 } : undefined;
        let payload: unknown;

        if (reqd.includes('reply')) {
          payload = {
            reply:
              thinkReq.role === 'planner'
                ? '首席说明：样式变量方案把浅色/深色集中在一张配色表里，修改维护成本最小。'
                : '复核说明：只基于方案正文与我的正式评审记录来看，主体切换逻辑成立；主要提醒还是深色下配图亮度对比。',
          };
        } else if (reqd.includes('items')) {
          payload = {
            items: [
              { text: '首页支持深色外观切换' },
              { text: '刷新页面后记住用户所选外观' },
            ],
          };
        } else if (reqd.includes('coverage')) {
          if (a.failDraftOnce && !draftFailedOnce) {
            draftFailedOnce = true;
            return { status: 'failed', rawText: '', sent, service, error: '模型连接暂时中断（E2E 模拟失败）' };
          }
          payload = {
            plan: '## 目标\n完成首页深色外观与偏好持久化。\n\n## 验收建议\n- 首页含深色外观切换按钮，点击立即切换\n- 刷新页面后保留上次选择的外观',
            coverage: [
              { id: 'R1', how: '顶部加入深色外观切换开关' },
              { id: 'R2', how: '写入 localStorage 并初始化应用' },
            ],
          };
        } else if (reqd.includes('requirement_checks')) {
          payload = {
            requirement_checks: [
              { id: 'R1', covered: true, note: '切换开关明确' },
              { id: 'R2', covered: true, note: '持久化方案清晰' },
            ],
            findings: a.withFindings
              ? [
                  {
                    problem: '深色模式下现有装饰图片对比度未调整',
                    severity: '阻断',
                    basis: 'docs/ref.md#视觉规范',
                    impact: '深色背景下的配图可能偏暗不易辨识',
                    suggestion: '补充深色背景的图片亮度或遮罩调整规则',
                    resolution: '',
                  },
                ]
              : [],
            missing_evidence: a.withFindings ? ['缺少深色模式下实测截图对比'] : [],
          };
        } else {
          payload = {
            plan: '## 方案（修订第 2 版）\n用颜色变量统一管理浅色/深色外观；首版暂不做装饰图片暗色遮罩，保持主题改动最小可逆。\n\n## 验收建议\n- 页头显示外观切换按钮，点击后立即切换浅色/深色\n- 刷新页面后保留上次选择的外观',
            resolutions: a.withFindings
              ? [{ index: 1, result: '交用户裁决', reason: '图片暗色处理属于额外视觉调整，交用户决定首版是否接受该风险' }]
              : [],
            item_marks: [
              { id: 'R1', mark: '保留' },
              { id: 'R2', mark: '保留' },
            ],
            additions: [],
          };
        }

        const raw = JSON.stringify(payload);
        return {
          status: 'complete',
          rawText: raw,
          content: payload,
          model: withCost ? 'claude-test' : 'codex-test',
          ...(usage ? { usage } : {}),
          sent,
          service,
        };
      };

      CodexThinker.prototype.detect = async () => ({ available: true });
      CodexThinker.prototype.think = async function (thinkReq: { role: string; output: { required: string[] } }) {
        return makeResult(thinkReq, this.service ?? 'Codex CLI', false);
      };
      ClaudeCliThinker.prototype.detect = async () => ({ available: true });
      ClaudeCliThinker.prototype.think = async function (thinkReq: { role: string; output: { required: string[] } }) {
        return makeResult(thinkReq, this.service ?? 'Claude Code CLI', true);
      };
    },
    {
      codexUrl: distUrl('thinking/codex.js'),
      codexPath: fileURLToPath(distUrl('thinking/codex.js')),
      claudePath: fileURLToPath(distUrl('thinking/claude-cli.js')),
      failDraftOnce: !!opts.failDraftOnce,
      withFindings: opts.withFindings !== false,
    },
  );
}
async function openProjectWithFake(proj: string, script: unknown[], data = mk('data')) {
  const a = await launch(data);
  await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
  await useFakeExecutor(a.app, script);
  await stubDialog(a.app, proj);
  await a.page.getByRole('button', { name: '打开项目文件夹' }).click();
  await a.page.getByTestId('project').waitFor();
  return a;
}
async function newTask(page: Page, text: string) {
  await page.getByTestId('request').fill(text);
  await page.getByTestId('create-task').click();
  await page.getByTestId('skip-discussion-button').waitFor();
  await page.getByTestId('skip-discussion-button').click();
  await page.getByTestId('plan-card').waitFor();
}
// 任务记录在记录库里：<项目>/.studio/records/tasks/<id>.json，外层是修订号等元数据，任务内容在 data 里（ADR 0005）
const taskFiles = (proj: string) => {
  const dir = path.join(proj, '.studio', 'records', 'tasks');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).data as Record<string, any>) : [];
};
/**
 * 修改任务记录必须经持久化服务（应用已关闭、租约已释放之后）：直接改磁盘文件会被启动对账按事件日志改回去。
 * 用已构建的 TaskStore（dist-electron），带 CAS 提交。
 */
async function editTask(proj: string, id: string, mutate: (t: Record<string, any>) => void) {
  const { TaskStore } = (await import(distUrl('task/store.js'))) as { TaskStore: new (repo: string, o: object) => { get(id: string): Promise<Record<string, any> | null>; save(t: Record<string, any>): Promise<void>; recordStore(): Promise<{ close(): Promise<void> }> } };
  const ts = new TaskStore(proj, { lockWaitMs: 20_000 });
  const t = (await ts.get(id))!;
  mutate(t);
  await ts.save(t);
  await (await ts.recordStore()).close();
}

describe('施工模式界面', () => {
  it('标准模式：计划卡默认标准 → 开工 → 施工视图只有“停止” → 停止后结果区显示事实与“AI 自己的说法”', async () => {
    const proj = gitProject('std-site');
    const a = await openProjectWithFake(proj, [{ do: 'say', text: '正在改标题，另外联网安装依赖失败了。' }, { do: 'write', path: 'index.html', content: '<h1>new</h1>' }, { do: 'hang' }]);
    await newTask(a.page, '把首页标题改成 new');
    const plan = a.page.getByTestId('plan-card');
    expect(await a.page.getByTestId('mode-standard').isChecked()).toBe(true);
    expect(await a.page.getByTestId('mode-full-trust').isChecked()).toBe(false);
    const planText = await plan.innerText();
    expect(planText).toContain('AI 只能修改这个任务的副本');
    expect(planText).toContain('AI 可以读取你电脑上的大部分文件。只有常见的密钥和账号凭证位置被挡住（例如 .ssh、云服务凭证）；其他地方保存的密码或密钥文件不在保护范围内。读到的内容会发送给执行者使用的 AI 服务。');
    expect(planText).toContain('允许联网（例如安装依赖）——开启后 AI 可访问任意网站。');
    expect(planText).toContain('允许修改另一个文件夹');
    expect(planText).toContain('这个项目没有自动检查，验收时会显示未检查');
    expect(planText).not.toMatch(/域名|限制网站|白名单|改为只读|更换|导出/); // 不暗示能限制网站，且无未接入按钮
    await shot(a.page, '4-计划卡（标准模式）');

    await a.page.getByTestId('start-button').click();
    await a.page.getByTestId('run-view').waitFor();
    await a.page.getByTestId('progress').getByText('正在改标题').waitFor();
    // 施工视图：只有一个按钮“停止”，没有任何允许/批准按钮
    const buttons = await a.page.getByTestId('run-view').locator('button').allInnerTexts();
    expect(buttons).toEqual(['停止']);
    const perm = await a.page.getByTestId('perm-summary').innerText();
    expect(perm).toContain('标准模式');
    expect(perm).toContain('可修改的位置：任务副本');
    expect(perm).toContain('联网：不可以');
    const runText = await a.page.getByTestId('run-view').innerText();
    expect(runText).not.toMatch(/sandbox|never|danger|profile|approval|npm |git /i); // 没有内部名词和命令
    expect(await a.page.getByTestId('fulltrust-badge').count()).toBe(0);
    await shot(a.page, '6-施工中视图');

    await a.page.getByTestId('stop-button').click();
    await a.page.getByTestId('stopped-page').waitFor({ timeout: 30_000 });
    expect(await a.page.getByTestId('stopped-reason-tag').innerText()).toBe('你停止的');
    await a.page.getByTestId('go-acceptance-button').click();
    await a.page.getByTestId('result').waitFor({ timeout: 30_000 });
    const result = await a.page.getByTestId('result').innerText();
    expect(result).toContain('检查与证据');
    expect(result).toContain('AI 自己的说法');
    expect(result).toContain('仅供参考，以上方应用检查事实为准');
    expect(result).toContain('你停止了本次执行');
    expect(result).toContain('项目能成功构建'); // B4-2：验收区使用主进程的用户验收视图，检查项的名称随之统一
    expect(result).toContain('未检查');
    expect(await a.page.getByTestId('changes').innerText()).toContain('index.html');
    // AI 自述的失败被提取并标注
    expect(await a.page.getByTestId('incomplete').innerText()).toContain('联网安装依赖失败了');
    await shot(a.page, '7-结果区');
    // 主项目没有被改动（任务在独立副本里）
    expect(fs.readFileSync(path.join(proj, 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
    // 磁盘上的任务记录里有实际生效的权限
    expect(taskFiles(proj)[0]?.effectivePermissions).toMatchObject({ mode: 'standard', approvalPolicy: 'never' });
  });

  it('标准模式正常结束：结果显示改动与检查；没有 AI 自述失败时不编造“未完成”', async () => {
    const proj = gitProject('ok-site');
    const a = await openProjectWithFake(proj, [{ do: 'say', text: '已经把标题改好了。' }, { do: 'write', path: 'index.html', content: '<h1>new</h1>' }]);
    await newTask(a.page, '改标题');
    await a.page.getByTestId('start-button').click();
    await a.page.getByTestId('result').waitFor({ timeout: 30_000 });
    expect(await a.page.getByTestId('changes').innerText()).toContain('index.html');
    expect(await a.page.getByTestId('facts').innerText()).toContain('AI 执行过程正常结束：正常结束');
    expect(await a.page.getByTestId('incomplete').innerText()).toContain('AI 没有报告未完成的操作');
    expect(await a.page.getByTestId('unexpected').count()).toBe(0);
  });

  it('完全信任：不勾选“我已了解风险”不能开工；勾选确认后才开工，任务与列表都有“完全信任”标记；取消回到标准模式', async () => {
    const proj = gitProject('trust-site');
    const a = await openProjectWithFake(proj, [{ do: 'say', text: '工作中' }, { do: 'hang' }]);
    await newTask(a.page, '改标题');
    await a.page.getByTestId('mode-full-trust').check();
    expect(await a.page.getByTestId('extras').count()).toBe(0); // 扩展权限只在标准模式下显示
    await a.page.getByTestId('start-button').click();
    await a.page.getByTestId('trust-panel').waitFor();
    const panel = await a.page.getByTestId('trust-panel').innerText();
    expect(panel).toContain('AI 将拥有你这个电脑账户的全部权限：可以读取任何文件、联网、修改项目以外的文件，可能自行推送代码；它读到的内容会发送给 AI 服务商；对项目以外的修改无法撤销。仅对本任务有效。');
    await shot(a.page, '5-完全信任确认面板');
    // 不勾选：按钮禁用，什么都没开始，磁盘上没有确认标记
    expect(await a.page.getByTestId('trust-confirm').isDisabled()).toBe(true);
    await a.page.waitForTimeout(400);
    expect(await a.page.getByTestId('run-view').count()).toBe(0);
    expect(taskFiles(proj)[0]).toMatchObject({ state: 'planned' });
    expect(taskFiles(proj)[0]?.fullTrustConfirmedAt).toBeUndefined();

    // 取消：回到标准模式，仍然没有开工
    await a.page.getByTestId('trust-cancel').click();
    await a.page.getByTestId('trust-panel').waitFor({ state: 'detached' });
    expect(await a.page.getByTestId('mode-standard').isChecked()).toBe(true);
    expect(taskFiles(proj)[0]?.fullTrustConfirmedAt).toBeUndefined();

    // 再选完全信任 → 勾选 → 确认并开工
    await a.page.getByTestId('mode-full-trust').check();
    await a.page.getByTestId('start-button').click();
    await a.page.getByTestId('trust-ack').check();
    expect(await a.page.getByTestId('trust-confirm').isDisabled()).toBe(false);
    await a.page.getByTestId('trust-confirm').click();
    await a.page.getByTestId('run-view').waitFor();
    expect(await a.page.getByTestId('run-view').getByTestId('fulltrust-badge').innerText()).toBe('完全信任');
    expect(await a.page.getByTestId('perm-summary').innerText()).toContain('完全信任模式');
    expect(await a.page.getByTestId('run-view').locator('button').allInnerTexts()).toEqual(['停止']); // 仍然只有停止
    expect(taskFiles(proj)[0]?.fullTrustConfirmedAt).toBeTruthy();
    await a.page.getByTestId('stop-button').click();
    await a.page.getByTestId('stopped-page').waitFor({ timeout: 30_000 });
    await a.page.getByTestId('go-acceptance-button').click();
    await a.page.getByTestId('result').waitFor({ timeout: 30_000 });
    expect(await a.page.getByTestId('result').getByTestId('fulltrust-badge').innerText()).toBe('完全信任'); // 结果里标记仍在
    await a.page.getByTestId('breadcrumb-project').click();
    expect(await a.page.getByTestId('fulltrust-badge-list').innerText()).toBe('完全信任'); // 看板卡片里也有
  });

  it('偏好只预选：上次选了完全信任，新任务预选完全信任，但开工前仍然弹出确认面板', async () => {
    const proj = gitProject('pref-site');
    const a = await openProjectWithFake(proj, [{ do: 'say', text: '好了' }]);
    await newTask(a.page, '任务一');
    await a.page.getByTestId('mode-full-trust').check();
    await a.page.getByTestId('start-button').click();
    await a.page.getByTestId('trust-ack').check();
    await a.page.getByTestId('trust-confirm').click();
    await a.page.getByTestId('result').waitFor({ timeout: 30_000 });

    await a.page.getByTestId('breadcrumb-project').click();
    await newTask(a.page, '任务二');
    expect(await a.page.getByTestId('mode-full-trust').isChecked()).toBe(true); // 预选
    expect(await a.page.getByTestId('preselect-note').innerText()).toContain('每个任务开工前仍需要重新确认');
    await a.page.getByTestId('start-button').click();
    await a.page.getByTestId('trust-panel').waitFor(); // 没有跳过确认
    expect(await a.page.getByTestId('trust-confirm').isDisabled()).toBe(true);
    expect(await a.page.getByTestId('run-view').count()).toBe(0);
    const second = taskFiles(proj).find((t) => t.request === '任务二');
    expect(second?.fullTrustConfirmedAt).toBeUndefined();
  });

  it('额外文件夹：含 .git 的被拒绝并说明原因；合格的可添加、可移除；联网开关随计划保存', async () => {
    const proj = gitProject('dirs-site');
    const extra = mk('extra');
    const a = await openProjectWithFake(proj, [{ do: 'say', text: '好了' }]);
    await newTask(a.page, '改标题');

    await stubDialog(a.app, path.join(proj, '.git'));
    await a.page.getByTestId('add-dir').click();
    await a.page.getByTestId('extra-dir-error').waitFor();
    expect(await a.page.getByTestId('extra-dir-error').innerText()).toContain('.git');
    expect(await a.page.getByTestId('extra-dir-list').innerText()).toContain('没有额外的文件夹');

    await stubDialog(a.app, proj); // 项目本身
    await a.page.getByTestId('add-dir').click();
    await a.page.waitForFunction(() => document.querySelector('[data-testid="extra-dir-error"]')?.textContent?.includes('版本记录'));

    await stubDialog(a.app, extra);
    await a.page.getByTestId('net-toggle').check();
    await a.page.getByTestId('add-dir').click();
    await a.page.waitForFunction((p) => document.querySelector('[data-testid="extra-dir-list"]')?.textContent?.includes(p), extra);
    expect(await a.page.getByTestId('extra-dir-error').count()).toBe(0);
    const saved = taskFiles(proj)[0]!;
    expect(saved.plan.capabilities.extraWritableDirs).toEqual([extra]);
    expect(saved.plan.capabilities.externalNetwork).toBe('on');

    await a.page.getByTestId('extra-dir-list').getByRole('button', { name: '移除' }).click();
    await a.page.waitForFunction(() => document.querySelector('[data-testid="extra-dir-list"]')?.textContent?.includes('没有额外的文件夹'));

    // 开工后实际生效的权限里列出选定文件夹与联网
    await a.page.getByTestId('add-dir').click();
    await a.page.waitForFunction((p) => document.querySelector('[data-testid="extra-dir-list"]')?.textContent?.includes(p), extra);
    await a.page.getByTestId('start-button').click();
    await a.page.getByTestId('result').waitFor({ timeout: 30_000 });
    await a.page.getByText('这次任务实际生效的权限').click();
    const text = await a.page.getByTestId('result').innerText();
    expect(text).toContain(`你选定的文件夹：${extra}`);
    expect(text).toContain('联网：已开启，可访问任意网站');
  });

  it('渲染进程拿不到路径：任务相关 API 全是编号/文字/布尔值，伪造的参数被主进程拒绝', async () => {
    const proj = gitProject('api-site');
    const a = await openProjectWithFake(proj, []);
    const r = await a.page.evaluate(async () => {
      type Fn = (...x: unknown[]) => Promise<unknown>;
      const s = (window as unknown as { studio: { listOpenProjects: () => Promise<{ id: string }[]>; createTask: Fn; savePlan: Fn; startTask: Fn; getTask: Fn } }).studio;
      const projectId = (await s.listOpenProjects())[0]!.id;
      const t = (await s.createTask(projectId, 'x')) as { id: string };
      const bad = async (f: () => Promise<unknown>) => f().then(() => 'ok', (e: Error) => e.message);
      return {
        badMode: await bad(() => s.savePlan(projectId, t.id, { goal: 'g', criteria: [], mode: 'yolo', network: false })),
        fullTrustNoAck: await (async () => { await s.savePlan(projectId, t.id, { goal: 'g', criteria: [], mode: 'full_trust', network: false }); return bad(() => s.startTask(projectId, t.id, false)); })(),
        badId: await bad(() => s.getTask(projectId, '../../etc/passwd')),
        forgedProject: await bad(() => s.getTask('nonexistent-project', t.id)),
        apis: Object.keys(s).sort(),
      };
    });
    expect(r.badMode).toContain('无效的模式');
    expect(r.fullTrustNoAck).toContain('我已了解风险');
    expect(r.badId).toContain('找不到');
    expect(r.forgedProject).toContain('找不到');
    expect(r.apis).toEqual(['acceptDisclosure', 'ackDenied', 'addExtraDir', 'adjudicateDiscussion', 'chooseProject', 'closeProject', 'confirmCriterion', 'confirmDiscussionRequirements', 'confirmDiscussionSend', 'confirmOverall', 'continueTask', 'createTask', 'decideDiscussionApproval', 'deleteClaudeKey', 'detectEnvironment', 'discardTask', 'editReworkPermissions', 'getAcceptanceView', 'getAiSettings', 'getClaudeKeyStatus', 'getDisclosure', 'getDiscussionView', 'getProjectBrief', 'getProjectRoles', 'getSaveHistory', 'getTask', 'getWorkbench', 'initProject', 'listOpenProjects', 'listTasks', 'modifyDiscussionRequirements', 'onSaveProgress', 'openPreview', 'openRecent', 'projectStatus', 'recentProjects', 'recheck', 'rejectCriterion', 'removeExtraDir', 'resolveDiscussionFailure', 'retryCleanup', 'revealProject', 'reworkConflictTask', 'reworkTask', 'saveAiRoles', 'saveClaudeKey', 'savePlan', 'saveProjectBrief', 'saveProjectRoles', 'saveTask', 'saveUncheckedTask', 'sendDiscussionChat', 'skipDiscussion', 'skipPreview', 'startDiscussion', 'startTask', 'stopTask', 'undoFromHistory', 'undoSave']);
  });

  it('确定性并发控制：模拟 listTasks 延迟返回旧空列表期间创建任务不消失；模拟任务放弃后刷新正常移除', async () => {
    const proj = gitProject('stale-race-site');
    const a = await launch(mk('data'));
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await useFakeExecutor(a.app, [{ do: 'say', text: '完成' }]);
    await stubDialog(a.app, proj);

    // 1. 在主进程中拦截 tasks:list，让第一次调用挂起（受控延迟返回旧的空列表）
    await a.app.evaluate(({ ipcMain }) => {
      const orig = (ipcMain as any)._invokeHandlers.get('tasks:list');
      const g = globalThis as any;
      g.__staleResolvers = [];
      g.__blockFirstList = true;
      g.__mockEmptyList = false;

      ipcMain.removeHandler('tasks:list');
      ipcMain.handle('tasks:list', async (event, ...args) => {
        if (g.__mockEmptyList) {
          return { tasks: [], preferredMode: 'standard' };
        }
        if (g.__blockFirstList) {
          g.__blockFirstList = false;
          return new Promise((resolve) => {
            g.__staleResolvers.push(() => resolve({ tasks: [], preferredMode: 'standard' }));
          });
        }
        return orig(event, ...args);
      });
    });

    // 2. 打开项目：Tasks 挂载并触发挂起的 listTasks()
    await a.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await a.page.getByTestId('project').waitFor();

    // 3. 此时旧的 listTasks() 尚未返回（正在模拟延迟返回旧空列表），在此期间创建任务
    await newTask(a.page, '并发新建任务');
    await a.page.getByTestId('plan-card').waitFor();
    expect(await a.page.getByTestId('goal').inputValue()).toBe('并发新建任务');

    // 4. 释放之前挂起的旧 listTasks() 响应（返回旧的空列表 []）
    await a.app.evaluate(() => {
      const g = globalThis as any;
      g.__blockFirstList = false;
      for (const r of g.__staleResolvers) r();
      g.__staleResolvers = [];
    });
    await a.page.waitForTimeout(300);

    // 断言：由于 refreshSeq 请求序号机制，旧的空列表被判定过期并丢弃，新任务绝不会消失
    await a.page.getByTestId('plan-card').waitFor();
    expect(await a.page.getByTestId('goal').inputValue()).toBe('并发新建任务');
    await a.page.getByTestId('breadcrumb-project').click();
    expect(await a.page.getByTestId('task-list').innerText()).toContain('并发新建任务');

    // 5. 模拟任务在远端被放弃/删除（后续 listTasks 均返回空列表）
    await a.app.evaluate(() => {
      const g = globalThis as any;
      g.__mockEmptyList = true;
    });

    // 触发刷新（模拟任务被放弃后界面执行刷新操作）
    await a.page.evaluate(() => window.dispatchEvent(new CustomEvent('studio:refresh')));

    // 断言：由于删除了“合并保护”，远端已放弃/删除的任务在刷新后从列表中正常移除，不再残留
    await a.page.waitForFunction(() => document.querySelectorAll('[data-testid="task-list"] li').length === 0);
    expect(await a.page.getByTestId('task-list').count()).toBe(0);
    expect(await a.page.getByTestId('task-pane').count()).toBe(0);
  });
});

/**
 * M3-B4-2：保存 / 放弃 / 撤销接到界面（操作闭环）。执行体仍是 FakeExecutor（0 次真实调用）。
 * 【待维护者运行】这些用例需要真实窗口，执行会话的沙箱里跑不了；控制器层的同一批流程在 tests/b4-2-controller.test.ts 里已验证。
 */
const inState = (page: Page, state: string) => page.locator(`[data-testid="result"][data-state="${state}"]`).waitFor({ timeout: 30_000 });
const enabled = (page: Page, testId: string) => page.getByTestId(testId).isEnabled();
async function toReview(proj: string, script: unknown[], data = mk('data')) {
  const a = await openProjectWithFake(proj, script, data);
  await newTask(a.page, '改标题');
  await a.page.getByTestId('start-button').click();
  await inState(a.page, 'reviewing');
  return { ...a, data };
}
const confirmStep1 = async (page: Page) => {
  const b = page.getByTestId('skip-preview');
  if (await b.isVisible().catch(() => false)) {
    await b.click();
    await page.getByTestId('confirm-yes').click();
    await page.waitForFunction(() => !!document.querySelector('[data-testid="step1-status"]'));
  }
};

async function confirmThenSave(page: Page) {
  await confirmStep1(page);
  await page.getByTestId('confirm-overall').click();
  await page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);
  await page.getByTestId('save-button').click();
  await page.getByTestId('unchecked-confirm-panel').waitFor();
  await page.getByTestId('unchecked-confirm-save-button').click();
  await inState(page, 'saved');
}
const WRITE = [{ do: 'write', path: 'index.html', content: '<h1>new</h1>\n' }];
const readProj = (proj: string) => fs.readFileSync(path.join(proj, 'index.html'), 'utf8');

describe('验收、保存、放弃、撤销（B4-2，待维护者运行）', () => {
  it('保存成功 → 主项目里能看到；成果片段显示“原来 / 现在”；撤销 → 恢复（撤销入口始终可见）', async () => {
    const proj = gitProject('save-site', { 'index.html': '<h1>old</h1>\n' });
    const a = await toReview(proj, WRITE);
    expect(await a.page.getByTestId('hunk-before').first().innerText()).toContain('<h1>old</h1>');
    expect(await a.page.getByTestId('hunk-after').first().innerText()).toContain('<h1>new</h1>');
    expect(await a.page.getByTestId('result').innerText()).toContain('成果预览');
    expect(await a.page.getByTestId('result').innerText()).toContain('项目没有测试脚本，因此未检查');
    expect(await enabled(a.page, 'save-button')).toBe(false); // 还没确认
    expect(await a.page.getByTestId('save-reason').innerText()).toContain('请先确认');
    await shot(a.page, '8-验收卡');
    await confirmThenSave(a.page);
    expect(await a.page.getByTestId('verdict').innerText()).toContain('已保存到项目');
    expect(readProj(proj)).toBe('<h1>new</h1>\n');
    expect(await enabled(a.page, 'undo-button')).toBe(true);
    await a.page.getByTestId('undo-button').click();
    expect(await a.page.getByTestId('confirm-text').innerText()).not.toContain('任务副本以外'); // 标准模式没有外部影响
    await a.page.getByTestId('confirm-yes').click();
    await inState(a.page, 'undone');
    expect(await a.page.getByTestId('verdict').innerText()).toContain('已撤销');
    expect(readProj(proj)).toBe('<h1>old</h1>\n');
  });

  it('撤销条件不满足：按钮仍可见，置灰并写明原因', async () => {
    const proj = gitProject('undo-grey', { 'index.html': '<h1>old</h1>\n' });
    const a = await toReview(proj, WRITE);
    await confirmThenSave(a.page);
    fs.writeFileSync(path.join(proj, 'later.txt'), 'x');
    // 撤销条件由主进程实时判定：直接向主进程取最新视图
    const v = await a.page.evaluate(async () => {
      const s = (window as unknown as { studio: { listOpenProjects: () => Promise<{ id: string }[]>; listTasks: (projectId: string) => Promise<{ tasks: { id: string }[] }>; getAcceptanceView: (projectId: string, id: string) => Promise<{ actions: { undo: { enabled: boolean; reason?: string } } }> } }).studio;
      const projectId = (await s.listOpenProjects())[0]!.id;
      const t = (await s.listTasks(projectId)).tasks[0]!;
      return s.getAcceptanceView(projectId, t.id);
    });
    expect(v.actions.undo.enabled).toBe(false);
    expect(v.actions.undo.reason).toBe('这次保存之后项目还有其他修改，暂时不能只撤销这一项');
  });

  it('放弃：二次确认；完全信任任务的确认框先显示“无法撤销”的说明；项目不变', async () => {
    const proj = gitProject('discard-site', { 'index.html': '<h1>old</h1>\n' });
    const a = await openProjectWithFake(proj, WRITE);
    await newTask(a.page, '改标题');
    await a.page.getByTestId('mode-full-trust').check();
    await a.page.getByTestId('start-button').click();
    await a.page.getByTestId('trust-ack').check();
    await a.page.getByTestId('trust-confirm').click();
    await inState(a.page, 'reviewing');
    await a.page.getByTestId('discard-button').click();
    const text = await a.page.getByTestId('confirm-text').innerText();
    expect(text).toContain('AI 在任务副本以外做过的修改（如额外文件夹、联网操作）工作台无法撤销。');
    await a.page.getByTestId('confirm-no').click(); // 取消：什么都没发生
    expect(await a.page.getByTestId('confirm-panel').count()).toBe(0);
    expect(taskFiles(proj)[0]?.state).toBe('reviewing');
    await a.page.getByTestId('discard-button').click();
    await a.page.getByTestId('confirm-yes').click();
    await inState(a.page, 'discarded');
    expect(readProj(proj)).toBe('<h1>old</h1>\n');
  });

  it('检查失败时保存置灰；执行体失败也不能保存', async () => {
    const proj = gitProject('fail-site', { 'index.html': '<h1>old</h1>\n' });
    const a = await openProjectWithFake(proj, [...WRITE, { do: 'exit', code: 2 }]);
    await newTask(a.page, '改标题');
    await a.page.getByTestId('start-button').click();
    await a.page.getByTestId('stopped-page').waitFor({ timeout: 30_000 });
    await a.page.getByTestId('go-acceptance-button').click();
    await inState(a.page, 'reviewing');
    await a.page.getByTestId('result').waitFor({ timeout: 30_000 });
    expect(await a.page.getByTestId('verdict').innerText()).toContain('还不能保存');
    await confirmStep1(a.page);
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForTimeout(500);
    expect(await enabled(a.page, 'save-button')).toBe(false);
    expect(readProj(proj)).toBe('<h1>old</h1>\n');
  });

  it('验收失效 → 保存被拦下并突出“重新检查” → 重新检查后确认清空', async () => {
    const proj = gitProject('stale-site', { 'index.html': '<h1>old</h1>\n' });
    const a = await toReview(proj, WRITE);
    await confirmStep1(a.page);
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);
    fs.writeFileSync(path.join(taskFiles(proj)[0]!.worktree.path, 'index.html'), '<h1>sneaky</h1>\n'); // 确认之后副本内容变了
    await a.page.getByTestId('save-button').click();
    await a.page.getByTestId('action-message').waitFor();
    expect(await a.page.getByTestId('action-message').innerText()).toContain('原来的验收已失效');
    expect(await a.page.getByTestId('recheck-button').getAttribute('data-highlight')).toBe('true');
    expect(readProj(proj)).toBe('<h1>old</h1>\n');
    await a.page.getByTestId('recheck-button').click();
    await a.page.waitForFunction(() => !!document.querySelector('[data-testid="confirm-overall"]'));
    expect(await enabled(a.page, 'save-button')).toBe(false); // 确认已清空，需要重新确认
  });

  it('主项目有未保存修改：列出文件，不提供“帮我提交”', async () => {
    const proj = gitProject('dirty-main', { 'index.html': '<h1>old</h1>\n' });
    const a = await toReview(proj, WRITE);
    fs.writeFileSync(path.join(proj, 'notes.txt'), 'mine');
    await confirmStep1(a.page);
    await a.page.getByTestId('confirm-overall').click();
    await a.page.getByTestId('save-files').waitFor();
    const r = await a.page.evaluate(async () => {
      const s = (window as unknown as { studio: { listOpenProjects: () => Promise<{ id: string }[]>; listTasks: (projectId: string) => Promise<{ tasks: { id: string }[] }>; getAcceptanceView: (projectId: string, id: string) => Promise<{ actions: { save: { enabled: boolean; files?: string[] } } }> } }).studio;
      const projectId = (await s.listOpenProjects())[0]!.id;
      const t = (await s.listTasks(projectId)).tasks[0]!;
      return s.getAcceptanceView(projectId, t.id);
    });
    expect(r.actions.save.enabled).toBe(false);
    expect(r.actions.save.files).toEqual(['notes.txt']);
    expect(await a.page.getByRole('button', { name: /提交/ }).count()).toBe(0);
  });

  it('冲突（#11-save-conflict）：显示没有保存、冲突位置与后来改动，仅提供“重做”和“先不处理”（留在待验收）', async () => {
    const proj = gitProject('conflict-site', { 'index.html': '<h1>old</h1>\n' });
    const a = await toReview(proj, WRITE);
    await confirmStep1(a.page);
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);
    fs.writeFileSync(path.join(proj, 'index.html'), '<h1>other</h1>\n');
    git(proj, 'commit', '-q', '-am', 'other change');
    await a.page.getByTestId('save-button').click();
    await a.page.getByTestId('save-conflict-page').waitFor();
    expect(await a.page.getByTestId('verdict').innerText()).toBe('没有保存');
    expect(await a.page.getByTestId('conflict-files').innerText()).toContain('index.html');
    expect(await a.page.getByTestId('conflict-other').innerText()).toContain('项目里后来的改动');
    expect(await a.page.getByTestId('conflict-actions').locator('button').allInnerTexts()).toEqual([
      '让 AI 在最新项目上重做这部分',
      '先不处理',
    ]);
    expect(await a.page.getByTestId('save-conflict-page').innerText()).not.toMatch(/以这个任务为准|覆盖保存|仍然保存|强制保存/);
    expect(fs.existsSync(taskFiles(proj)[0]!.worktree.path)).toBe(true);
    await a.page.getByTestId('conflict-diff-toggle').click();
    await a.page.getByTestId('conflict-diff-body').waitFor();
    expect(await a.page.getByTestId('conflict-diff-body').innerText()).not.toMatch(/git merge|git diff/i);
    await a.page.getByTestId('conflict-defer-button').click();
    await a.page.getByTestId('board-col-reviewing').waitFor();
    expect(await a.page.locator('[data-testid="board-col-reviewing"] li[data-state="save_failed_unmerged"]').count()).toBe(1);
  });

  it('清理失败 → “需要处理”并给出“重试清理” → 重试成功', async () => {
    const proj = gitProject('cleanup-site', { 'index.html': '<h1>old</h1>\n' });
    const a = await toReview(proj, WRITE);
    const wt = taskFiles(proj)[0]!.worktree.path as string;
    git(proj, 'worktree', 'lock', wt);
    await a.page.getByTestId('discard-button').click();
    await a.page.getByTestId('confirm-yes').click();
    await inState(a.page, 'discard_cleanup_pending');
    expect(await a.page.getByTestId('result').innerText()).toContain('需要处理');
    expect(await a.page.getByTestId('result').innerText()).not.toMatch(/locked|fatal/);
    git(proj, 'worktree', 'unlock', wt);
    await a.page.getByTestId('retry-cleanup-button').click();
    await inState(a.page, 'discarded');
  });

  it('重复点击只生效一次；伪造参数被主进程拒绝', async () => {
    const proj = gitProject('dup-site', { 'index.html': '<h1>old</h1>\n' });
    const a = await toReview(proj, WRITE);
    await confirmStep1(a.page);
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);
    const r = await a.page.evaluate(async () => {
      type Fn = (...x: unknown[]) => Promise<{ ok: boolean; message: string; view: { version: string } }>;
      const s = (window as unknown as { studio: { listOpenProjects: () => Promise<{ id: string }[]>; listTasks: (projectId: string) => Promise<{ tasks: { id: string }[] }>; getAcceptanceView: (projectId: string, id: string) => Promise<{ version: string }>; saveTask: Fn; saveUncheckedTask: Fn; confirmCriterion: Fn } }).studio;
      const projectId = (await s.listOpenProjects())[0]!.id;
      const id = (await s.listTasks(projectId)).tasks[0]!.id;
      const version = (await s.getAcceptanceView(projectId, id)).version;
      await s.saveTask(projectId, id, version);
      const both = await Promise.all([s.saveUncheckedTask(projectId, id, version), s.saveUncheckedTask(projectId, id, version)]);
      const bad = (f: () => Promise<unknown>) => f().then(() => 'ok', (e: Error) => e.message);
      return {
        oks: both.filter((x) => x.ok).length,
        others: both.filter((x) => !x.ok).map((x) => x.message),
        forgedVersion: await bad(() => s.saveTask(projectId, id, 'latest')),
        forgedUncheckedVersion: await bad(() => s.saveUncheckedTask(projectId, id, 'latest')),
        forgedId: await bad(() => s.saveTask(projectId, '../x', version)),
        forgedProject: await bad(() => s.saveTask('../evil', id, version)),
        forgedItem: await bad(() => s.confirmCriterion(projectId, id, 'exit', version)),
      };
    });
    expect(r.oks).toBe(1);
    expect(r.forgedVersion).toContain('无效的参数');
    expect(r.forgedUncheckedVersion).toContain('无效的参数');
    expect(r.forgedId).toContain('无效的参数');
    expect(r.forgedProject).toContain('无效的项目编号');
    expect(r.forgedItem).toContain('无效的参数');
    expect(git(proj, 'rev-list', '--count', 'HEAD').toString().trim()).toBe('3'); // 初始 + 任务提交 + 合并提交，只保存了一次
  });

  it('重启后：已保存任务的状态与撤销按钮一致', async () => {
    const proj = gitProject('restart-site', { 'index.html': '<h1>old</h1>\n' });
    const data = mk('data');
    const a = await toReview(proj, WRITE, data);
    await confirmThenSave(a.page);
    await a.app.close();
    const b = await launch(data);
    await b.page.getByRole('button', { name: '暂不同意，先看看' }).click().catch(() => undefined);
    await stubDialog(b.app, proj);
    await b.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await b.page.getByTestId('task-list').waitFor();
    await b.page.getByTestId('task-list').getByRole('button').first().click();
    await inState(b.page, 'saved');
    expect(await enabled(b.page, 'undo-button')).toBe(true);
  });

  it('异常态：只读；没有保存/放弃/撤销按钮；有“在访达中显示项目”与“复制诊断摘要”；摘要不含命令与 Git 原文', async () => {
    const proj = gitProject('abnormal-site', { 'index.html': '<h1>old</h1>\n' });
    const data = mk('data');
    const a = await toReview(proj, WRITE, data);
    await a.app.close();
    await editTask(proj, taskFiles(proj)[0]!.id, (t) => {
      t.manualReview = { reason: '合并失败后，主项目的版本或文件与合并前不一致。', at: new Date().toISOString() };
      t.op = { kind: 'save', startedAt: 'x', phase: 'interrupted', steps: [{ at: 'x', name: '核验', ok: false, detail: 'fatal: CONFLICT npm run x' }] };
    });
    const b = await launch(data);
    await b.page.getByRole('button', { name: '暂不同意，先看看' }).click().catch(() => undefined);
    await stubDialog(b.app, proj);
    await b.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await b.page.getByTestId('task-list').waitFor();
    await b.page.getByTestId('task-list').getByRole('button').first().click();
    await b.page.getByTestId('readonly-panel').waitFor();
    expect(await b.page.getByTestId('readonly-panel').locator('button').allInnerTexts()).toEqual(['在访达中显示项目', '复制诊断摘要']);
    for (const id of ['save-button', 'discard-button', 'undo-button', 'recheck-button', 'retry-cleanup-button']) expect(await b.page.getByTestId(id).count()).toBe(0);
    const summary = await b.page.getByTestId('summary-text').innerText();
    expect(summary).toContain('项目状态异常，请不要继续操作');
    expect(summary).not.toMatch(/fatal|CONFLICT|npm run|git /);
    expect(await b.page.getByTestId('result').innerText()).not.toMatch(/fatal|CONFLICT|npm run/);
  });

  it('启动核对：保存中断后重启，任务在列表里标“已核对”并有一句话说明', async () => {
    const proj = gitProject('reconcile-site', { 'index.html': '<h1>old</h1>\n' });
    const data = mk('data');
    const a = await toReview(proj, WRITE, data);
    await a.app.close();
    const task = taskFiles(proj)[0]!;
    const preHead = git(proj, 'rev-parse', 'HEAD').toString().trim();
    const wt = task.worktree.path as string;
    const commit = git(wt, 'commit-tree', task.acceptedTree, '-p', task.worktree.baseSha, '-m', 'studio: x').toString().trim();
    git(proj, 'merge', '--no-ff', '-m', 'studio: 保存', commit);
    await editTask(proj, task.id, (t) => {
      t.op = { kind: 'save', startedAt: 'x', phase: 'task_committed', preHead, taskCommit: commit, steps: [] };
    });
    const b = await launch(data);
    await b.page.getByRole('button', { name: '暂不同意，先看看' }).click().catch(() => undefined);
    await stubDialog(b.app, proj);
    await b.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await b.page.getByTestId('reconciled-badge-list').waitFor();
    await b.page.getByTestId('task-list').getByRole('button').first().click();
    expect(await b.page.getByTestId('reconciled-note').innerText()).toMatch(/^已核对：/);
  });
});

describe('验收流程可用性改进（执行者显示、分步验收与成果预览）', () => {
  it('显示执行者：在计划卡、施工中与验收区显示实际执行者名称与模型（动态读取）', async () => {
    const proj = gitProject('executor-display-site', { 'index.html': '<h1>init</h1>\n' });
    const a = await openProjectWithFake(proj, [{ do: 'say', text: '工作中' }, ...WRITE], mk('data'));
    await newTask(a.page, '修改标题为新版本');
    // 计划卡展示执行者信息（开工前展示执行者名称）
    expect(await a.page.getByTestId('executor-info').innerText()).toBe('执行者：Codex');

    await a.page.getByTestId('start-button').click();
    // 施工中展示执行者信息与实际运行模型（Codex · fake）
    await a.page.waitForFunction(() => document.querySelector('[data-testid="executor-info"]')?.textContent?.includes('fake'));
    expect(await a.page.getByTestId('executor-info').innerText()).toBe('执行者：Codex · fake');

    // 验收阶段展示执行者信息与模型
    await inState(a.page, 'reviewing');
    expect(await a.page.getByTestId('executor-info').innerText()).toBe('执行者：Codex · fake');
  });

  it('验收状态（未完成 / 未通过 / 通过）与按钮层级联动：不符合隐藏保存并突出退回修改，符合后可保存', async () => {
    const proj = gitProject('steps-gating-site', { 'index.html': '<h1>init</h1>\n' });
    const a = await toReview(proj, WRITE);

    // 初始为「验收未完成」：保存按钮存在但置灰并附原因，退回修改为次要按钮
    expect(await a.page.getByTestId('acceptance-status').getAttribute('data-status')).toBe('incomplete');
    expect(await a.page.getByTestId('acceptance-status-label').innerText()).toBe('验收未完成');
    expect(await enabled(a.page, 'save-button')).toBe(false);
    expect(await a.page.getByTestId('save-reason').innerText()).toContain('请先确认');
    expect((await a.page.getByTestId('rework-button').getAttribute('class')) ?? '').toContain('secondary');

    // 点击打开预览：左栏预览区域展示已打开标记
    await a.page.getByTestId('preview-button').click();
    await a.page.getByTestId('preview-done').waitFor();
    expect(await a.page.getByTestId('preview-done').innerText()).toBe('已打开预览');

    // 选「不符合」：顶部状态变为「验收未通过」，保存按钮不出现，主按钮变为「退回修改」
    await a.page.getByTestId('reject-overall').click();
    await a.page.waitForFunction(() => document.querySelector('[data-testid="acceptance-status"]')?.getAttribute('data-status') === 'failed');
    expect(await a.page.getByTestId('acceptance-status-label').innerText()).toBe('验收未通过');
    expect(await a.page.getByTestId('save-button').count()).toBe(0);
    expect((await a.page.getByTestId('rework-button').getAttribute('class')) ?? '').not.toContain('secondary');

    // 改选「符合」：顶部状态变为「验收通过」，主按钮变为「验收通过并保存」
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null;
      return !!b && !b.disabled;
    });
    expect(await a.page.getByTestId('acceptance-status-label').innerText()).toBe('验收通过');
    expect(await enabled(a.page, 'save-button')).toBe(true);

    // 点击保存 → 未检查项目先显示确认面板 → 点「仍然保存」完成保存
    await a.page.getByTestId('save-button').click();
    await a.page.getByTestId('unchecked-confirm-panel').waitFor();
    await a.page.getByTestId('unchecked-confirm-save-button').click();
    await inState(a.page, 'saved');
  });

  it('未检查项目保存：第一次保存显示「打开预览 / 仍然保存」（主项目不变）→ 截图 → 点「仍然保存」完成保存', async () => {
    const proj = gitProject('unchecked-confirm-site', { 'index.html': '<h1>old</h1>\n' });
    const a = await toReview(proj, WRITE);
    await a.app.evaluate(({ shell }) => {
      shell.openExternal = async () => {};
    });

    await confirmStep1(a.page);
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);

    // 第一次点击保存：主项目不变，出现「打开预览」「仍然保存」确认框
    await a.page.getByTestId('save-button').click();
    await a.page.getByTestId('unchecked-confirm-panel').waitFor();
    expect(await a.page.getByTestId('result').getAttribute('data-state')).toBe('reviewing');
    expect(readProj(proj)).toBe('<h1>old</h1>\n');
    expect(await a.page.getByTestId('unchecked-confirm-reason').innerText()).toContain('没有配置可用的自动检查脚本');
    expect(await a.page.getByTestId('unchecked-preview-button').innerText()).toBe('打开预览');
    expect(await a.page.getByTestId('unchecked-confirm-save-button').innerText()).toBe('仍然保存');
    // 阶段 2 B9：未检查确认里「打开预览」改为主按钮，「仍然保存」为次要按钮
    expect((await a.page.getByTestId('unchecked-preview-button').getAttribute('class')) ?? '').not.toContain('secondary');
    expect((await a.page.getByTestId('unchecked-confirm-save-button').getAttribute('class')) ?? '').toContain('secondary');

    // 滚动到确认区并截图
    await a.page.getByTestId('unchecked-confirm-panel').scrollIntoViewIfNeeded();
    await shot(a.page, 'save-safety/unchecked-confirm');
    await stage2Shot(a.page, '07-unchecked-confirm');

    // 点击「打开预览」：同版本保留确认区
    await a.page.getByTestId('unchecked-preview-button').click();
    await a.page.getByTestId('unchecked-confirm-panel').waitFor();
    expect(readProj(proj)).toBe('<h1>old</h1>\n');

    // 点击「仍然保存」：完成保存并记录未检查字段
    await a.page.getByTestId('unchecked-confirm-save-button').click();
    await inState(a.page, 'saved');
    expect(readProj(proj)).toBe('<h1>new</h1>\n');
    expect(await a.page.getByTestId('save-record-check').innerText()).toBe('未检查');
    expect(await a.page.getByTestId('verdict').innerText()).toContain('未检查');
    expect(await a.page.getByTestId('unchecked-confirm-panel').count()).toBe(0);
    expect(taskFiles(proj)[0]?.saveRecord).toMatchObject({ checked: false, uncheckedKind: 'none' });
    expect(taskFiles(proj)[0]?.saveRecord?.uncheckedConfirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('成果预览：网页提供“在浏览器中打开预览”且保存前可用；非网页产物提供“在访达中显示”', async () => {
    // 1. 网页（含 index.html）
    const webProj = gitProject('preview-web-site', { 'index.html': '<h1>init</h1>\n' });
    const a = await toReview(webProj, [{ do: 'write', path: 'index.html', content: '<h1>web preview</h1>\n' }]);
    expect(await a.page.getByTestId('preview-button').innerText()).toBe('在浏览器中打开预览');
    // 在保存前点击预览
    await a.page.getByTestId('preview-button').click();
    await a.page.getByTestId('preview-done').waitFor();
    expect(await a.page.getByTestId('preview-done').innerText()).toBe('已打开预览');

    // 2. 非网页产物（不含 index.html）
    const docProj = gitProject('preview-finder-site', { 'README.md': 'init' });
    const b = await openProjectWithFake(docProj, [{ do: 'write', path: 'README.md', content: 'new content\n' }], mk('data'));
    await newTask(b.page, '更新说明文档');
    await b.page.getByTestId('start-button').click();
    await inState(b.page, 'reviewing');
    expect(await b.page.getByTestId('preview-button').innerText()).toBe('在访达中显示');
    await shot(b.page, '10-Finder预览验收');
  });

  it('预览打开失败：不标记为已查看，展示友好重试提示', async () => {
    const proj = gitProject('preview-fail-site', { 'index.html': '<h1>fail</h1>\n' });
    const a = await toReview(proj, WRITE);

    // 模拟预览打开失败
    await a.app.evaluate(({ shell }) => {
      shell.openExternal = async () => {
        throw new Error('simulated browser launch failure');
      };
    });

    // 点击打开预览
    await a.page.getByTestId('preview-button').click();

    // 收到失败提示，且不标记已打开预览
    await a.page.getByTestId('action-message').waitFor();
    expect(await a.page.getByTestId('action-message').innerText()).toBe('无法打开成果，请重试，或选择不查看直接验收');
    expect(await a.page.getByTestId('preview-done').count()).toBe(0);
    expect(await a.page.getByTestId('preview-button').isVisible()).toBe(true);

    await shot(a.page, 'acceptance-fix/open-failure');
  });
});

describe('环境体检', () => {
  it('每个检查项都显示五层状态（已安装/能启动/版本兼容/已登录/安全配置已核验）', async () => {
    const a = await launch(mk('data'));
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await a.page.locator('ul.env li').first().waitFor({ timeout: 60_000 });
    const items = a.page.locator('ul.env li');
    expect(await items.count()).toBe(4);
    for (let i = 0; i < 4; i++) {
      const labels = await items.nth(i).locator('[data-layer] dt').allInnerTexts();
      expect(labels).toEqual(['已安装', '能启动', '版本兼容', '已登录', '安全配置已核验']);
      for (const s of await items.nth(i).locator('[data-layer]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))) {
        expect(['pass', 'fail', 'unknown', 'na']).toContain(s);
      }
    }
    expect(await a.page.locator('ul.env li[data-id="git"]').getAttribute('data-overall')).toBe('pass');
    await shot(a.page, '2-环境体检');
  });

  it('项目 Node 版本不一致：版本兼容层不通过，并给出“怎么办”', async () => {
    const proj = gitProject('old-node', { 'index.html': 'x', '.nvmrc': '99\n' });
    const a = await launch(mk('data'));
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await stubDialog(a.app, proj);
    await a.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await a.page.getByTestId('project').waitFor();
    await a.page.getByTestId('nav-settings').click();
    await a.page.getByTestId('tab-settings-health').click();
    const compat = a.page.locator('ul.env li[data-id="node"] [data-layer="compatible"]');
    await compat.waitFor({ timeout: 60_000 });
    await a.page.waitForFunction(() => document.querySelector('ul.env li[data-id="node"] [data-layer="compatible"]')?.getAttribute('data-state') === 'fail', undefined, { timeout: 60_000 });
    expect(await a.page.locator('ul.env li[data-id="node"]').innerText()).toContain('请安装 Node 99');
  });

  it('从极简 PATH 启动（模拟 Dock/Finder 启动）：能通过补全路径找到 node，且不修改应用自身的 PATH', async () => {
    const minimal = '/usr/bin:/bin:/usr/sbin:/sbin';
    const brewNode = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => fs.existsSync(p));
    const a = await launch(mk('data'), { PATH: minimal });
    const seen = await a.app.evaluate(() => process.env.PATH);
    expect(seen).toBe(minimal);
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await a.page.locator('ul.env li').first().waitFor({ timeout: 60_000 });
    // 原始结果（供任务报告第 4 节引用）：应用看到的 PATH 与每个工具的发现方式
    const found = await a.page.locator('ul.env li').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-id'), overall: e.getAttribute('data-overall'), via: e.querySelector('[data-testid^="via-"]')?.textContent ?? '在应用看到的 PATH 中找到或未找到', installed: e.querySelector('[data-layer="installed"] dd')?.textContent })));
    console.info(`PATH-PROBE processPath=${seen}`);
    console.info(`PATH-PROBE items=${JSON.stringify(found)}`);
    if (brewNode) {
      expect(await a.page.getByTestId('via-node').innerText()).toContain('通过补全路径找到');
      expect(await a.app.evaluate(() => process.env.PATH)).toBe(minimal);
    }
  });
});

describe('多项目后台（阶段 2 第一部分）', () => {
  it('同时打开两个项目分别创建/运行任务互不干扰；施工中关闭被拒绝；停止后可关闭且可重开；伪造 projectId 被拒绝', async () => {
    const p1 = gitProject('multi-a', { 'a.txt': 'a\n' });
    const p2 = gitProject('multi-b', { 'b.txt': 'b\n' });
    const a = await openProjectWithFake(p1, [{ do: 'hang' }]);
    await stubDialog(a.app, p2);

    const res = await a.page.evaluate(async () => {
      type AnyStudio = {
        chooseProject: () => Promise<{ kind: string; status: { id: string; name: string } }>;
        listOpenProjects: () => Promise<{ id: string; name: string; runningCount: number }[]>;
        createTask: (projectId: string, req: string) => Promise<{ id: string }>;
        savePlan: (projectId: string, id: string, plan: { goal: string; criteria: string[]; mode: 'standard'; network: boolean }) => Promise<unknown>;
        startTask: (projectId: string, id: string, ack: boolean) => Promise<unknown>;
        stopTask: (projectId: string, id: string) => Promise<unknown>;
        getTask: (projectId: string, id: string) => Promise<{ state: string }>;
        listTasks: (projectId: string) => Promise<{ tasks: { id: string; request: string; state: string }[] }>;
        getWorkbench: () => Promise<{ counts: { needsDecision: number; running: number; recentEnded: number }; running: { projectId: string; taskName: string }[] }>;
        closeProject: (projectId: string) => Promise<{ ok: boolean; reason?: string }>;
        projectStatus: (projectId: string) => Promise<{ id: string; name: string }>;
      };
      const s = (window as unknown as { studio: AnyStudio }).studio;
      const open1 = (await s.listOpenProjects())[0]!;
      const opened2 = await s.chooseProject();
      const open2 = opened2.status;
      const bothOpen = await s.listOpenProjects();

      const t1 = await s.createTask(open1.id, '项目A持续施工');
      await s.savePlan(open1.id, t1.id, { goal: '项目A持续施工', criteria: [], mode: 'standard', network: false });
      const t2 = await s.createTask(open2.id, '项目B计划');
      await s.startTask(open1.id, t1.id, false);
      for (let i = 0; i < 100; i++) {
        if ((await s.getTask(open1.id, t1.id)).state === 'running') break;
        await new Promise((r) => setTimeout(r, 30));
      }

      const wbRunning = await s.getWorkbench();
      const closeBusy = await s.closeProject(open1.id);
      const list1 = await s.listTasks(open1.id);
      const list2 = await s.listTasks(open2.id);

      const forged = await s.listTasks('../evil').then(() => 'ok', (e: Error) => e.message);
      const unknown = await s.closeProject('nonexistent-proj').then(() => 'ok', (e: Error) => e.message);

      await s.stopTask(open1.id, t1.id);
      for (let i = 0; i < 100; i++) {
        if ((await s.getTask(open1.id, t1.id)).state !== 'running') break;
        await new Promise((r) => setTimeout(r, 30));
      }
      let closeIdle = await s.closeProject(open1.id);
      for (let i = 0; i < 50 && !closeIdle.ok; i++) {
        await new Promise((r) => setTimeout(r, 30));
        closeIdle = await s.closeProject(open1.id);
      }
      const afterClose = await s.listOpenProjects();
      return {
        open1Id: open1.id,
        open2Id: open2.id,
        bothLen: bothOpen.length,
        wbRunningCount: wbRunning.counts.running,
        wbRunningProject: wbRunning.running[0]?.projectId,
        closeBusy,
        list1Len: list1.tasks.length,
        list2Len: list2.tasks.length,
        forged,
        unknown,
        closeIdle,
        afterCloseIds: afterClose.map((p) => p.id),
      };
    });

    expect(res.bothLen).toBe(2);
    expect(res.wbRunningCount).toBe(1);
    expect(res.wbRunningProject).toBe(res.open1Id);
    expect(res.closeBusy.ok).toBe(false);
    expect(res.closeBusy.reason).toContain('正在施工');
    expect(res.list1Len).toBe(1);
    expect(res.list2Len).toBe(1);
    expect(res.forged).toContain('无效的项目编号');
    expect(res.unknown).toContain('找不到');
    expect(res.closeIdle).toEqual({ ok: true });
    expect(res.afterCloseIds).toEqual([res.open2Id]);

    await stubDialog(a.app, p1);
    const reopened = await a.page.evaluate(async () => {
      const s = (window as unknown as { studio: { chooseProject: () => Promise<{ kind: string; status: { id: string } }>; listOpenProjects: () => Promise<{ id: string }[]> } }).studio;
      const r = await s.chooseProject();
      const list = await s.listOpenProjects();
      return { kind: r.kind, id: r.status.id, count: list.length };
    });
    expect(reopened).toEqual({ kind: 'opened', id: res.open1Id, count: 2 });
  });
});

describe('应用外壳：侧栏、工作台、项目看板、任务页外框与首次引导（阶段 2 第二部分）', () => {
  it('启动 → 引导/工作台 → 打开两个项目 → 侧栏切换与固定宽度 → 进入任务页外框 → 回工作台，计数正确', async () => {
    const data = mk('data');
    const p1 = gitProject('site-one', { 'index.html': '<h1>one</h1>\n' });
    const p2 = gitProject('site-two', { 'index.html': '<h1>two</h1>\n' });
    const a = await launch(data);
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();

    // 按 prompt 选择剧本：task 请求含「持续施工」时挂起，否则改写 index.html
    await a.app.evaluate(
      async (_e, arg) => {
        const { createRequire } = process.getBuiltinModule('module');
        const req = createRequire(arg.codexUrl);
        const { CodexExecutor } = req(arg.codexPath);
        const { FakeExecutor } = req(arg.fakePath);
        CodexExecutor.prototype.start = function (opts: { prompt?: string }) {
          const steps = (opts.prompt ?? '').includes('持续施工') ? arg.hangScript : arg.writeScript;
          return new FakeExecutor(steps, { emitPermissions: true }).start(opts);
        };
      },
      {
        codexUrl: distUrl('executor/adapters/codex.js'),
        codexPath: fileURLToPath(distUrl('executor/adapters/codex.js')),
        fakePath: fileURLToPath(distUrl('executor/adapters/fake.js')),
        hangScript: [{ do: 'hang' }],
        writeScript: [{ do: 'write', path: 'index.html', content: '<h1>updated</h1>\n' }],
      },
    );

    // 1. 首次启动展示环境体检引导页
    await a.page.getByTestId('env-onboarding').waitFor();
    await a.page.locator('ul.env li').first().waitFor({ timeout: 60_000 });
    await stage2Shot(a.page, '06-env-onboarding');
    await a.page.getByTestId('onboarding-continue').click();
    await a.page.getByTestId('workbench').waitFor();

    const sidebarWidth = async () => (await a.page.getByTestId('sidebar').boundingBox())!.width;
    const wWorkbench = await sidebarWidth();
    expect(wWorkbench).toBeGreaterThanOrEqual(200);
    expect(wWorkbench).toBeLessThanOrEqual(220);

    // 2. 打开两个项目：site-one（完成到待验收），site-two（保持施工中）
    await stubDialog(a.app, p1);
    await a.page.getByTestId('nav-open-project').click();
    await a.page.getByTestId('project').waitFor();
    expect(await sidebarWidth()).toBe(wWorkbench);

    // 看板展示四列：讨论中 / 施工中 / 待验收 / 已结束（「讨论中」空列也保留展示提示）
    expect(await a.page.getByTestId('board-col-planning').isVisible()).toBe(true);
    expect(await a.page.getByTestId('board-col-planning').innerText()).toContain('还没有在讨论中的任务');
    expect(await a.page.getByTestId('board-col-building').isVisible()).toBe(true);
    expect(await a.page.getByTestId('board-col-reviewing').isVisible()).toBe(true);
    expect(await a.page.getByTestId('board-col-ended').isVisible()).toBe(true);
    const planBox = (await a.page.getByTestId('board-col-planning').boundingBox())!;
    const buildBox = (await a.page.getByTestId('board-col-building').boundingBox())!;
    expect(planBox.x).toBeLessThan(buildBox.x);

    await newTask(a.page, '任务一验收');
    await a.page.getByTestId('task-page').waitFor();
    expect(await a.page.getByTestId('breadcrumb-project').innerText()).toBe('site-one');
    expect(await a.page.getByTestId('stage-plan').getAttribute('data-status')).toBe('cur');
    expect(await a.page.getByTestId('stage-plan').innerText()).toBe('1 讨论');
    expect(await a.page.getByTestId('stage-build').getAttribute('data-status')).toBe('pending');
    expect(await a.page.getByTestId('stage-build').innerText()).toBe('2 施工');
    expect(await a.page.getByTestId('stage-accept').getAttribute('data-status')).toBe('pending');
    expect(await a.page.getByTestId('stage-accept').innerText()).toBe('3 验收');
    expect(await sidebarWidth()).toBe(wWorkbench);

    await a.page.getByTestId('start-button').click();
    await inState(a.page, 'reviewing');
    expect(await a.page.getByTestId('stage-plan').getAttribute('data-status')).toBe('done');
    expect(await a.page.getByTestId('stage-plan').innerText()).toBe('1 讨论 ✓');
    expect(await a.page.getByTestId('stage-build').getAttribute('data-status')).toBe('done');
    expect(await a.page.getByTestId('stage-build').innerText()).toBe('2 施工 ✓');
    expect(await a.page.getByTestId('stage-accept').getAttribute('data-status')).toBe('cur');
    expect(await a.page.getByTestId('stage-accept').innerText()).toBe('3 验收');
    await stage2Shot(a.page, '04-task-reviewing');

    await stubDialog(a.app, p2);
    await a.page.getByTestId('nav-open-project').click();
    await a.page.getByTestId('project').waitFor();
    await newTask(a.page, '任务二持续施工');
    await a.page.getByTestId('start-button').click();
    await a.page.getByTestId('run-view').waitFor();
    await a.page.getByTestId('perm-summary').waitFor({ timeout: 30_000 });
    expect(await a.page.getByTestId('stage-plan').getAttribute('data-status')).toBe('done');
    expect(await a.page.getByTestId('stage-build').getAttribute('data-status')).toBe('cur');
    await stage2Shot(a.page, '03-task-building');

    // 3. 在侧栏切换回 site-one 并截看板图
    const openList = await a.page.evaluate(() =>
      (window as unknown as { studio: { listOpenProjects: () => Promise<{ id: string; name: string }[]> } }).studio.listOpenProjects(),
    );
    const id1 = openList.find((x) => x.name === 'site-one')!.id;
    const id2 = openList.find((x) => x.name === 'site-two')!.id;
    await a.page.getByTestId(`nav-project-${id1}`).click();
    await a.page.getByTestId('board-col-reviewing').waitFor();
    expect(await a.page.getByTestId('board-col-reviewing').innerText()).toContain('任务一验收');
    expect(await a.page.getByTestId('board-col-planning').innerText()).toContain('还没有在讨论中的任务');
    await stage2Shot(a.page, '02-project-board');

    // 4. 回到工作台：核对三组汇总、筛选、侧栏角标与真实 workbench:get 一致（仅运行中任务的 site-two 角标不显示）
    await a.page.getByTestId('nav-workbench').click();
    await a.page.getByTestId('workbench').waitFor();
    await a.page.waitForFunction(() => document.querySelector('[data-testid="wb-running"]')?.textContent?.includes('任务二持续施工'));
    expect(await a.page.getByTestId('wb-needs-decision').innerText()).toContain('任务一验收');
    expect(await a.page.getByTestId('wb-running').innerText()).toContain('任务二持续施工');
    await stage2Shot(a.page, '01-workbench');

    const wb = await a.page.evaluate(() =>
      (window as unknown as { studio: { getWorkbench: () => Promise<{ counts: { needsDecision: number; running: number } }> } }).studio.getWorkbench(),
    );
    expect(await a.page.getByTestId('workbench-badge').innerText()).toBe(String(wb.counts.needsDecision));
    expect(await a.page.getByTestId(`project-badge-${id1}`).innerText()).toBe('1');
    expect(await a.page.getByTestId(`project-badge-${id2}`).count()).toBe(0);

    // 按项目筛选
    await a.page.getByTestId('workbench-filter').selectOption(id1);
    expect(await a.page.getByTestId('wb-needs-decision').innerText()).toContain('任务一验收');
    expect(await a.page.getByTestId('wb-running').innerText()).not.toContain('任务二持续施工');
    await a.page.getByTestId('workbench-filter').selectOption('all');

    // 侧栏折叠与展开
    await a.page.getByTestId('sidebar-toggle').click();
    expect(await a.page.getByTestId('sidebar').getAttribute('data-collapsed')).toBe('true');
    await a.page.getByTestId('sidebar-toggle').click();
    expect(await a.page.getByTestId('sidebar').getAttribute('data-collapsed')).toBe('false');

    // 设置页（只含 资料外发 / 环境体检）并截图
    await a.page.getByTestId('nav-settings').click();
    await a.page.getByTestId('settings-page').waitFor();
    expect(await sidebarWidth()).toBe(wWorkbench);
    await stage2Shot(a.page, '05-settings');

    // 停止运行中任务以 cleanly 退出
    await a.page.evaluate(async (pid) => {
      const s = (window as unknown as { studio: { listTasks: (p: string) => Promise<{ tasks: { id: string }[] }>; stopTask: (p: string, t: string) => Promise<unknown> } }).studio;
      for (const t of (await s.listTasks(pid)).tasks) await s.stopTask(pid, t.id);
    }, id2);
  });

  it('第一次启动显示环境体检引导；第二次启动直接进工作台且仅检测到问题时出现在需要你决定', async () => {
    const data = mk('data');
    const badNodeProj = gitProject('bad-node', { 'index.html': 'x', '.nvmrc': '99\n' });

    // 1. 首次启动：显示引导
    const a = await launch(data);
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await a.page.getByTestId('env-onboarding').waitFor({ timeout: 60_000 });
    await a.app.close();

    // 2. 第二次启动：直接进工作台，不再出现首次引导
    const b = await launch(data);
    await b.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await b.page.getByTestId('workbench').waitFor({ timeout: 60_000 });
    expect(await b.page.getByTestId('env-onboarding').count()).toBe(0);

    // 3. 打开 .nvmrc=99 项目触发环境问题 → 工作台「需要你决定」出现一条环境检查异常并可跳至设置环境体检
    await stubDialog(b.app, badNodeProj);
    await b.page.getByTestId('nav-open-project').click();
    await b.page.getByTestId('project').waitFor();
    await b.page.getByTestId('nav-workbench').click();
    await b.page.getByTestId('wb-entry-env:health').waitFor({ timeout: 60_000 });
    await b.page.getByTestId('wb-act-env:health').click();
    await b.page.getByTestId('settings-page').waitFor();
    await b.page.waitForFunction(
      () => document.querySelector('ul.env li[data-id="node"] [data-layer="compatible"]')?.getAttribute('data-state') === 'fail',
      undefined,
      { timeout: 60_000 },
    );
    expect(await b.page.locator('ul.env li[data-id="node"]').innerText()).toContain('请安装 Node 99');
  });
});

describe('阶段 3：施工计划确认、施工中、停止与中断后页（04-plan、05-build、06-stopped）', () => {
  it('计划确认页：两栏版式、额外目录风险如实说明（无“改为只读”）、approved 改验收标准退回 planned 并提示', async () => {
    const data = mk('data-s3-plan');
    const extraDir = mk('extra-assets');
    const proj = gitProject('s3-plan-site', {
      'index.html': '<h1>首页</h1>\n',
      'package.json': JSON.stringify({
        name: 's3-plan-site',
        scripts: { build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' },
      }),
    });

    const a = await openProjectWithFake(proj, WRITE, data);
    await newTask(a.page, '把首页标题改成欢迎使用并补充测试');
    await a.page.getByTestId('plan-card').waitFor();

    const planText0 = await a.page.getByTestId('plan-card').innerText();
    expect(planText0).not.toContain('改为只读');
    expect(planText0).not.toContain('更换');
    expect(planText0).not.toContain('导出');
    expect(await a.page.locator('[data-testid="plan-card"] button:not(.secondary):not(.link)').count()).toBe(1);
    expect(await a.page.getByTestId('stage-plan').getAttribute('data-status')).toBe('cur');
    await stage3Shot(a.page, '01-plan-standard');

    // 添加额外目录：只提供「移除」，如实说明标准模式对其余普通文件本就可读
    await stubDialog(a.app, extraDir);
    await a.page.getByTestId('add-dir').click();
    await a.page.waitForFunction((p) => document.querySelector('[data-testid="extra-dir-list"]')?.textContent?.includes(p), extraDir);
    const planTextExtra = await a.page.getByTestId('plan-card').innerText();
    expect(planTextExtra).toContain('可读写');
    expect(planTextExtra).toContain('AI 可以读取你电脑上的大部分文件。只有常见的密钥和账号凭证位置被挡住（例如 .ssh、云服务凭证）；其他地方保存的密码或密钥文件不在保护范围内。读到的内容会发送给执行者使用的 AI 服务。');
    expect(planTextExtra).not.toContain('改为只读');
    await stage3Shot(a.page, '02-plan-extra-dir');

    // 移除后，再测试在 approved 状态修改验收标准 -> 退回 planned 并出现重新确认提示
    await a.page.getByTestId('extra-dir-list').getByRole('button', { name: '移除' }).click();
    await a.page.waitForFunction(() => document.querySelector('[data-testid="extra-dir-list"]')?.textContent?.includes('没有额外的文件夹'));
    const taskId = taskFiles(proj)[0]!.id as string;
    await a.app.close();

    await editTask(proj, taskId, (t) => {
      t.state = 'approved';
      t.fullTrustConfirmedAt = '2026-11-10T10:00:00.000Z';
    });

    const b = await launch(data);
    await b.page.getByRole('button', { name: '暂不同意，先看看' }).click().catch(() => undefined);
    await stubDialog(b.app, proj);
    await b.page.getByTestId('nav-open-project').click();
    await b.page.getByTestId('project').waitFor();
    await b.page.getByRole('button', { name: /把首页标题/ }).click();
    await b.page.getByTestId('plan-card').waitFor();

    await b.page.getByTestId('add-criterion').click();
    await b.page.getByTestId('criterion-input-0').fill('深色模式下对比度清晰');
    await b.page.getByTestId('save-criteria-button').click();
    await b.page.getByTestId('criteria-reconfirm-notice').waitFor();
    expect(await b.page.getByTestId('criteria-reconfirm-notice').innerText()).toBe('改了验收标准，需要重新确认后才能开工');
    expect(taskFiles(proj)[0]?.state).toBe('planned');
    await stage3Shot(b.page, '03-plan-reapprove');
  });

  it('施工中与停止后页：执行日志默认收起且大白话、停止进停止页并显示 Git 实际改动与三选项、继续执行保留上轮改动', async () => {
    const proj = gitProject('s3-run-stop-site', { 'index.html': '<h1>v0</h1>\n' });
    const a = await openProjectWithFake(proj, [
      { do: 'say', text: '准备修改首页样式' },
      { do: 'write', path: 'index.html', content: '<h1>round1</h1>\n' },
      { do: 'hang' },
    ]);
    await newTask(a.page, '调整首页标题并补充新模块');
    await a.page.getByTestId('start-button').click();
    await a.page.getByTestId('run-view').waitFor();
    await a.page.waitForFunction(() => document.querySelector('[data-testid="progress"]')?.textContent?.includes('准备修改首页样式'), undefined, {
      timeout: 30_000,
    });
    // 给 Git worktree Diff 与日志渲染一点稳定时间
    await a.page.waitForFunction(() => document.querySelector('[data-testid="progress"]')?.textContent?.includes('index.html'), undefined, {
      timeout: 30_000,
    });

    expect(await a.page.getByTestId('exec-log').getAttribute('open')).toBeNull();
    expect(await a.page.getByTestId('stop-hint').innerText()).toContain('停止后，已做的修改保留在副本里');
    expect(await a.page.locator('[data-testid="run-view"] button').count()).toBe(1);
    await stage3Shot(a.page, '04-building');

    // 展开大白话执行日志后应可看到时间戳记录，随后收起
    await a.page.locator('[data-testid="exec-log"] summary').click();
    expect(await a.page.getByTestId('exec-log').getAttribute('open')).toBe('');
    expect(await a.page.getByTestId('exec-log').innerText()).toMatch(/\d{2}:\d{2}/);
    await a.page.locator('[data-testid="exec-log"] summary').click();

    // 停止 → 进入停止后页 #06-stopped
    await a.page.getByTestId('stop-button').click();
    await a.page.getByTestId('stopped-page').waitFor({ timeout: 30_000 });
    expect(await a.page.getByTestId('stopped-reason-tag').innerText()).toBe('你停止的');
    expect(await a.page.getByTestId('stopped-done').innerText()).toBe('任务副本相对开工时改动了 1 个文件');
    expect(await a.page.getByTestId('stopped-undone').innerText()).toContain('AI 没有走完全部步骤');
    expect(await a.page.getByTestId('stopped-project').innerText()).toBe('没有任何变化');
    expect(await a.page.getByTestId('stage-build').getAttribute('data-status')).toBe('cur');
    expect(await a.page.locator('[data-testid="stopped-page"] button:not(.secondary):not(.link)').count()).toBe(1);
    await stage3Shot(a.page, '06-stopped');

    // 点击「继续执行」复用同一个副本继续第二轮
    await useFakeExecutor(a.app, [
      { do: 'say', text: '继续补充第二部分修改' },
      { do: 'write', path: 'round2.txt', content: 'round2\n' },
    ]);
    await a.page.getByTestId('continue-button').click();
    await a.page.getByTestId('result').waitFor({ timeout: 30_000 });
    const resultText = await a.page.getByTestId('result').innerText();
    expect(resultText).toContain('index.html');
    expect(resultText).toContain('round2.txt');
  });

  it('施工中实时拦截展示「目前的问题」；AI 出错停下进入中断页', async () => {
    const pBlock = gitProject('s3-block-site', { 'index.html': '<h1>v0</h1>\n' });
    const a = await openProjectWithFake(pBlock, [
      { do: 'say', text: '尝试安装扩展依赖' },
      { do: 'block', request: { kind: 'network', target: 'https://registry.npmjs.org', summary: '尝试联网下载依赖包' } },
      { do: 'hang' },
    ]);
    await newTask(a.page, '安装扩展组件');
    await a.page.getByTestId('start-button').click();
    await a.page.getByTestId('build-problems').waitFor({ timeout: 30_000 });
    expect(await a.page.getByTestId('build-problems').innerText()).toContain('目前的问题（1）');
    expect(await a.page.locator('[data-testid="run-view"] button').count()).toBe(1);
    await stage3Shot(a.page, '05-building-blocked');
    await a.page.getByTestId('stop-button').click();
    await a.page.getByTestId('stopped-page').waitFor({ timeout: 30_000 });
    await a.app.close();

    const pFail = gitProject('s3-fail-site', { 'index.html': '<h1>v0</h1>\n' });
    const b = await openProjectWithFake(pFail, [
      { do: 'say', text: '开始改写配置' },
      { do: 'write', path: 'partial.txt', content: 'half\n' },
      { do: 'exit', code: 2 },
    ]);
    await newTask(b.page, '修改构建配置');
    await b.page.getByTestId('start-button').click();
    await b.page.getByTestId('stopped-page').waitFor({ timeout: 30_000 });
    expect(await b.page.getByTestId('stopped-reason-tag').innerText()).toBe('AI 执行出错');
    expect(await b.page.getByTestId('stopped-done').innerText()).toBe('任务副本相对开工时改动了 1 个文件');
    await stage3Shot(b.page, '07-failed-interrupted');
    await b.page.getByTestId('go-acceptance-button').click();
    await b.page.getByTestId('result').waitFor({ timeout: 30_000 });
  });
});

describe('阶段 4：验收页、检查依据、退回修改、多轮切换与读取说明（07-accept、08-evidence、09-rework）', () => {
  it('完整闭环：读取说明清单 → 验收未完成 → 检查依据脱敏 → 验收未通过 → 退回修改 → 第 2 轮轮次切换 → 验收通过并保存', async () => {
    const data = mk('data-s4');
    const proj = gitProject('s4-review-site', {
      'package.json': JSON.stringify({
        name: 's4-review-site',
        scripts: {
          build: 'node -e "console.log(\'build ok\')"',
          test: 'node run-tests.cjs',
        },
      }),
      'run-tests.cjs': [
        'const fs = require("node:fs");',
        'const html = fs.readFileSync("index.html", "utf8");',
        'console.log("> s4-review-site@1.0.0 test");',
        'console.log("SECRET_API_KEY=sk-proj-e2e-secret-999999");',
        'console.log("✓ 首页标题渲染正常 (4ms)");',
        'if (html.includes("round2")) {',
        '  console.log("✓ 包含 round2 新模块 (2ms)");',
        '  console.log("Tests 2 passed (2)");',
        '  process.exit(0);',
        '} else {',
        '  console.log("✗ 包含 round2 新模块 (2ms)");',
        '  console.log("Tests 1 failed | 1 passed (2)");',
        '  process.exit(1);',
        '}',
      ].join('\n'),
      'index.html': '<h1>initial</h1>\n',
    });

    const a = await openProjectWithFake(
      proj,
      [{ do: 'say', text: '完成第 1 轮改动' }, { do: 'write', path: 'index.html', content: '<h1>round1</h1>\n' }, { do: 'exit', code: 0 }],
      data,
    );
    await enableFakeChecks(a.app);
    await newTask(a.page, '升级首页并确保全部自动测试通过');
    await a.page.getByTestId('plan-card').waitFor();

    // 1. 添加两条验收标准，检查新的标准模式读取说明与动态敏感清单
    await a.page.getByTestId('add-criterion').click();
    await a.page.getByTestId('criterion-input-0').fill('首页标题清晰可读');
    await a.page.getByTestId('add-criterion').click();
    await a.page.getByTestId('criterion-input-1').fill('包含 round2 新模块并通过测试');

    await a.page.locator('[data-testid="blocked-read-locations"] summary').click();
    const blockedText = await a.page.getByTestId('blocked-read-locations').innerText();
    expect(blockedText).toContain('~/.ssh');
    expect(blockedText).toContain('~/.codex/auth.json');
    await stage4Shot(a.page, '08-read-access-wording');

    // 2. 第 1 轮施工 → 验收未完成
    await a.page.getByTestId('start-button').click();
    await a.page.getByTestId('result').waitFor({ timeout: 30_000 });
    expect(await a.page.getByTestId('acceptance-status').getAttribute('data-status')).toBe('incomplete');
    expect(await enabled(a.page, 'save-button')).toBe(false);
    await stage4Shot(a.page, '01-accept-incomplete');

    // 3. 查看检查依据（#08-evidence）：轮次/时间/沙箱/来源说明/脱敏详细记录
    await a.page.getByTestId('proof-link-test').click();
    await a.page.getByTestId('proof-page').waitFor();
    const proofText = await a.page.getByTestId('proof-page').innerText();
    expect(proofText).toContain('第 1 轮成果');
    expect(proofText).toContain('由本应用运行，不是 AI 自报');
    expect(proofText).toContain('沙箱环境');
    expect(proofText).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(proofText).toContain('首页标题渲染正常');
    expect(proofText).toContain('包含 round2 新模块');
    expect(await a.page.getByTestId('proof-details').getAttribute('open')).toBeNull();
    await stage4Shot(a.page, '03-proof-tests');

    await a.page.locator('[data-testid="proof-details"] summary').click();
    expect(await a.page.getByTestId('proof-details').getAttribute('open')).toBe('');
    const detailsText = await a.page.getByTestId('proof-details').innerText();
    expect(detailsText).not.toContain('sk-proj-e2e-secret-999999');
    expect(detailsText).not.toContain('SECRET_API_KEY');
    expect(detailsText).not.toContain('s4-review-site@1.0.0');
    await stage4Shot(a.page, '04-proof-details-expanded');
    await a.page.getByTestId('proof-back-button').click();
    await a.page.getByTestId('result').waitFor();

    // 4. 第 1 条「符合」，第 2 条「不符合」并写说明 → 验收未通过（无保存按钮，退回修改为主按钮）
    await a.page.getByTestId('confirm-c0').click();
    await a.page.getByTestId('reject-c1').click();
    await a.page.getByTestId('reject-note-c1').fill('测试第 2 项尚未通过，缺少 round2 标记');
    await a.page.getByTestId('save-note-c1').click();
    await a.page.waitForFunction(
      () =>
        document.querySelector('[data-testid="acceptance-status"]')?.getAttribute('data-status') === 'failed' &&
        !document.querySelector('[data-testid="pending-feedback"]') &&
        !document.querySelector('[data-testid="save-note-c1"]'),
    );
    expect(await a.page.getByTestId('save-button').count()).toBe(0);
    expect(await a.page.getByTestId('rework-button').getAttribute('class')).not.toContain('secondary');
    await stage4Shot(a.page, '02-accept-failed');

    // 5. 退回修改页（#09-rework）→ 填写反馈 → 第 2 轮施工
    await a.page.getByTestId('rework-button').click();
    await a.page.getByTestId('rework-page').waitFor();
    const reworkText = await a.page.getByTestId('rework-page').innerText();
    expect(reworkText).toContain('包含 round2 新模块并通过测试');
    expect(reworkText).toContain('测试第 2 项尚未通过，缺少 round2 标记');
    expect(reworkText).toContain('沿用上一轮');
    await a.page.getByTestId('rework-feedback').fill('请补充 round2 新模块并确保测试全部通过');
    await stage4Shot(a.page, '05-rework');

    await useFakeExecutor(a.app, [{ do: 'say', text: '完成第 2 轮修改' }, { do: 'write', path: 'index.html', content: '<h1>round2</h1>\n' }, { do: 'exit', code: 0 }]);
    await a.page.getByTestId('rework-start-button').click();
    await a.page.getByTestId('result').waitFor({ timeout: 30_000 });
    await a.page.waitForFunction(() => document.querySelector('[data-testid="round-tab-2"]')?.getAttribute('data-active') === 'true');

    // 验证第 2 轮视图 + 轮次切换器 + 切换查看第 1 轮只读历史
    expect(await a.page.getByTestId('round-feedback').innerText()).toContain('请补充 round2 新模块');
    await stage4Shot(a.page, '06-accept-round2-switcher');

    await a.page.getByTestId('round-tab-1').click();
    await a.page.getByTestId('historical-round-notice').waitFor();
    expect(await a.page.getByTestId('save-button').count()).toBe(0);
    await a.page.getByTestId('round-tab-2').click();
    await a.page.waitForFunction(() => !document.querySelector('[data-testid="historical-round-notice"]'));

    // 返回项目看板确认卡片显示「第 2 轮」，再回到任务页完成第 2 轮验收并保存
    await a.page.getByTestId('breadcrumb-project').click();
    await a.page.getByTestId('project').waitFor();
    expect(await a.page.getByTestId('task-round-badge').innerText()).toContain('第 2 轮');
    await a.page.locator('.card .card-title').first().click();
    await a.page.getByTestId('result').waitFor();

    // 6. 第 2 轮两条全部符合 → 验收通过 → 保存到主项目
    await a.page.getByTestId('confirm-c0').click();
    await a.page.getByTestId('confirm-c1').click();
    await a.page.waitForFunction(() => document.querySelector('[data-testid="acceptance-status"]')?.getAttribute('data-status') === 'passed');
    expect(await enabled(a.page, 'save-button')).toBe(true);
    await stage4Shot(a.page, '07-accept-passed');

    await a.page.getByTestId('save-button').click();
    await inState(a.page, 'saved');
    expect(await a.page.getByTestId('save-record-check').innerText()).toBe('检查通过');
    expect(readProj(proj)).toBe('<h1>round2</h1>\n');
  });
});

const STAGE5_CONTEXT_MD = `# 测试网站 — 项目背景卡

## 1. 一句话
面向独立创作者的作品展示站。

## 2. 核心信念
- 结构简单可逆，AI 自述不是证据。

## 4. 目标用户
独立设计师与创作者。
`;

const STAGE5_REF_MD = `# 视觉与交互约束

## 视觉规范
深色模式下需要保证配图与正文对比度足够清晰。
`;

describe('阶段 5a：讨论阶段界面、按思考者隔离对话、单/双模式与已知风险传递（E2E）', () => {
  it('双思考者讨论闭环：确认需求 → 依据核验 → 驳回阻塞意见并写理由 → 首席/复核独立对话 → 评审记录 → 批准进施工计划 → 施工进验收看风险', async () => {
    const data = mk('s5-dual-data');
    const proj = gitProject('s5-dual-site', {
      'index.html': '<h1>v0</h1>\n',
      'docs/PROJECT_CONTEXT.md': STAGE5_CONTEXT_MD,
      'docs/ref.md': STAGE5_REF_MD,
      '.gitignore': '.studio/\n',
    });
    const a = await launch(data, { STUDIO_DEV_PERSONAL_CLAUDE: '1' });
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await a.page.getByTestId('onboarding-continue').click();
    await a.page.getByTestId('workbench').waitFor();
    await useFakeThinkers(a.app, { withFindings: true });
    await useFakeExecutor(a.app, [{ do: 'say', text: '深色模式施工完成' }, { do: 'write', path: 'index.html', content: '<h1 data-theme="dark">v1</h1>\n' }, { do: 'exit', code: 0 }]);
    await stubDialog(a.app, proj);
    await a.page.getByTestId('nav-open-project').click();
    await a.page.getByTestId('project').waitFor();

    // 验证阶段 5 看板首列已改为「讨论中」
    expect(await a.page.getByTestId('board-col-planning').innerText()).toContain('讨论中');

    // 创建任务后直接进入讨论页（阶段条显示 1 讨论）
    await a.page.getByTestId('request').fill('网站增加深色模式，访客可以切换并记住选择');
    await a.page.getByTestId('create-task').click();
    await a.page.getByTestId('discussion-page').waitFor();
    expect(await a.page.getByTestId('stage-plan').innerText()).toBe('1 讨论');

    // 选用开发者预设并开始讨论
    await a.page.locator('input[name="discuss-preset"][value="dev-personal"]').check();
    await a.page.getByTestId('start-discussion-button').click();

    // 首次向 Claude Code CLI 外发确认 -> 同意 -> 停在需求条目确认
    await a.page.getByTestId('discussion-consent-allow').waitFor();
    await a.page.getByTestId('discussion-consent-allow').click();
    await a.page.getByTestId('discussion-reqs-confirm-card').waitFor();
    await stage5Shot(a.page, '01-confirm-requirements');

    // 确认并冻结需求 -> 向复核 Codex 外发确认 -> 同意 -> 停在裁决分歧
    await a.page.getByTestId('discussion-confirm-reqs').click();
    await a.page.getByTestId('discussion-consent-allow').waitFor();
    await a.page.getByTestId('discussion-consent-allow').click();
    await a.page.getByTestId('discussion-adjudication-list').waitFor();

    // 验证依据核验结果原文、修改需求入口、且未裁决前批准按钮置灰
    const basisText = await a.page.getByTestId('finding-basis-1').innerText();
    expect(basisText).toContain('提供了依据（文件存在）');
    expect(await enabled(a.page, 'approve-discussion-button')).toBe(false);
    expect(await a.page.getByTestId('approve-blocked-reason').innerText()).toContain('先裁决上面 1 条意见');
    await stage5Shot(a.page, '02-summary-adjudicate');

    // 展开驳回理由并填写
    await a.page.getByTestId('adjudicate-open-reject-1').click();
    await a.page.getByTestId('adjudicate-reason-1').fill('首版先保持主题切换简单，已接受装饰图风险');
    expect(await enabled(a.page, 'adjudicate-reject-1')).toBe(true);
    await stage5Shot(a.page, '03-reject-reason');

    // 提交驳回 -> 裁决列表清空，批准方案变为可点
    await a.page.getByTestId('adjudicate-reject-1').click();
    await a.page.waitForFunction(() => document.querySelectorAll('[data-testid="discussion-adjudication-list"]').length === 0);
    await a.page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="approve-discussion-button"]') as HTMLButtonElement | null;
      return !!btn && !btn.disabled;
    });

    // 与首席对话页签
    await a.page.getByTestId('discussion-tab-planner-chat').click();
    await a.page.getByTestId('discussion-planner-chat-panel').waitFor();
    expect(await a.page.getByTestId('planner-chat-modify-hint').innerText()).toContain('想改需求，请用「修改需求」');
    await a.page.getByTestId('planner-chat-input').fill('CSS 变量方案后续容易维护吗？');
    await a.page.getByTestId('planner-chat-send').click();
    await a.page.getByTestId('planner-chat-msg-assistant').waitFor();
    await stage5Shot(a.page, '04-chat-planner');

    // 与复核对话页签：显示“评审后的讨论 · 非独立评审”
    await a.page.getByTestId('discussion-tab-reviewer-chat').click();
    await a.page.getByTestId('discussion-reviewer-chat-panel').waitFor();
    await a.page.getByTestId('reviewer-chat-input').fill('除了配图对比度，主体开关设计有漏掉需求吗？');
    await a.page.getByTestId('reviewer-chat-send').click();
    await a.page.getByTestId('reviewer-chat-msg-assistant').waitFor();
    expect(await a.page.getByTestId('post-review-badge').innerText()).toBe('评审后的讨论 · 非独立评审');
    await stage5Shot(a.page, '05-chat-reviewer');

    // 评审记录（只读）页签
    await a.page.getByTestId('discussion-tab-record').click();
    await a.page.getByTestId('discussion-record-panel').waitFor();
    const recText = await a.page.getByTestId('discussion-record-panel').innerText();
    expect(recText).toContain('深色模式下现有装饰图片对比度未调整');
    expect(recText).toContain('缺少深色模式下实测截图对比');
    await stage5Shot(a.page, '06-review-record');

    // 批准方案 -> 进入施工计划确认页 -> 批准并开工 -> 进入验收页看到「你已知晓并接受的风险」
    await a.page.getByTestId('approve-discussion-button').click();
    await a.page.getByTestId('plan-card').waitFor();
    expect(await a.page.getByTestId('plan-unreviewed-badge').count()).toBe(0);

    await a.page.getByTestId('start-button').click();
    await a.page.getByTestId('result').waitFor({ timeout: 30_000 });
    await a.page.getByTestId('accepted-risks').waitFor();
    await a.page.getByTestId('accepted-risks').scrollIntoViewIfNeeded();
    const riskText = await a.page.getByTestId('accepted-risks').innerText();
    expect(riskText).toContain('深色模式下现有装饰图片对比度未调整');
    expect(riskText).toContain('首版先保持主题切换简单，已接受装饰图风险');
    await stage5Shot(a.page, '09-accepted-risks');
  });

  it('单思考者默认流程（未经独立评审、隐藏与复核对话、按次数统计费用）+ 尝试失败重试说明', async () => {
    const data = mk('s5-single-data');
    const proj = gitProject('s5-single-site', {
      'index.html': '<h1>v0</h1>\n',
      'docs/PROJECT_CONTEXT.md': STAGE5_CONTEXT_MD,
      '.gitignore': '.studio/\n',
    });
    const a = await launch(data);
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await a.page.getByTestId('onboarding-continue').click();
    await a.page.getByTestId('workbench').waitFor();
    await useFakeThinkers(a.app, { failDraftOnce: true, withFindings: false });
    await stubDialog(a.app, proj);
    await a.page.getByTestId('nav-open-project').click();
    await a.page.getByTestId('project').waitFor();

    await a.page.getByTestId('request').fill('单思考者深色切换任务');
    await a.page.getByTestId('create-task').click();
    await a.page.getByTestId('discussion-page').waitFor();
    expect(await a.page.getByTestId('discussion-unreviewed-badge').innerText()).toBe('未经独立评审');
    expect(await a.page.getByTestId('discussion-tab-reviewer-chat').count()).toBe(0);

    await a.page.getByTestId('start-discussion-button').click();
    await a.page.getByTestId('discussion-consent-allow').waitFor();
    await a.page.getByTestId('discussion-consent-allow').click();
    await a.page.getByTestId('discussion-reqs-confirm-card').waitFor();
    await a.page.getByTestId('discussion-confirm-reqs').click();

    // 起草第 1 次失败 -> 停在 attempt_failed
    await a.page.getByTestId('discussion-failure-card').waitFor();
    await stage5Shot(a.page, '08-attempt-failed');

    // 填写补充说明并重试 -> 成功进入单思考者 approval
    await a.page.getByTestId('discussion-failure-note').fill('请只修改首页顶部和全局 CSS 变量');
    await a.page.getByTestId('discussion-failure-retry-with').click();
    await a.page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="approve-discussion-button"]') as HTMLButtonElement | null;
      return !!btn && !btn.disabled;
    });

    // 验证：无复核对话 tab、展示未经独立评审、费用栏只按次数与时长统计（绝不出现 $）
    expect(await a.page.getByTestId('discussion-tab-reviewer-chat').count()).toBe(0);
    expect(await a.page.getByTestId('discussion-unreviewed-badge').innerText()).toBe('未经独立评审');
    expect(await a.page.getByTestId('budget-cost').innerText()).toBe('仅按次数与时长统计');
    await stage5Shot(a.page, '07-single-unreviewed');

    // 批准进入施工计划页后也持续带有「未经独立评审」标记
    await a.page.getByTestId('approve-discussion-button').click();
    await a.page.getByTestId('plan-card').waitFor();
    expect(await a.page.getByTestId('plan-unreviewed-badge').innerText()).toBe('未经独立评审');
  });
});

describe('阶段 5b：项目简介、Claude API Key 与 AI 角色配置（E2E）', () => {
  it('普通项目无 docs/PROJECT_CONTEXT.md：点开始讨论先填项目简介 → 保存并继续讨论，并在项目设置中查看/修改，绝不写入 docs/', async () => {
    const data = mk('s5b-brief-data');
    const proj = gitProject('s5b-ordinary-site', {
      'index.html': '<h1>普通项目首页</h1>\n',
      '.gitignore': '.studio/\n',
    });
    const a = await launch(data);
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await a.page.getByTestId('onboarding-continue').click();
    await a.page.getByTestId('workbench').waitFor();
    await useFakeThinkers(a.app, { withFindings: false });
    await stubDialog(a.app, proj);
    await a.page.getByTestId('nav-open-project').click();
    await a.page.getByTestId('project').waitFor();

    await a.page.getByTestId('request').fill('给普通项目加一个联系表单');
    await a.page.getByTestId('create-task').click();
    await a.page.getByTestId('discussion-page').waitFor();

    // 未填简介时点击开始讨论 → 弹出项目简介三问表单
    await a.page.getByTestId('start-discussion-button').click();
    await a.page.getByTestId('discussion-brief-card').waitFor();
    await stage5bShot(a.page, '01-project-brief-form');

    // 填写三个问题并提交 → 自动继续进入首次外发确认
    const briefCard = a.page.getByTestId('discussion-brief-card');
    await briefCard.getByLabel(/这个项目是什么/).fill('个人工作室作品集与接单主页');
    await briefCard.getByLabel(/有什么原则不能违反/).fill('不引入重型第三方 UI 框架，保证首屏秒开');
    await briefCard.getByLabel(/做给谁用/).fill('来访客户与独立设计师');
    await briefCard.getByRole('button', { name: /保存简介并开始讨论/ }).click();

    await a.page.getByTestId('discussion-consent-allow').waitFor();
    expect(fs.existsSync(path.join(proj, '.studio', 'project-brief.md'))).toBe(true);
    expect(fs.existsSync(path.join(proj, 'docs'))).toBe(false);

    // 切到项目设置查看已保存的项目简介卡片与 AI 角色卡片
    await a.page.getByTestId('breadcrumb-project').click();
    await a.page.getByTestId('project').waitFor();
    await a.page.getByTestId('tab-project-settings').click();
    await a.page.getByTestId('project-settings-brief').waitFor();
    await a.page.getByTestId('project-settings-roles').waitFor();
    expect(
      await a.page
        .getByTestId('project-settings-brief')
        .getByLabel(/这个项目是什么/)
        .inputValue(),
    ).toBe('个人工作室作品集与接单主页');
    await stage5bShot(a.page, '02-project-settings-brief');
  });

  it('假 Anthropic 服务：Key 验证失败 → 保存加密 Key 显示后 4 位 → 同 AI 提示 → 首席 Claude + 复核 Codex 双思考者讨论 → 删 Key 回退未设置', async () => {
    const VALID_KEY = 'sk-ant-fake-demo-4321';
    const INVALID_KEY = 'sk-ant-invalid-fake-0000';
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const keyHeader = String(req.headers['x-api-key'] ?? '');
        if (!keyHeader || keyHeader === INVALID_KEY || keyHeader.includes('invalid')) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid api key ${keyHeader}` } }));
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
          max_tokens?: number;
          messages?: { content?: string }[];
        };
        const userText = body.messages?.[0]?.content ?? '';
        let out: unknown = 'ok';
        if ((body.max_tokens ?? 0) > 32) {
          if (userText.includes('"resolutions"')) {
            out = {
              plan: '## 方案（Claude API 修订版）\n使用 CSS 变量实现主题切换，保留现有装饰图片并在验收记录标注已知风险。',
              resolutions: [{ index: 1, result: '交用户裁决', reason: '装饰图片暗色调节首版交由用户确认' }],
              item_marks: [
                { id: 'R1', mark: '保留' },
                { id: 'R2', mark: '保留' },
              ],
              additions: [],
            };
          } else if (userText.includes('"coverage"')) {
            out = {
              plan: '## 方案（Claude API 起草）\n用 CSS 变量切换主题并通过本地偏好持久保存。',
              coverage: [
                { id: 'R1', how: '顶部增加主题开关' },
                { id: 'R2', how: '写入本地存储恢复' },
              ],
            };
          } else {
            out = { items: [{ text: '增加浅色与深色切换开关' }, { text: '记住用户的外观偏好' }] };
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_e2e_ok',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            stop_reason: 'end_turn',
            content:
              typeof out === 'string'
                ? [{ type: 'text', text: out }]
                : [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: JSON.stringify(out) }],
            usage: (body.max_tokens ?? 0) > 32 ? { input_tokens: 420, output_tokens: 135 } : { input_tokens: 8, output_tokens: 2 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    servers.push(srv);
    const localMessagesUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1/messages`;

    const data = mk('s5b-roles-data');
    const proj = gitProject('s5b-claude-dual-site', {
      'index.html': '<h1>v0</h1>\n',
      'docs/PROJECT_CONTEXT.md': STAGE5_CONTEXT_MD,
      'docs/ref.md': STAGE5_REF_MD,
      '.gitignore': '.studio/\n',
    });

    const a = await launch(data);
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await a.page.getByTestId('onboarding-continue').click();
    await a.page.getByTestId('workbench').waitFor();

    // 在主进程内把发往 Anthropic Messages API 的请求转发到本地假 HTTP 服务，生产代码零测试开关
    await a.app.evaluate((_el, targetUrl) => {
      const origFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('https://api.anthropic.com/')) {
          return origFetch(targetUrl, init);
        }
        return origFetch(input, init);
      }) as typeof fetch;
    }, localMessagesUrl);

    // 1. 打开全局设置（默认进入「AI 与角色」页签）→ 验证未设置 Key 与未接入 AI 禁止保存
    await a.page.getByTestId('nav-settings').click();
    await a.page.getByTestId('settings-ai-connections').waitFor();
    expect(await a.page.getByTestId('claude-key-tag').innerText()).toBe('未设置');
    expect(await a.page.getByTestId('global-role-executor').innerText()).toContain('Codex');
    expect(await a.page.locator('select[data-testid*="executor"]').count()).toBe(0);
    await stage5bShot(a.page, '03-settings-unset');

    // 选择未接入的 Claude 作为首席 → 出现未接入提示且禁止保存
    await a.page.getByTestId('global-role-chief').selectOption('claude');
    await a.page.getByTestId('global-role-unconnected-warn').waitFor();
    expect(await enabled(a.page, 'global-roles-save')).toBe(false);
    await a.page.getByTestId('global-role-chief').selectOption('codex');

    // 2. 验证无效 Key → 报错「Key 无效」且不显示 Key 明文、不保存
    await a.page.getByTestId('claude-key-input').fill(INVALID_KEY);
    await a.page.getByTestId('claude-key-save').click();
    await a.page.getByTestId('claude-key-error').waitFor();
    const errText = await a.page.getByTestId('claude-key-error').innerText();
    expect(errText).toContain('Key 无效');
    expect(errText).not.toContain(INVALID_KEY);
    await stage5bShot(a.page, '04-settings-key-invalid');

    // 3. 输入合法假 Key → 假服务验证通过 + Electron safeStorage 加密保存 → 显示后 4 位
    await a.page.getByTestId('claude-key-input').fill(VALID_KEY);
    await a.page.getByTestId('claude-key-save').click();
    await a.page.waitForFunction(() => document.querySelector('[data-testid="claude-key-tag"]')?.textContent?.trim() === '可用');
    expect(await a.page.getByTestId('claude-key-summary').innerText()).toContain('尾号 4321');
    await stage5bShot(a.page, '05-settings-key-valid');

    // 校验真实 userData 磁盘文件不含 Key 明文
    const walkDisk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walkDisk(path.join(dir, e.name)) : [path.join(dir, e.name)],
      );
    for (const f of walkDisk(path.join(data, 'records'))) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toContain('fake-demo-4321');
    }

    // 4. 首席和复核都选 Claude → 出现「未经独立评审」说明
    await a.page.getByTestId('global-role-chief').selectOption('claude');
    await a.page.getByTestId('global-role-reviewer').selectOption('claude');
    await a.page.getByTestId('global-same-ai-notice').waitFor();
    expect(await a.page.getByTestId('global-same-ai-notice').innerText()).toContain('未经独立评审');
    await stage5bShot(a.page, '06-settings-same-ai');

    // 5. 启用假 Codex 复核并刷新「AI 与角色」状态后保存 首席=Claude / 复核=Codex
    await useFakeThinkers(a.app, { withFindings: true });
    await a.page.getByTestId('tab-settings-health').click();
    await a.page.getByTestId('tab-settings-ai').click();
    await a.page.getByTestId('global-role-chief').selectOption('claude');
    await a.page.getByTestId('global-role-reviewer').selectOption('codex');
    await a.page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="global-roles-save"]') as HTMLButtonElement | null;
      return !!btn && !btn.disabled;
    });
    await a.page.getByTestId('global-roles-save').click();
    await a.page.getByTestId('global-roles-notice').waitFor();

    // 6. 打开项目、创建任务并走双思考者讨论（Claude API 首席 + Codex 复核）
    await stubDialog(a.app, proj);
    await a.page.getByTestId('nav-open-project').click();
    await a.page.getByTestId('project').waitFor();
    await a.page.getByTestId('request').fill('网站增加主题外观切换并记住偏好');
    await a.page.getByTestId('create-task').click();
    await a.page.getByTestId('discussion-page').waitFor();
    expect(await a.page.getByTestId('discussion-roles').innerText()).toContain('首席：Claude（API）');
    expect(await a.page.getByTestId('discussion-roles').innerText()).toContain('复核：ChatGPT（Codex）');

    await a.page.getByTestId('start-discussion-button').click();
    await a.page.getByTestId('discussion-consent-allow').waitFor();
    expect(await a.page.getByTestId('discussion-consent-card').innerText()).toContain('Anthropic');
    await a.page.getByTestId('discussion-consent-allow').click();

    await a.page.getByTestId('discussion-reqs-confirm-card').waitFor();
    await a.page.getByTestId('discussion-confirm-reqs').click();

    // 复核 Codex 首次外发确认
    await a.page.getByTestId('discussion-consent-allow').waitFor();
    await a.page.getByTestId('discussion-consent-allow').click();

    // 停在裁决意见阶段：双思考者标签页（含与复核对话）、token 用量（无虚构 $）与角色全部可见
    await a.page.getByTestId('discussion-adjudication-list').waitFor();
    expect(await a.page.getByTestId('discussion-tab-reviewer-chat').count()).toBe(1);
    expect(await a.page.getByTestId('budget-tokens').innerText()).toContain('输入');
    expect(await a.page.getByTestId('budget-cost').innerText()).toContain('不估算金额');
    await stage5bShot(a.page, '07-discussion-dual-claude');

    // 7. 删除 Claude Key → 角色回退「未设置」，新建任务的讨论页在下一次开始前给出提示并拒绝启动
    await a.page.getByTestId('nav-settings').click();
    await a.page.getByTestId('claude-key-delete').click();
    await a.page.waitForFunction(() => document.querySelector('[data-testid="claude-key-tag"]')?.textContent?.trim() === '未设置');
    expect(await a.page.getByTestId('global-role-chief').inputValue()).toBe('unset');

    await a.page.getByTestId('nav-workbench').click();
    await a.page.getByTestId('workbench').waitFor();
    // 回到项目新建第二个未开始的任务
    await a.page.getByRole('button', { name: 's5b-claude-dual-site' }).first().click();
    await a.page.getByTestId('project').waitFor();
    await a.page.getByTestId('request').fill('新增第二项需求检验删 Key 后提示');
    await a.page.getByTestId('create-task').click();
    await a.page.getByTestId('discussion-page').waitFor({ timeout: 10_000 });
    await a.page.getByTestId('discussion-role-problem').waitFor({ timeout: 10_000 });
    expect(await a.page.getByTestId('discussion-role-problem').innerText()).toContain('未设置');
  });
});

describe('阶段 6 · 保存过程、冲突页、保存记录与撤销闭环（UI v2.1 #10-#12）', () => {
  it('实时 4 步保存进度（#10-save-result）→ 已保存 / 检查期间项目有变化 / 写入出错已安全恢复并重试成功', async () => {
    const checkScript = [
      "const fs = require('node:fs');",
      'setTimeout(() => {',
      "  console.log('Tests  3 passed');",
      '  process.exit(0);',
      '}, 1200);',
    ].join('\n');
    const proj = gitProject('stage6-progress-site', {
      'package.json': JSON.stringify({
        name: 's6-e2e-progress',
        scripts: { build: 'node -e "process.exit(0)"', test: 'node check.cjs' },
      }),
      'check.cjs': checkScript,
      'index.html': '<h1>v0</h1>\n',
      'other.txt': 'v0\n',
    });
    const data = mk('data-s6-p');
    const a = await launch(data);
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await enableFakeChecks(a.app);
    await useFakeExecutorQueue(a.app, [
      [{ do: 'write', path: 'index.html', content: '<h1>v1</h1>\n' }, { do: 'exit', code: 0 }],
      [{ do: 'write', path: 'index.html', content: '<h1>v2</h1>\n' }, { do: 'exit', code: 0 }],
    ]);
    await stubDialog(a.app, proj);
    await a.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await a.page.getByTestId('project').waitFor();

    // 任务 1：观察真实第 3 步（trial_checks）运行中进度，随后进入 saved
    await newTask(a.page, '更新首页标题并运行检查');
    await a.page.getByTestId('start-button').click();
    await inState(a.page, 'reviewing');
    await a.page.getByTestId('preview-button').click();
    await a.page.getByTestId('preview-done').waitFor();
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);
    await a.page.getByTestId('save-button').click();
    await a.page.locator('[data-testid="save-step-trial_checks"][data-status="running"]').waitFor({ timeout: 15_000 });
    await stage6Shot(a.page, '01-save-progress');

    await a.page.locator('[data-testid="save-result-panel"][data-outcome="saved"]').waitFor({ timeout: 20_000 });
    expect(await a.page.getByTestId('save-result-panel').innerText()).toContain('已保存。可以在保存记录里撤销');
    await stage6Shot(a.page, '02-save-result-saved');

    // 任务 2：先触发 project_changed（试检查期间主项目另行提交），再触发 failed_restored（临时写入 refs/heads/main.lock），清理锁后重试成功
    await a.page.getByTestId('save-outcome-btn-done').click();
    await a.page.getByTestId('project').waitFor();
    await newTask(a.page, '再次更新首页标题');
    await a.page.getByTestId('start-button').click();
    await inState(a.page, 'reviewing');
    await a.page.getByTestId('preview-button').click();
    await a.page.getByTestId('preview-done').waitFor();
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);

    await a.page.getByTestId('save-button').click();
    await a.page.locator('[data-testid="save-step-trial_checks"][data-status="running"]').waitFor({ timeout: 15_000 });
    fs.writeFileSync(path.join(proj, 'other.txt'), 'v1-during-check\n');
    git(proj, 'commit', '-q', '-am', 'concurrent commit');
    await a.page.locator('[data-testid="save-result-panel"][data-outcome="project_changed"]').waitFor({ timeout: 20_000 });
    expect(await a.page.getByTestId('save-result-panel').innerText()).toContain('检查期间项目又有新的改动，没有保存');
    await stage6Shot(a.page, '04-save-result-project-changed');

    // 点「重新保存」，在试检查运行到最后一步前短暂锁定 .git/index.lock → 真实触发 git merge --ff-only 写索引前失败并安全核验恢复（failed_restored）
    const lockFile = path.join(proj, '.git', 'index.lock');
    await a.page.getByTestId('save-outcome-btn-retry_save').click();
    await a.page.locator('[data-testid="save-step-trial_checks"][data-status="running"]').waitFor({ timeout: 15_000 });
    fs.writeFileSync(lockFile, 'e2e-lock');
    try {
      await a.page.locator('[data-testid="save-result-panel"][data-outcome="failed_restored"]').waitFor({ timeout: 20_000 });
    } finally {
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    }
    expect(await a.page.getByTestId('save-result-panel').innerText()).toContain('写入时出错，已把项目恢复并核对过与保存前一致');
    await stage6Shot(a.page, '05-save-result-failed-restored');

    await a.page.getByTestId('save-outcome-btn-retry_save').click();
    await a.page.locator('[data-testid="save-result-panel"][data-outcome="saved"]').waitFor({ timeout: 20_000 });
  });

  it('合并后检查失败（checks_failed）→ 试检查依据（#08-evidence）→ 点「退回修改」进入 #09-rework', async () => {
    const checkScript = [
      "const fs = require('node:fs');",
      "const a = fs.readFileSync('a.txt', 'utf8').trim();",
      "const b = fs.readFileSync('b.txt', 'utf8').trim();",
      "if (a === 'task' && b === 'main-new') { console.log('x FAIL incompatible_change'); process.exit(1); }",
      "console.log('Tests  2 passed');",
    ].join('\n');
    const proj = gitProject('stage6-checks-failed-site', {
      'package.json': JSON.stringify({
        name: 's6-cf',
        scripts: { build: 'node -e "process.exit(0)"', test: 'node check.cjs' },
      }),
      'check.cjs': checkScript,
      'a.txt': 'init\n',
      'b.txt': 'init\n',
    });
    const data = mk('data-s6-cf');
    const a = await launch(data);
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await enableFakeChecks(a.app);
    await useFakeExecutor(a.app, [{ do: 'write', path: 'a.txt', content: 'task\n' }, { do: 'exit', code: 0 }]);
    await stubDialog(a.app, proj);
    await a.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await a.page.getByTestId('project').waitFor();

    await newTask(a.page, '更新模块 A');
    await a.page.getByTestId('start-button').click();
    await inState(a.page, 'reviewing');
    await confirmStep1(a.page);
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);

    fs.writeFileSync(path.join(proj, 'b.txt'), 'main-new\n');
    git(proj, 'commit', '-q', '-am', 'main update b');

    await a.page.getByTestId('save-button').click();
    await a.page.locator('[data-testid="save-result-panel"][data-outcome="checks_failed"]').waitFor({ timeout: 20_000 });
    expect(await a.page.getByTestId('save-result-panel').innerText()).toContain('没有保存，你的项目没有变化');
    await stage6Shot(a.page, '03-save-result-checks-failed');

    // 打开试检查依据页再返回
    await a.page.getByTestId('save-outcome-btn-open_proof-test').click();
    await a.page.getByTestId('proof-page').waitFor();
    await a.page.getByTestId('proof-back-button').click();
    await a.page.locator('[data-testid="save-result-panel"][data-outcome="checks_failed"]').waitFor();

    // 主按钮「退回修改」进入 #09-rework
    await a.page.getByTestId('save-outcome-btn-rework').click();
    await a.page.getByTestId('rework-page').waitFor();
  });

  it('恢复未确认（manualReview）与项目锁定（project_locked）→ 任务 B 点「去处理」跳往异常任务 A', async () => {
    const proj = gitProject('stage6-locked-site', { 'index.html': '<h1>old</h1>\n', 'styles.css': 'body{}\n' });
    const data = mk('data-s6-lock');
    const a = await toReview(proj, WRITE, data);
    const taskA = taskFiles(proj)[0]!;
    await a.app.close();

    await editTask(proj, taskA.id, (t) => {
      t.manualReview = {
        reason: '写入中途出错，无法确认项目是否完好。',
        at: '2026-11-11T00:00:00Z',
        files: ['index.html', 'styles.css'],
      };
    });

    const b = await launch(data);
    await b.page.getByRole('button', { name: '暂不同意，先看看' }).click().catch(() => undefined);
    await useFakeExecutor(b.app, [{ do: 'write', path: 'other.txt', content: 'ok\n' }, { do: 'exit', code: 0 }]);
    await stubDialog(b.app, proj);
    await b.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await b.page.getByTestId('task-list').waitFor();

    // 1. 先打开异常任务 A：查看 #10-save-result manualReview + 受影响文件 + 锁定说明 + 只读面板
    await b.page.getByTestId('task-list').getByRole('button').first().click();
    await b.page.getByTestId('readonly-panel').waitFor();
    await b.page.locator('[data-testid="save-result-panel"][data-outcome="manual_review"]').waitFor();
    expect(await b.page.getByTestId('save-result-panel').innerText()).toContain('index.html');
    expect(await b.page.getByTestId('save-result-panel').innerText()).toContain('styles.css');
    expect(await b.page.getByTestId('save-result-panel').innerText()).toContain('这个项目的所有任务都不能保存或撤销');
    await stage6Shot(b.page, '06-save-result-manual-review');

    // 2. 创建任务 B 并准备验收 → 显示 project_locked 与「去处理」按钮 → 点击「去处理」直接跳转到任务 A
    await b.page.getByTestId('breadcrumb-project').click();
    await b.page.getByTestId('project').waitFor();
    await newTask(b.page, '正常任务乙');
    await b.page.getByTestId('start-button').click();
    await inState(b.page, 'reviewing');
    await confirmStep1(b.page);
    await b.page.getByTestId('confirm-overall').click();
    await b.page.locator('[data-testid="save-result-panel"][data-outcome="project_locked"]').waitFor();
    expect(await b.page.getByTestId('save-result-panel').innerText()).toContain('的保存出了问题还没处理，这个项目暂时不能保存');
    await stage6Shot(b.page, '07-save-result-project-locked');

    await b.page.getByTestId('save-outcome-btn-open_blocking_task').click();
    await b.page.getByTestId('readonly-panel').waitFor();
    expect(await b.page.getByTestId('task-title').innerText()).toBe(taskA.request);
  });

  it('保存冲突专页（#11-save-conflict）→ 展开两边片段对比 → 点「让 AI 在最新项目上重做这部分」→ 第 2 轮保存成功', async () => {
    const proj = gitProject('stage6-conflict-redo-site', {
      'package.json': JSON.stringify({ name: 's6-conf', scripts: { build: 'node -e "process.exit(0)"' } }),
      'shared.txt': 'line1\nline2\n',
      'extra.txt': 'init\n',
    });
    const data = mk('data-s6-conf');
    const a = await launch(data);
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await enableFakeChecks(a.app);
    await useFakeExecutorQueue(a.app, [
      [{ do: 'write', path: 'shared.txt', content: 'from-task-A\nline2\n' }, { do: 'exit', code: 0 }],
      [
        { do: 'write', path: 'shared.txt', content: 'from-task-B\nline2\n' },
        { do: 'write', path: 'extra.txt', content: 'from-task-B-extra\n' },
        { do: 'exit', code: 0 },
      ],
      [{ do: 'write', path: 'shared.txt', content: 'from-task-A + from-task-B\nline2\n' }, { do: 'exit', code: 0 }],
    ]);
    await stubDialog(a.app, proj);
    await a.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await a.page.getByTestId('project').waitFor();

    // 在同一基线上先后创建并跑完任务 1、任务 2
    await newTask(a.page, '任务一：更新顶部文本');
    await a.page.getByTestId('start-button').click();
    await inState(a.page, 'reviewing');

    await a.page.getByTestId('breadcrumb-project').click();
    await a.page.getByTestId('project').waitFor();
    await newTask(a.page, '任务二：重写标题栏');
    await a.page.getByTestId('start-button').click();
    await inState(a.page, 'reviewing');

    // 先保存任务 1
    await a.page.getByTestId('breadcrumb-project').click();
    await a.page.getByTestId('project').waitFor();
    await a.page.getByRole('button', { name: '任务一：更新顶部文本' }).click();
    await inState(a.page, 'reviewing');
    await confirmStep1(a.page);
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);
    await a.page.getByTestId('save-button').click();
    await inState(a.page, 'saved');

    // 再保存任务 2 → 触发冲突 → 展示 #11-save-conflict
    await a.page.getByTestId('save-outcome-btn-done').click();
    await a.page.getByTestId('project').waitFor();
    await a.page.getByRole('button', { name: '任务二：重写标题栏' }).click();
    await inState(a.page, 'reviewing');
    await confirmStep1(a.page);
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);
    await a.page.getByTestId('save-button').click();

    await a.page.getByTestId('save-conflict-page').waitFor({ timeout: 20_000 });
    expect(await a.page.getByTestId('conflict-files').innerText()).toContain('shared.txt');
    expect(await a.page.getByTestId('conflict-other').innerText()).toContain('任务一：更新顶部文本');
    await a.page.getByTestId('conflict-diff-toggle').click();
    await a.page.getByTestId('conflict-diff-body').waitFor();
    expect(await a.page.getByTestId('conflict-diff-left').innerText()).toContain('from-task-A');
    expect(await a.page.getByTestId('conflict-diff-right').innerText()).toContain('from-task-B');
    await stage6Shot(a.page, '08-save-conflict');

    // 点「让 AI 在最新项目上重做这部分」→ 进入第 2 轮 → 确认 → 保存成功
    await a.page.getByTestId('conflict-redo-button').click();
    await a.page.waitForFunction(
      () =>
        document.querySelector('[data-testid="result"][data-state="reviewing"]')?.getAttribute('data-state') === 'reviewing' &&
        document.querySelector('[data-testid="round-badge"]')?.textContent?.includes('第 2 轮'),
      undefined,
      { timeout: 30_000 },
    );
    await confirmStep1(a.page);
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);
    await a.page.getByTestId('save-button').click();
    await inState(a.page, 'saved');
    expect(fs.readFileSync(path.join(proj, 'shared.txt'), 'utf8')).toBe('from-task-A + from-task-B\nline2\n');
    expect(fs.readFileSync(path.join(proj, 'extra.txt'), 'utf8')).toBe('from-task-B-extra\n');
  });

  it('保存记录与撤销（#12-history）：倒序检查状态、项目外改动、仅最新可撤销、确认弹层、撤销后显示「撤销了…」与「已撤销」', async () => {
    const proj = gitProject('stage6-history-site', {
      'package.json': JSON.stringify({ name: 's6-hist', scripts: { build: 'node -e "process.exit(0)"' } }),
      'a.txt': 'v0\n',
      'b.txt': 'v0\n',
    });
    const data = mk('data-s6-h');
    const a = await launch(data);
    await a.page.getByRole('button', { name: '暂不同意，先看看' }).click();
    await enableFakeChecks(a.app);
    await useFakeExecutorQueue(a.app, [
      [{ do: 'write', path: 'a.txt', content: 'v1\n' }, { do: 'exit', code: 0 }],
      [
        { do: 'write', path: 'b.txt', content: 'v2\n' },
        { do: 'write', path: 'package.json', content: JSON.stringify({ name: 's6-hist', scripts: {} }) },
        { do: 'exit', code: 0 },
      ],
    ]);
    await stubDialog(a.app, proj);
    await a.page.getByRole('button', { name: '打开项目文件夹' }).click();
    await a.page.getByTestId('project').waitFor();

    // 1. 第一次保存：检查通过
    await newTask(a.page, '完善首页结构');
    await a.page.getByTestId('start-button').click();
    await inState(a.page, 'reviewing');
    await confirmStep1(a.page);
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);
    await a.page.getByTestId('save-button').click();
    await inState(a.page, 'saved');
    await a.page.getByTestId('save-outcome-btn-done').click();
    await a.page.getByTestId('project').waitFor();

    // 2. 插入一条项目外直接 Git 提交
    fs.writeFileSync(path.join(proj, 'notes.txt'), 'outside edit\n');
    git(proj, 'add', 'notes.txt');
    git(proj, 'commit', '-q', '-m', 'manual edit outside studio');

    // 3. 第二次保存（移除了脚本 → 未检查 + 用户确认时间）
    await newTask(a.page, '清理测试配置并补文案');
    await a.page.getByTestId('start-button').click();
    await inState(a.page, 'reviewing');
    await confirmStep1(a.page);
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);
    await a.page.getByTestId('save-button').click();
    await a.page.getByTestId('unchecked-confirm-panel').waitFor();
    await a.page.getByTestId('unchecked-confirm-save-button').click();
    await inState(a.page, 'saved');

    // 4. 点保存结果的「查看保存记录」进入 #12-history
    await a.page.getByTestId('save-outcome-btn-view_history').click();
    await a.page.getByTestId('project-history').waitFor();
    await a.page.getByTestId('history-entry-external').waitFor();

    const saveRows = a.page.getByTestId('history-entry-save');
    expect(await saveRows.count()).toBe(2);
    expect(await saveRows.nth(0).innerText()).toContain('清理测试配置并补文案');
    expect(await saveRows.nth(0).innerText()).toContain('未检查（没有检查脚本）');
    expect(await a.page.getByTestId('history-entry-external').innerText()).toContain('项目外的改动');
    expect(await saveRows.nth(1).innerText()).toContain('完善首页结构');
    expect(await saveRows.nth(1).innerText()).toContain('检查通过');
    expect(await a.page.getByTestId('history-undo-button').count()).toBe(1);
    await stage6Shot(a.page, '09-history');

    // 5. 点「撤销…」显示完整确认说明，再点「确认撤销」
    await a.page.getByTestId('history-undo-button').click();
    await a.page.getByTestId('history-undo-confirm').waitFor();
    const confirmText = await a.page.getByTestId('history-undo-confirm').innerText();
    expect(confirmText).toContain('清理测试配置并补文案');
    expect(confirmText).toContain('上一次保存之前');
    expect(confirmText).toContain('新增一次提交');
    await stage6Shot(a.page, '10-history-undo-confirm');

    await a.page.getByTestId('history-confirm-undo-yes').click();
    await a.page.getByTestId('history-entry-undo').waitFor();
    expect(await a.page.getByTestId('history-entry-undo').innerText()).toContain('撤销了 清理测试配置并补文案');
    expect(await saveRows.nth(0).getAttribute('data-undone')).toBe('true');
    expect(await saveRows.nth(0).getByTestId('history-undone-badge').innerText()).toBe('已撤销');
    expect(await a.page.getByTestId('history-undo-blocked').innerText()).toContain('挡住');
    expect(fs.readFileSync(path.join(proj, 'b.txt'), 'utf8')).toBe('v0\n');
    await stage6Shot(a.page, '11-history-after-undo');
  });
});

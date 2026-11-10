import { describe, it, expect, afterEach } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

const tmpDirs: string[] = [];
const apps: ElectronApplication[] = [];
const mk = (prefix: string) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `studio-e2e-${prefix}-`)));
  tmpDirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
function gitProject(name: string, files: Record<string, string> = { 'index.html': '<h1>hi</h1>' }): string {
  const d = path.join(mk('proj'), name);
  fs.mkdirSync(d);
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
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
    expect(await a.page.getByTestId('outbound-status').innerText()).toContain('已确认');
    expect(fs.existsSync(path.join(data, 'records', 'app', 'disclosure.json'))).toBe(true);
    await a.app.close();

    const b = await launch(data);
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
    expect(await a.page.getByTestId('outbound-status').innerText()).toContain('尚未确认');
    await a.page.locator('ul.env li').first().waitFor({ timeout: 60_000 }); // 体检仍可浏览
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
    expect(planText).toContain('其他位置 AI 仍可读取');
    expect(planText).toContain('允许联网（例如安装依赖）——开启后 AI 可访问任意网站。');
    expect(planText).toContain('允许修改另一个文件夹');
    expect(planText).toContain('没有可运行的构建或测试脚本');
    expect(planText).not.toMatch(/域名|限制网站|白名单/); // 不暗示能限制网站
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
    await a.page.getByTestId('result').waitFor({ timeout: 30_000 });
    const result = await a.page.getByTestId('result').innerText();
    expect(result).toContain('应用自己验证过的事实');
    expect(result).toContain('AI 报告以下操作未能完成');
    expect(result).toContain('这是 AI 自己的说法');
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
    expect(await a.page.getByTestId('fulltrust-badge-list').innerText()).toBe('完全信任'); // 列表里也有
    expect(taskFiles(proj)[0]?.fullTrustConfirmedAt).toBeTruthy();
    await a.page.getByTestId('stop-button').click();
    await a.page.getByTestId('result').waitFor({ timeout: 30_000 });
    expect(await a.page.getByTestId('result').getByTestId('fulltrust-badge').innerText()).toBe('完全信任'); // 结果里标记仍在
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
    expect(r.apis).toEqual(['acceptDisclosure', 'ackDenied', 'addExtraDir', 'chooseProject', 'closeProject', 'confirmCriterion', 'confirmOverall', 'createTask', 'detectEnvironment', 'discardTask', 'getAcceptanceView', 'getDisclosure', 'getTask', 'getWorkbench', 'initProject', 'listOpenProjects', 'listTasks', 'openPreview', 'openRecent', 'projectStatus', 'recentProjects', 'recheck', 'removeExtraDir', 'retryCleanup', 'revealProject', 'savePlan', 'saveTask', 'saveUncheckedTask', 'skipPreview', 'startTask', 'stopTask', 'undoSave']);
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
    expect(await a.page.getByTestId('task-list').innerText()).toContain('并发新建任务');

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
  if (await b.isVisible()) {
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
    expect(await a.page.getByTestId('result').innerText()).toContain('尚未提供预览，保存后自己打开看看，不满意可以撤销');
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
    const a = await toReview(proj, [...WRITE, { do: 'exit', code: 2 }]);
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

  it('冲突：只有“放弃”和“暂不处理”，没有保存与任何让 AI 继续修改的入口；成果仍保留', async () => {
    const proj = gitProject('conflict-site', { 'index.html': '<h1>old</h1>\n' });
    const a = await toReview(proj, WRITE);
    await confirmStep1(a.page);
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);
    fs.writeFileSync(path.join(proj, 'index.html'), '<h1>other</h1>\n');
    git(proj, 'commit', '-q', '-am', 'other change');
    await a.page.getByTestId('save-button').click();
    await inState(a.page, 'save_failed_unmerged');
    expect(await a.page.getByTestId('verdict').innerText()).toContain('AI 的修改与项目当前版本有冲突');
    expect(await a.page.getByTestId('actions').locator('button').allInnerTexts()).toEqual(['放弃', '暂不处理']);
    expect(await a.page.getByTestId('result').innerText()).not.toMatch(/让 ?AI|仍然保存|强制保存/);
    expect(fs.existsSync(taskFiles(proj)[0]!.worktree.path)).toBe(true);
    await a.page.getByTestId('defer-button').click();
    expect(await a.page.getByTestId('deferred-note').innerText()).toContain('仍然保留');
    await a.page.getByTestId('discard-button').click();
    await a.page.getByTestId('confirm-yes').click();
    await inState(a.page, 'discarded');
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

  it('理顺验收步骤：① 查看成果 → ② 确认验收标准 → ③ 保存到项目，按序门禁且每次点击有即时反馈', async () => {
    const proj = gitProject('steps-gating-site', { 'index.html': '<h1>init</h1>\n' });
    const a = await toReview(proj, WRITE);

    // 步骤结构完整存在
    expect(await a.page.getByTestId('step-1').isVisible()).toBe(true);
    expect(await a.page.getByTestId('step-2').isVisible()).toBe(true);
    expect(await a.page.getByTestId('step-3').isVisible()).toBe(true);

    // 未完成步骤 ① 前：步骤 ② 按钮不可点，并有一句话说明
    expect(await enabled(a.page, 'confirm-overall')).toBe(false);
    expect(await a.page.getByTestId('step2-reason').innerText()).toBe('请先完成「① 查看成果」，才能确认验收标准。');

    // 未完成步骤 ① 前：步骤 ③ 保存按钮不可点，并有一句话说明
    expect(await enabled(a.page, 'save-button')).toBe(false);
    expect(await a.page.getByTestId('save-reason').innerText()).toContain('请先确认已查看成果');

    // 点击完成步骤 ①：产生即时反馈，并使步骤 ② 可点击
    await a.page.getByTestId('preview-button').click();
    await a.page.waitForFunction(() => !!document.querySelector('[data-testid="step1-status"]'));
    expect(await a.page.getByTestId('step1-status').innerText()).toContain('已查看成果');
    expect(await a.page.getByTestId('step2-reason').count()).toBe(0);

    // 此时步骤 ② 可点击，但步骤 ③ 保存按钮仍不可点（提示确认标准）
    expect(await enabled(a.page, 'confirm-overall')).toBe(true);
    expect(await enabled(a.page, 'save-button')).toBe(false);
    expect(await a.page.getByTestId('save-reason').innerText()).toContain('请先确认“我已看过改动，结果符合我的要求”');

    // 截图保存修改后的分步验收界面
    await shot(a.page, '9-理顺验收步骤');

    // 点击步骤 ② 确认：步骤 ③ 变为可点击
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);
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

    // 滚动到确认区并截图
    await a.page.getByTestId('unchecked-confirm-panel').scrollIntoViewIfNeeded();
    await shot(a.page, 'save-safety/unchecked-confirm');

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
    await a.page.waitForFunction(() => !!document.querySelector('[data-testid="step1-status"]'));
    expect(await a.page.getByTestId('step1-status').innerText()).toContain('已查看成果');

    // 2. 非网页产物（不含 index.html）
    const docProj = gitProject('preview-finder-site', { 'README.md': 'init' });
    const b = await openProjectWithFake(docProj, [{ do: 'write', path: 'README.md', content: 'new content\n' }], mk('data'));
    await newTask(b.page, '更新说明文档');
    await b.page.getByTestId('start-button').click();
    await inState(b.page, 'reviewing');
    expect(await b.page.getByTestId('preview-button').innerText()).toBe('在访达中显示');
    await shot(b.page, '10-Finder预览验收');
  });

  it('跳过查看成果：点击“不查看成果，直接验收”弹确认框，确认后解锁第 ② 步并明确显示“已跳过查看”', async () => {
    const proj = gitProject('skip-preview-site', { 'index.html': '<h1>skip</h1>\n' });
    const a = await toReview(proj, WRITE);

    // 未完成步骤 ① 前，第 ② 步锁定
    expect(await enabled(a.page, 'confirm-overall')).toBe(false);
    expect(await a.page.getByTestId('step2-reason').innerText()).toBe('请先完成「① 查看成果」，才能确认验收标准。');
    expect(await a.page.getByTestId('skip-preview').isVisible()).toBe(true);

    // 点击“不查看成果，直接验收”，弹确认框
    await a.page.getByTestId('skip-preview').click();
    await a.page.getByTestId('confirm-panel').waitFor();
    expect(await a.page.getByTestId('confirm-text').innerText()).toBe('你还没有查看 AI 做出的成果，确定直接进入验收吗？');

    // 截图保存确认框
    await shot(a.page, 'acceptance-fix/skip-confirm');

    // 点击取消：确认框消失，第 ② 步保持锁定
    await a.page.getByTestId('confirm-no').click();
    expect(await a.page.getByTestId('confirm-panel').count()).toBe(0);
    expect(await enabled(a.page, 'confirm-overall')).toBe(false);

    // 再次点击并确认跳过
    await a.page.getByTestId('skip-preview').click();
    await a.page.getByTestId('confirm-yes').click();
    await a.page.waitForFunction(() => !!document.querySelector('[data-testid="step1-status"]'));

    // 步骤 ① 明确显示“已跳过查看”（不显示为“已查看”），步骤 ② 解锁
    expect(await a.page.getByTestId('step1-status').innerText()).toBe('已跳过查看');
    expect(await a.page.getByTestId('preview-done').innerText()).toBe('已跳过查看');
    expect(await enabled(a.page, 'confirm-overall')).toBe(true);
    expect(await a.page.getByTestId('step2-reason').count()).toBe(0);

    // 截图保存跳过后界面
    await shot(a.page, 'acceptance-fix/skipped-step1');

    // 能正常推进到步骤 ② 与 ③ 并保存
    await a.page.getByTestId('confirm-overall').click();
    await a.page.waitForFunction(() => !(document.querySelector('[data-testid="save-button"]') as HTMLButtonElement | null)?.disabled);
    expect(await enabled(a.page, 'save-button')).toBe(true);
    await a.page.getByTestId('save-button').click();
    await a.page.getByTestId('unchecked-confirm-panel').waitFor();
    await a.page.getByTestId('unchecked-confirm-save-button').click();
    await inState(a.page, 'saved');
  });

  it('预览打开失败：不标记为已查看，第 ② 步保持锁定，展示友好重试或跳过提示', async () => {
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

    // 收到失败提示
    await a.page.getByTestId('action-message').waitFor();
    expect(await a.page.getByTestId('action-message').innerText()).toBe('无法打开成果，请重试，或选择不查看直接验收');

    // 第 ① 步未标记为已查看，第 ② 步保持锁定
    expect(await a.page.getByTestId('step1-status').count()).toBe(0);
    expect(await a.page.getByTestId('preview-button').isVisible()).toBe(true);
    expect(await enabled(a.page, 'confirm-overall')).toBe(false);
    expect(await a.page.getByTestId('step2-reason').innerText()).toBe('请先完成「① 查看成果」，才能确认验收标准。');

    // 截图保存打开失败提示
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

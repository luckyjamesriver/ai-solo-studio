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
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, `${name}.png`) });
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
    expect(fs.existsSync(path.join(data, 'disclosure.json'))).toBe(true);
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
    expect(fs.existsSync(path.join(data, 'disclosure.json'))).toBe(false);
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
    const stored = JSON.parse(fs.readFileSync(path.join(data, 'recent-projects.json'), 'utf8'));
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
    expect(fs.existsSync(path.join(data, 'recent-projects.json'))).toBe(false);

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
const taskFiles = (proj: string) => {
  const dir = path.join(proj, '.studio', 'tasks');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, any>) : [];
};

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
    expect(result).toContain('检查「构建」');
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
    expect(await a.page.getByTestId('facts').innerText()).toContain('AI 执行过程是否正常结束：正常结束');
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
      const s = (window as unknown as { studio: { createTask: Fn; savePlan: Fn; startTask: Fn; getTask: Fn } }).studio;
      const t = (await s.createTask('x')) as { id: string };
      const bad = async (f: () => Promise<unknown>) => f().then(() => 'ok', (e: Error) => e.message);
      return {
        badMode: await bad(() => s.savePlan(t.id, { goal: 'g', criteria: [], mode: 'yolo', network: false })),
        fullTrustNoAck: await (async () => { await s.savePlan(t.id, { goal: 'g', criteria: [], mode: 'full_trust', network: false }); return bad(() => s.startTask(t.id, false)); })(),
        badId: await bad(() => s.getTask('../../etc/passwd')),
        apis: Object.keys(s).sort(),
      };
    });
    expect(r.badMode).toContain('无效的模式');
    expect(r.fullTrustNoAck).toContain('我已了解风险');
    expect(r.badId).toContain('找不到');
    expect(r.apis).toEqual(['acceptDisclosure', 'addExtraDir', 'chooseProject', 'createTask', 'detectEnvironment', 'getDisclosure', 'getTask', 'initProject', 'listTasks', 'openRecent', 'projectStatus', 'recentProjects', 'removeExtraDir', 'savePlan', 'startTask', 'stopTask']);
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

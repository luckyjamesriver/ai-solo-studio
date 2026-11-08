import { describe, it, expect, afterEach } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    if (brewNode) {
      expect(await a.page.getByTestId('via-node').innerText()).toContain('通过补全路径找到');
      expect(await a.app.evaluate(() => process.env.PATH)).toBe(minimal);
    }
  });
});

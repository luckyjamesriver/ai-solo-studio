// 冒烟测试：启动已构建的应用，通过 Chrome DevTools Protocol 检查标题、安全隔离、preload 白名单和环境体检。
// 用法：npm run smoke（会先 build）。任何断言失败或超过 30 秒，以非零退出码结束。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = createRequire(import.meta.url)('electron');
const TOTAL_TIMEOUT_MS = 30_000;
// B3-2：新增 8 个任务 API（编号 / 文字 / 计划表单 / 布尔值，没有任何路径参数）；清单仍然固定，多一个少一个都算失败
// B4-2：新增 9 个验收操作（参数只有编号、条目编号、验收版本）+ 1 个无参数的 revealProject（异常态“在访达中显示项目”）
// 阶段 5a：新增 9 个讨论与流程引擎驱动操作（固定参数形态 + projectId）
const EXPECTED_API = ['acceptDisclosure', 'ackDenied', 'addExtraDir', 'adjudicateDiscussion', 'chooseProject', 'closeProject', 'confirmCriterion', 'confirmDiscussionRequirements', 'confirmDiscussionSend', 'confirmOverall', 'continueTask', 'createTask', 'decideDiscussionApproval', 'detectEnvironment', 'discardTask', 'editReworkPermissions', 'getAcceptanceView', 'getDisclosure', 'getDiscussionView', 'getTask', 'getWorkbench', 'initProject', 'listOpenProjects', 'listTasks', 'modifyDiscussionRequirements', 'openPreview', 'openRecent', 'projectStatus', 'recentProjects', 'recheck', 'rejectCriterion', 'removeExtraDir', 'resolveDiscussionFailure', 'retryCleanup', 'revealProject', 'reworkTask', 'savePlan', 'saveTask', 'saveUncheckedTask', 'skipDiscussion', 'skipPreview', 'startDiscussion', 'startTask', 'stopTask', 'undoSave'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, what, deadline) {
  let last;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`等待超时：${what}${last ? `（${last.message}）` : ''}`);
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  };
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('DevTools 连接失败'));
  });
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, {
        resolve: (r) =>
          r.exceptionDetails ? reject(new Error(r.exceptionDetails.text)) : resolve(r.result.value),
        reject,
      });
      ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
  return { opened, evaluate, close: () => ws.close() };
}

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`);
  if (!ok) failures.push(name);
}

async function main() {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const port = await freePort();
  // 用临时的应用数据目录，避免污染真实的最近项目与外发确认记录
  const userData = mkdtempSync(path.join(os.tmpdir(), 'studio-smoke-'));
  const app = spawn(electronBin, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '.'], { cwd: root, stdio: 'ignore' });
  let exited = false;
  const exitP = new Promise((resolve) => app.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
  let cdp;
  try {
    const target = await waitFor(async () => {
      if (exited) throw new Error('应用提前退出');
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    }, '页面目标出现', deadline);
    cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.opened;

    // 等环境体检列表渲染完成
    // 体检含 Codex 只读自检，最多可能需要十几秒；冒烟总时限仍是 30 秒
    await waitFor(() => cdp.evaluate("document.querySelectorAll('ul.env li[data-overall]').length > 0"), '环境体检列表渲染', deadline);

    const title = await cdp.evaluate('document.title');
    check('document.title === "AI Solo Studio"', title === 'AI Solo Studio', JSON.stringify(title));

    const req = await cdp.evaluate('typeof require');
    check('typeof require === "undefined"', req === 'undefined', JSON.stringify(req));
    const proc = await cdp.evaluate('typeof process');
    check('typeof process === "undefined"', proc === 'undefined', JSON.stringify(proc));

    const keys = await cdp.evaluate('Object.keys(window.studio).sort()');
    check(
      `window.studio 恰好是 ${EXPECTED_API.join(', ')}`,
      JSON.stringify(keys) === JSON.stringify(EXPECTED_API),
      JSON.stringify(keys),
    );

    const git = await cdp.evaluate("document.querySelector('ul.env li[data-id=\"git\"]')?.getAttribute('data-overall') ?? null");
    check('环境体检中 Git 为 pass', git === 'pass', JSON.stringify(git));
    const layers = await cdp.evaluate("document.querySelectorAll('ul.env li[data-id=\"codex\"] [data-layer]').length");
    check('Codex 体检项有五层状态', layers === 5, JSON.stringify(layers));
  } catch (e) {
    check('冒烟流程', false, e.message);
  } finally {
    cdp?.close();
    if (!exited) app.kill('SIGTERM');
    const left = Math.max(1000, deadline - Date.now());
    const r = await Promise.race([exitP, sleep(left).then(() => null)]);
    if (!r) {
      check('应用在超时内正常退出（SIGTERM）', false, '超时，已强制结束');
      app.kill('SIGKILL');
    } else {
      console.log(`INFO  应用已退出（code=${r.code}, signal=${r.signal}）`);
    }
  }
}

const watchdog = setTimeout(() => {
  console.error('FAIL  冒烟测试超过 30 秒');
  process.exit(1);
}, TOTAL_TIMEOUT_MS + 6000);

await main();
clearTimeout(watchdog);
if (failures.length) {
  console.error(`\n冒烟测试失败：${failures.length} 项`);
  process.exit(1);
}
console.log('\n冒烟测试通过');

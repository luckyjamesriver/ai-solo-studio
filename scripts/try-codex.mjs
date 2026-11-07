// 本机试用：在临时 Git 仓库里用 TaskRunner + Codex 适配器完整走一遍小任务。
// 用法：npm run try:codex            每个审批请求由你输入 y/n，结束后询问保存或撤销
//       npm run try:codex -- --auto  自动答复：worktree 内允许、其他拒绝；结束后自动撤销（用于脚本化验证）
//       --probe-outside              额外要求执行体尝试写一个任务文件夹之外的文件，用来演示越界审批（是否真的尝试取决于模型）
// 需要本机已安装并登录 Codex（codex login）。会调用真实模型。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = (p) => import(path.join(root, 'dist-electron', p));
const { TaskRunner } = await dist('core/task/runner.js');
const { CodexExecutor } = await dist('core/executor/adapters/codex.js');
const G = await dist('core/git/git.js');

const auto = process.argv.includes('--auto');
const probeOutside = process.argv.includes('--probe-outside');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q) => (await rl.question(q)).trim().toLowerCase();
const say = (s = '') => console.log(s);
const LEVEL = { low: '【低风险】', medium: '【中风险】', high: '【高风险】' };
const STATUS = { verified: '✔ 已验证', failed: '✘ 失败', not_checked: '– 未检查', user_confirmed: '✔ 你已确认', user_rejected: '✘ 你已否决', pending_user: '? 等你确认' };

const executor = new CodexExecutor();
const env = await executor.detect();
say(`Codex：${env.installed ? '已安装' : '未安装'}，登录状态 ${env.loggedIn}${env.version ? `，${env.version}` : ''}${env.note ? `（${env.note}）` : ''}`);
if (!env.installed || env.loggedIn !== 'yes') {
  say('请先安装 Codex 并运行 `codex login`。');
  process.exit(1);
}

const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'try-codex-')));
await fs.writeFile(path.join(repo, 'index.html'), '<!doctype html>\n<html><body>\n<p>我的小网站</p>\n</body></html>\n');
await G.initRepo(repo);
say(`临时项目：${repo}`);

const runner = new TaskRunner({ repo, executor, runChecks: false, timeoutMs: 5 * 60_000 });
runner.on('permission', async (p) => {
  const r = p.risk;
  say('');
  say(`—— 审批请求 ${LEVEL[r.level]}${r.reversible ? '（可通过撤销恢复）' : '（撤销任务无法恢复）'}`);
  say(`   ${r.explanation}`);
  say(`   内容：${p.request.description.split('\n').join('\n         ')}`);
  let answer;
  if (auto) {
    answer = r.level === 'high' ? 'n' : 'y';
    say(`   [--auto] 策略：worktree 内允许、其他拒绝 → ${answer}`);
  } else answer = await ask('   允许吗？(y/n) ');
  await runner.respond(p.taskId, p.request.id, answer === 'y' ? 'allow' : 'deny');
});

const task = await runner.create('在 index.html 中加入一个文字为 Hello 的 h1');
await runner.setPlan(task.id, {
  goal: '在 index.html 中加入 Hello 标题',
  inScope: ['在 index.html 的 body 里加入 <h1>Hello</h1>'],
  outOfScope: ['其他文件'],
  criteria: ['index.html 里有文字为 Hello 的 h1'],
  risks: [],
  irreversible: [],
});
await runner.approve(task.id);
say('\n开始施工…（执行体的消息会显示在下面）');
runner.on('update', (() => { let seen = 0; return (t) => { for (const e of t.timeline.slice(seen)) if (e.kind !== 'state') say(`   · [${e.kind}] ${e.text.split('\n')[0].slice(0, 160)}`); seen = t.timeline.length; }; })());

const outside = path.join(await fs.realpath(os.tmpdir()), `try-codex-outside-${Date.now()}.txt`);
const probePrompt = [
  '请依次做两件事：',
  '1. 在当前目录的 index.html 的 body 里加入 <h1>Hello</h1>。',
  `2. 然后运行命令：printf hi > ${outside} ，把文字 hi 写入这个任务文件夹之外的绝对路径。如果被拒绝，就说明情况并停止，不要换别的方式。`,
].join('\n');
const done = await (probeOutside ? runner.start(task.id, probePrompt) : runner.start(task.id));
if (probeOutside) say(`越界文件 ${outside} 是否存在：${await fs.access(outside).then(() => '是！', () => '否')}`);
const card = done.card;
say('\n===== 验收卡 =====');
say(card.headline);
for (const i of card.items) say(`  ${STATUS[i.status] ?? i.status}  ${i.label} —— ${i.evidence}`);
say('  改动：');
for (const c of card.changes) say(`    ${c.status} ${c.path} (+${c.additions} -${c.deletions})`);
say(`  可以保存：${card.readyToSave ? '是' : '否（还需要你确认验收标准）'}`);
say(`  主线 index.html 仍是原样：${(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).includes('<h1') ? '否！' : '是'}`);

let choice = 'd';
if (auto) say('\n[--auto] 自动选择：撤销');
else {
  for (let i = 0; i < done.criteria.length; i++) {
    const a = await ask(`验收标准「${done.criteria[i].text}」达成了吗？(y/n) `);
    await runner.confirm(task.id, { criterion: i, decision: a === 'y' ? 'confirmed' : 'rejected' });
  }
  choice = await ask('保存到项目(s)，还是撤销(d)？ ');
}
if (choice === 's') {
  const r = await runner.save(task.id);
  say(r.ok ? '已保存到主线。' : `没有保存：${r.detail}`);
} else {
  await runner.discard(task.id);
  say('已撤销，主线没有改动。');
}
rl.close();
say(`\n临时项目保留在 ${repo}（可自行删除）。`);

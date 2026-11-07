// 假的 codex 命令行：只实现 --version 与 login status，用于测试 detect()。
// FAKE_LOGIN=yes|no|broken 控制登录状态。
const a = process.argv.slice(2);
if (a[0] === '--version') { console.error('WARNING: proceeding, even though we could not create PATH aliases'); console.log('codex-cli 9.9.9'); }
else if (a[0] === 'login' && a[1] === 'status') {
  const s = process.env.FAKE_LOGIN ?? 'yes';
  if (s === 'yes') { console.error('Logged in using ChatGPT'); process.exit(0); }
  if (s === 'no') { console.error('Not logged in'); process.exit(1); }
  console.error('something unexpected'); process.exit(2);
} else process.exit(64);

// 测试用子进程：像“另一个应用进程”一样持有数据目录租约（直接用 proper-lockfile），直到标准输入关闭。
// 用法：node lock-hold.mjs <锁文件路径>
import lockfile from 'proper-lockfile';

const file = process.argv[2];
try {
  await lockfile.lock(file, { stale: 5000, update: 1000, retries: 0 });
  process.stdout.write('READY\n');
} catch (e) {
  process.stdout.write(`FAILED ${e.code ?? e.message}\n`);
  process.exit(2);
}
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));

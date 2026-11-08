// 测试用子进程：像“另一个应用进程”一样尝试取得数据目录租约；取得则立即释放。输出 OK 或 LOCKED。
// 用法：node lock-try.mjs <锁文件路径>
import lockfile from 'proper-lockfile';

const file = process.argv[2];
try {
  const release = await lockfile.lock(file, { stale: 5000, retries: 0 });
  await release();
  process.stdout.write('OK\n');
} catch (e) {
  process.stdout.write(`${e.code === 'ELOCKED' ? 'LOCKED' : `ERROR ${e.message}`}\n`);
}

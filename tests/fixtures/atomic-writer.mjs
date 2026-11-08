// 测试用子进程：用 write-file-atomic 不停地覆盖写同一个文件（每次内容更大、带递增的修订号），等着被 SIGKILL。
// 用法：node atomic-writer.mjs <目标文件路径>
import writeFileAtomic from 'write-file-atomic';

const file = process.argv[2];
process.stdout.write('READY\n');
for (let rev = 1; ; rev++) {
  const payload = { revision: rev, filler: 'x'.repeat(300_000 + (rev % 7) * 50_000) };
  await writeFileAtomic(file, JSON.stringify(payload));
}

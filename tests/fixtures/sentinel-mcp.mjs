// 哨兵 MCP：被启动就把一行写进 SENTINEL_FILE，然后保持存活。仅用于隔离测试。
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.SENTINEL_FILE, `started pid=${process.pid}\n`);
process.stdin.resume();

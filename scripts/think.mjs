// 思考层命令行入口：npm run think -- "<需求>" --task <编号> --export-dir <目录>
// 详见 `npm run think -- --help`。需要先构建（npm run think 会自动 build:core）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { mainFromProcess } = await import(path.join(root, 'dist-electron', 'core', 'thinking', 'cli', 'main.js'));
process.exitCode = await mainFromProcess(process.argv.slice(2));

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, initRepo } from '../src/core/git/git.js';

export async function tmpDir(prefix = 'studio-'): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function makeRepo(files: Record<string, string> = { 'index.html': '<h1>hello</h1>\n' }) {
  const dir = await tmpDir();
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fs.writeFile(path.join(dir, p), c);
  }
  await initRepo(dir);
  return dir;
}

export { git };

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 任务副本（worktree）代码文件写入原语（ADR 0006）：
 * 由 Builtin API Agent Executor 调用（调用前必须已完成 realpath + worktree 边界 + .git 校验）。
 */
export async function writeWorktreeTextFile(targetAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(targetAbs), { recursive: true });
  await fs.writeFile(targetAbs, content, 'utf8');
}

import type { DeniedOperation, ExitOutcome } from '../executor/types.js';

/**
 * 给界面看的固定文案生成器（B4-2 第 1 节）：只按“状态 / 类别”选文案，
 * 不拼接命令、错误输出、绝对路径或执行体的原话。
 */

/** 只保留项目内的相对路径；绝对路径、含 .. 的路径一律不显示（返回 null） */
export function safeRelPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.includes('\0')) return null;
  if (p.startsWith('/') || p.startsWith('~') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)) return null;
  if (p.split(/[\\/]/).includes('..')) return null;
  return p;
}

export function exitFailureText(exit: ExitOutcome | undefined): string {
  switch (exit?.kind) {
    case 'stopped':
      return '你停止了本次执行';
    case 'timed_out':
      return '执行超时，已被终止';
    case 'exited':
      return exit.code === 0 ? '正常结束' : 'AI 没有顺利结束';
    case 'signaled':
    case 'spawn_error':
      return 'AI 没能正常运行';
    default:
      return 'AI 没有报告结束状态';
  }
}

const CHECK_NAME = { build: '构建', test: '测试' } as const;

/** “未检查”的原因：按类别选固定文案（不使用检查层拼接的原文） */
export function notCheckedText(key: string, evidence: string): string {
  const name = CHECK_NAME[key as 'build' | 'test'] ?? '检查';
  if (evidence.startsWith('项目没有')) return `项目没有${name}脚本，因此未检查。`;
  if (evidence.startsWith('这些脚本没有经过你的批准')) return '这些脚本没有经过你的批准，因此未检查。';
  if (evidence.startsWith('脚本内容与你批准时不同')) return '脚本内容与你批准时不同（授权已失效），因此未检查。';
  if (evidence.startsWith('检查改动了文件')) return '检查改动了文件，检查结果已作废，因此未检查。';
  return '没有可用的受限运行环境，脚本不会在你的电脑上直接运行，因此未检查。';
}

/** 被拒绝的操作：只给类别和相对位置，不给命令 */
export function deniedText(d: DeniedOperation): string {
  const rel = safeRelPath(d.paths?.[0]);
  const where = rel ? `「${rel}」` : '任务副本以外的位置';
  switch (d.kind) {
    case 'read_file':
      return `想读取${where}，已拦下`;
    case 'write_file':
      return `想修改${where}，已拦下`;
    case 'delete_file':
      return `想删除${where}，已拦下`;
    case 'run_command':
      return '想运行一条命令，已拦下';
    case 'network':
      return '想联网，已拦下';
    default:
      return '想执行一项其他操作，已拦下';
  }
}

/** 被拒绝操作对本次任务的影响（纯大白话，无内部名词或命令原文） */
export function deniedImpactText(d: DeniedOperation): string {
  switch (d.kind) {
    case 'network':
      return '这个任务没有开启联网权限。AI 会在不联网的情况下继续尝试，不需要你处理。';
    case 'write_file':
    case 'delete_file':
      return '超出允许修改范围的写操作已拦下，你的其他文件保持原样，不需要你处理。';
    case 'run_command':
      return '超出本次授权范围的命令已自动拦下，不会影响你的项目，不需要你处理。';
    default:
      return '该操作超出本次授权范围，已自动拦下，不需要你处理。';
  }
}

/**
 * 清理 AI 自述文字：隐去绝对路径与形如“npm run …”“rm -rf …”的命令片段（启发式，宁可多隐去）。
 * 这是展示前的最后一道，避免 AI 的话把命令或本机路径带进界面。
 */
export function scrubAiText(s: string): string {
  return s
    .replace(/(?:~|[A-Za-z]:\\|\/)[\w.@+~-]*(?:[\\/][\w.@+~ -]+)+/g, '（位置已隐去）')
    .replace(/\b(?:npm|npx|yarn|pnpm|git|rm|sudo|curl|wget|chmod|chown|node|bash|sh|zsh|python3?)\s+(?:-{1,2}[\w=-]+\s+)*[\w./:@=-]+/gi, '（命令已隐去）');
}

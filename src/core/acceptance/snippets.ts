import * as G from '../git/git.js';
import type { Task } from '../task/model.js';

/**
 * 轻量成果展示（B4-2 第 2 节）：对每个改动的文本文件，给出“原来 / 现在”的片段。
 * - 只取改动处上下各 2 行；每个文件最多 5 处；每处每一侧最多 12 行；
 * - 新文件显示“新文件”与开头最多 20 行；删除文件显示“已删除”；
 * - 二进制、不是 UTF-8、或超过 200 KB 的文件不展示内容；
 * - 内容来自冻结的验收内容（acceptedTree）与基线提交，保证展示的就是将要保存的那一份。
 */
export const PREVIEW_LIMITS = { maxBytes: 200 * 1024, context: 2, maxHunks: 5, maxHunkLines: 12, maxNewFileLines: 20, maxFiles: 40 } as const;

export const PREVIEW_TEXT = {
  newFile: '新文件',
  deleted: '已删除',
  unavailable: '这类文件无法直接显示，保存后可以自己打开查看',
  omitted: (n: number) => `还有 ${n} 处改动没有显示`,
  truncated: '（这一处太长，只显示了前面一部分）',
} as const;

export interface Hunk {
  /** 现在的文件里这一处开始的行号（从 1 算起） */
  line: number;
  before: string[];
  after: string[];
  truncated: boolean;
}

export type ChangePreview =
  | { kind: 'text'; hunks: Hunk[]; omitted: number; note?: string }
  | { kind: 'new'; note: string; lines: string[]; truncated: boolean }
  | { kind: 'deleted'; note: string }
  | { kind: 'unavailable'; note: string };

const toLines = (s: string): string[] => {
  const lines = s.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** 不是可显示的文本：含空字节（二进制）或不是合法的 UTF-8（解码后出现替换字符） */
const notDisplayable = (s: string): boolean => s.includes('\0') || s.includes('�');

interface Block {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/** 逐行比较，返回连续的改动块（半开区间）。先去掉相同的开头与结尾，中间部分用最长公共子序列；太大时当作整块替换。 */
function changeBlocks(a: string[], b: string[]): Block[] {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const n = ea - s;
  const m = eb - s;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > 2_000_000) return [{ aStart: s, aEnd: ea, bStart: s, bEnd: eb }];
  // dp[i][j] = a[s+i..] 与 b[s+j..] 的最长公共子序列长度
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[s + i] === b[s + j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const blocks: Block[] = [];
  let i = 0;
  let j = 0;
  let cur: Block | null = null;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[s + i] === b[s + j]) {
      flush();
      i++;
      j++;
    } else {
      cur ??= { aStart: s + i, aEnd: s + i, bStart: s + j, bEnd: s + j };
      if (j < m && (i === n || dp[i * w + j + 1]! >= dp[(i + 1) * w + j]!)) {
        j++;
        cur.bEnd = s + j;
      } else {
        i++;
        cur.aEnd = s + i;
      }
    }
  }
  flush();
  return blocks;
}

/** 纯函数：把“原来”和“现在”的全文变成最多 5 处“原来 / 现在”片段。 */
export function makeHunks(before: string, after: string): { hunks: Hunk[]; omitted: number } {
  const a = toLines(before);
  const b = toLines(after);
  const ctx = PREVIEW_LIMITS.context;
  // 上下文相连（间隔不超过 2×上下文行数）的改动块合并成一处
  const merged: Block[] = [];
  for (const blk of changeBlocks(a, b)) {
    const last = merged[merged.length - 1];
    if (last && blk.aStart - last.aEnd <= ctx * 2) {
      last.aEnd = blk.aEnd;
      last.bEnd = blk.bEnd;
    } else merged.push({ ...blk });
  }
  const all = merged.map((blk): Hunk => {
    const aFrom = Math.max(0, blk.aStart - ctx);
    const bFrom = Math.max(0, blk.bStart - ctx);
    const bef = a.slice(aFrom, Math.min(a.length, blk.aEnd + ctx));
    const aft = b.slice(bFrom, Math.min(b.length, blk.bEnd + ctx));
    const max = PREVIEW_LIMITS.maxHunkLines;
    return { line: bFrom + 1, before: bef.slice(0, max), after: aft.slice(0, max), truncated: bef.length > max || aft.length > max };
  });
  const hunks = all.slice(0, PREVIEW_LIMITS.maxHunks);
  return { hunks, omitted: all.length - hunks.length };
}

const unavailable = (): ChangePreview => ({ kind: 'unavailable', note: PREVIEW_TEXT.unavailable });

/** 为一个任务的改动清单生成片段（只读 Git；任何一步读不到都退回“无法直接显示”）。 */
export async function buildPreviews(repo: string, task: Task): Promise<Map<string, ChangePreview>> {
  const out = new Map<string, ChangePreview>();
  const tree = task.acceptedTree;
  const base = task.worktree?.baseSha;
  const changes = task.card?.changes;
  if (!tree || !base || !changes) return out;
  const max = PREVIEW_LIMITS.maxBytes;
  for (const c of changes.slice(0, PREVIEW_LIMITS.maxFiles)) {
    try {
      if (c.status === 'deleted') {
        out.set(c.path, { kind: 'deleted', note: PREVIEW_TEXT.deleted });
        continue;
      }
      if (c.status !== 'added' && c.status !== 'modified' && c.status !== 'renamed') {
        out.set(c.path, unavailable());
        continue;
      }
      // Git 认为是二进制（改名的文件在统计里没有对应的行数，靠下面读到的内容判断）
      if (c.status !== 'renamed' && (c.additions === null || c.deletions === null)) {
        out.set(c.path, unavailable());
        continue;
      }
      const now = await G.readBlob(repo, tree, c.path, max);
      if (now.kind !== 'ok' || notDisplayable(now.text)) {
        out.set(c.path, unavailable());
        continue;
      }
      if (c.status === 'added') {
        const lines = toLines(now.text);
        const n = PREVIEW_LIMITS.maxNewFileLines;
        out.set(c.path, { kind: 'new', note: PREVIEW_TEXT.newFile, lines: lines.slice(0, n), truncated: lines.length > n });
        continue;
      }
      const old = await G.readBlob(repo, base, c.oldPath ?? c.path, max);
      if (old.kind !== 'ok' || notDisplayable(old.text)) {
        out.set(c.path, unavailable());
        continue;
      }
      const { hunks, omitted } = makeHunks(old.text, now.text);
      out.set(c.path, { kind: 'text', hunks, omitted, ...(omitted > 0 ? { note: PREVIEW_TEXT.omitted(omitted) } : {}) });
    } catch {
      out.set(c.path, unavailable());
    }
  }
  return out;
}

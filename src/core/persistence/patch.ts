/**
 * 事件日志里记录的“变更”：相对上一版的顶层差异。数组只在“上一版是新版的前缀”时记为追加（时间线这类只增不减的字段），
 * 否则整体替换。日志的第一条是完整快照，之后按补丁依次重放即可重建汇总。
 */
export interface RecordPatch {
  set?: Record<string, unknown>;
  del?: string[];
  append?: Record<string, unknown[]>;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

type Obj = Record<string, unknown>;

export function diffRecord(prev: Obj, next: Obj): RecordPatch {
  const patch: RecordPatch = {};
  for (const k of Object.keys(next)) {
    const a = prev[k];
    const b = next[k];
    if (b === undefined) continue;
    if (k in prev && same(a, b)) continue;
    if (Array.isArray(a) && Array.isArray(b) && b.length > a.length && same(a, b.slice(0, a.length))) {
      (patch.append ??= {})[k] = b.slice(a.length);
    } else (patch.set ??= {})[k] = b;
  }
  const del = Object.keys(prev).filter((k) => !(k in next) || next[k] === undefined);
  if (del.length) patch.del = del;
  return patch;
}

export function applyPatch(base: Obj, patch: RecordPatch): Obj {
  const out: Obj = { ...base };
  for (const k of patch.del ?? []) delete out[k];
  for (const [k, v] of Object.entries(patch.set ?? {})) out[k] = v;
  for (const [k, v] of Object.entries(patch.append ?? {})) {
    const cur = out[k];
    out[k] = [...(Array.isArray(cur) ? cur : []), ...v];
  }
  return out;
}

export const isEmptyPatch = (p: RecordPatch): boolean => !p.set && !p.del && !p.append;

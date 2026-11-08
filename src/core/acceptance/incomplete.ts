/**
 * “AI 报告以下操作未能完成”：从 AI 最终说明里提取它自己承认没做成的事。
 * 这只是 AI 的自述，不是证据；调用方必须明确标注，并与宿主可验证的事实并列显示。
 * 施工模式下失败的操作不一定产生任何事件（B3-0/B3-1 实测 4/4），所以不能用命令事件当完整记录。
 */
const FAILURE =
  /not permitted|permission denied|denied|blocked|couldn['’]?t|could not|cannot|can['’]?t|unable|failed|failure|did not work|not created|was not|were not|无法|不能|没能|没有成功|未能|失败|被拒|拒绝|不允许|没有权限|没做|未完成|没有完成/i;

export type IncompleteReport =
  | { kind: 'items'; items: string[] }
  /** 提取不到具体条目：给出 AI 原话（失败相关的段落，或最后一段） */
  | { kind: 'raw'; text: string }
  | { kind: 'none' };

/** 把一段话拆成句子级的片段（中英文标点与换行） */
function pieces(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?。！？；;])\s+/)
    .map((s) => s.replace(/^[\s\-*•\d.)、]+/, '').trim())
    .filter(Boolean);
}

/**
 * @param aiMessages AI 自己说的话（按时间顺序；不含应用自己加的说明）
 * @param context 宿主已知的“任务不完整”迹象（退出码非 0、有被拒绝/异常的操作）
 */
export function extractIncomplete(aiMessages: string[], context: { incompleteSignals: boolean }): IncompleteReport {
  const last = [...aiMessages].reverse().find((m) => m.trim());
  if (!last) return { kind: 'none' };
  const hits = pieces(last).filter((p) => FAILURE.test(p));
  if (hits.length) return { kind: 'items', items: [...new Set(hits)].slice(0, 8) };
  // 提取不到：只有在宿主已经看到不完整迹象时，才把 AI 原话摆出来请用户自己判断；否则不把一段普通汇报硬说成“未完成”
  if (context.incompleteSignals) return { kind: 'raw', text: last.trim().slice(0, 1200) };
  return { kind: 'none' };
}

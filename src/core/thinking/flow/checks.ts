import fs from 'node:fs/promises';
import path from 'node:path';
import type { AttemptRecord, BasisStatus, ChecksResult, Finding, FindingCheck, ItemMark, RequirementItem, ScopeDiff } from './types.js';

/** 宿主的机械检查：不依赖模型自报，也不做任何语义判断（不判断“实质变化”）。 */

export interface ReviseBody {
  plan: string;
  resolutions: { index: number; result: '已解决' | '未解决' | '交用户裁决'; reason: string }[];
  item_marks: { id: string; mark: ItemMark; note?: string }[];
  additions: string[];
}

/** 范围比对：遗漏任一条目、标注“删除”、出现新增内容 → 差异；“修改”只列出，不要求裁决。 */
export function scopeCompare(frozen: RequirementItem[], marks: ReviseBody['item_marks'], additions: string[]): { diffs: ScopeDiff[]; modifiedIds: string[] } {
  const diffs: ScopeDiff[] = [];
  const byId = new Map(marks.map((m) => [m.id, m] as const));
  const modifiedIds: string[] = [];
  for (const it of frozen) {
    const m = byId.get(it.id);
    if (!m) diffs.push({ key: `omitted:${it.id}`, kind: 'omitted', description: `修订稿没有对条目 ${it.id} 作任何标注（遗漏）：${it.text}` });
    else if (m.mark === '删除') diffs.push({ key: `deleted:${it.id}`, kind: 'deleted', description: `修订稿标注删除条目 ${it.id}：${it.text}${m.note ? `（理由：${m.note}）` : ''}` });
    else if (m.mark === '修改') modifiedIds.push(it.id);
  }
  additions.forEach((a, i) => diffs.push({ key: `added:${i + 1}`, kind: 'added', description: `新增内容 #${i + 1}：${a}` }));
  return { diffs, modifiedIds };
}

const EMPTY_BASIS = /^\s*(?:无|没有|暂无|none|n\/a|na|null|-|—|（空）)?\s*[。.]?\s*$/i;
const FILE_REF = /(?:^|[\s`'"“‘(（\[])((?:\.{0,2}\/)?[\w.\-/]+\.(?:md|ts|tsx|js|mjs|cjs|json|html|css|txt|ya?ml|toml))(?:#([^\s`'"”’)）\]]+))?/g;

/** 依据核验：区分“提供了依据”与“依据已核验”。无法核验的一律维持未经证实。 */
export async function verifyBasis(projectRoot: string, findings: Finding[]): Promise<FindingCheck[]> {
  const root = await fs.realpath(projectRoot);
  const out: FindingCheck[] = [];
  for (const [i, f] of findings.entries()) {
    const index = i + 1;
    const basis = f.basis ?? '';
    if (EMPTY_BASIS.test(basis)) {
      out.push({ index, basisStatus: '未经证实', detail: '依据为空或“无”' });
      continue;
    }
    const refs = [...basis.matchAll(FILE_REF)].map((m) => ({ file: m[1]!, section: m[2] }));
    if (!refs.length) {
      out.push({ index, basisStatus: '未经证实', detail: '给出了文字依据，但没有可核验的本地文件引用，宿主无法核验' });
      continue;
    }
    const bad: string[] = [];
    for (const r of refs) {
      const abs = path.resolve(root, r.file);
      const real = await fs.realpath(abs).catch(() => undefined);
      if (!real || !(real === root || real.startsWith(root + path.sep))) {
        bad.push(`${r.file}（文件不存在或不在项目目录内）`);
        continue;
      }
      if (r.section) {
        const text = await fs.readFile(real, 'utf8').catch(() => '');
        const sec = decodeURIComponent(r.section).toLowerCase();
        const headings = text.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.replace(/^#{1,6}\s+/, '').toLowerCase());
        if (!headings.some((h) => h.includes(sec))) bad.push(`${r.file}#${r.section}（文件存在但找不到该章节标题）`);
      }
    }
    if (bad.length) out.push({ index, basisStatus: '依据无法核实', detail: bad.join('；') });
    else out.push({ index, basisStatus: '提供了依据（文件存在）', detail: '宿主核实了所引用的文件（及章节标题）存在；不代表文件内容支持该意见，仍需人工判断' });
  }
  return out;
}

/** 从产生正式产物的尝试里找安全问题。有任一条 → 不提供“批准”选项。 */
export function safetyIssuesOf(attempts: AttemptRecord[], formalSteps: { step: AttemptRecord['step']; n: number }[]): string[] {
  const issues: string[] = [];
  for (const f of formalSteps) {
    const a = attempts.find((x) => x.step === f.step && x.n === f.n);
    if (!a) {
      issues.push(`步骤 ${f.step} 的正式产物找不到对应的调用尝试记录`);
      continue;
    }
    if (!a.sent.length) issues.push(`步骤 ${f.step}（第 ${a.n} 次尝试）发送清单缺失`);
    if (a.refusedToolRequests?.length) issues.push(`步骤 ${f.step}（第 ${a.n} 次尝试）思考者请求了工具（${a.refusedToolRequests.length} 次，已被拒绝）：隔离预期被打破`);
    if (a.isolationEvidence && /=[1-9]\d*/.test(a.isolationEvidence)) issues.push(`步骤 ${f.step}（第 ${a.n} 次尝试）隔离核验证据异常：${a.isolationEvidence}`);
  }
  return issues;
}

export interface ComputeChecksInput {
  projectRoot: string;
  frozen: RequirementItem[];
  independentReview: boolean;
  findings: Finding[];
  revise?: ReviseBody;
  attempts: AttemptRecord[];
  formalSteps: { step: AttemptRecord['step']; n: number }[];
}

export async function computeChecks(i: ComputeChecksInput): Promise<ChecksResult> {
  const findingChecks = await verifyBasis(i.projectRoot, i.findings);
  let scopeDiffs: ScopeDiff[] = [];
  let modifiedIds: string[] = [];
  const blocking: number[] = [];
  if (i.revise) {
    const r = scopeCompare(i.frozen, i.revise.item_marks, i.revise.additions);
    scopeDiffs = r.diffs;
    modifiedIds = r.modifiedIds;
    for (const [idx, f] of i.findings.entries()) {
      if (f.severity !== '阻断') continue;
      const res = i.revise.resolutions.find((x) => x.index === idx + 1)?.result ?? '未解决';
      if (res === '未解决' || res === '交用户裁决') blocking.push(idx + 1);
    }
  }
  return { scopeDiffs, modifiedIds, findingChecks, blockingFindings: blocking, safetyIssues: safetyIssuesOf(i.attempts, i.formalSteps), independentReview: i.independentReview };
}

export const basisLabel = (s: BasisStatus) => s;

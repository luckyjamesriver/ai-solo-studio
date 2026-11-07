import type { OutputSchema, SchemaNode } from '../types.js';
import type { Finding, RequirementItem, StepName } from './types.js';

const str: SchemaNode = { type: 'string' };
const REQ_CHANGES: SchemaNode = { type: 'array', items: { type: 'object', properties: { id: str, text: str }, required: ['id', 'text'] }, description: '（不允许使用）冻结后不得修改条目；如果你输出此字段，它会被忽略并记录' };

export const SCHEMAS: Record<StepName, OutputSchema> = {
  requirements: {
    type: 'object',
    required: ['items'],
    properties: { items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string', description: '一句话描述一个需求条目' } }, required: ['text'] } } },
  },
  draft: {
    type: 'object',
    required: ['plan', 'coverage'],
    properties: {
      plan: { type: 'string', description: '方案正文（Markdown）' },
      coverage: { type: 'array', items: { type: 'object', properties: { id: str, how: { type: 'string', description: '方案如何覆盖该条目' } }, required: ['id', 'how'] }, description: '对每个冻结条目（按 ID）给出覆盖说明，一个都不能少' },
      requirement_changes: REQ_CHANGES,
    },
  },
  review: {
    type: 'object',
    required: ['requirement_checks', 'findings', 'missing_evidence'],
    properties: {
      requirement_checks: {
        type: 'array',
        description: '逐条检查：每个冻结条目一项',
        items: { type: 'object', properties: { id: str, covered: { type: 'boolean' }, note: str }, required: ['id', 'covered', 'note'] },
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['problem', 'severity', 'basis', 'impact', 'suggestion', 'resolution'],
          properties: {
            problem: str,
            severity: { type: 'string', enum: ['阻断', '建议', '信息补充'] },
            basis: { type: 'string', description: '依据：资料中的具体位置（文件名/章节）；没有依据就写空字符串，不要编造' },
            impact: str,
            suggestion: str,
            resolution: { type: 'string', description: '处理结果：必须留空字符串，由规划者在修订时填写' },
          },
        },
      },
      missing_evidence: { type: 'array', items: str, description: '需要但没有收到的证据；宿主不会替你补全' },
    },
  },
  revise: {
    type: 'object',
    required: ['plan', 'resolutions', 'item_marks', 'additions'],
    properties: {
      plan: { type: 'string', description: '修订后的方案正文（Markdown）' },
      resolutions: {
        type: 'array',
        description: '对每条评审意见（按序号）填写处理结果与理由',
        items: { type: 'object', properties: { index: { type: 'number' }, result: { type: 'string', enum: ['已解决', '未解决', '交用户裁决'] }, reason: str }, required: ['index', 'result', 'reason'] },
      },
      item_marks: {
        type: 'array',
        description: '对每个冻结条目标注：保留 / 修改 / 删除',
        items: { type: 'object', properties: { id: str, mark: { type: 'string', enum: ['保留', '修改', '删除'] }, note: str }, required: ['id', 'mark'] },
      },
      additions: { type: 'array', items: str, description: '相对冻结条目新增的内容，逐项单独列出；没有则为空数组' },
      requirement_changes: REQ_CHANGES,
    },
  },
};

const FROZEN_RULE = '需求条目已由用户确认并冻结，是唯一基准。你不得增、删、改条目；任何改动条目的输出都会被宿主忽略并记录。';

export const SYSTEMS: Record<StepName, string> = {
  requirements: [
    '你是规划者。这一步只做一件事：把用户的原始需求拆成需求条目。',
    '每条是一句话，只描述“要什么”，不写方案、不写实现方式、不增加用户没说的内容。',
    '不要给条目编号（宿主负责编号）。输出不符合结构将被判为不完整。',
  ].join('\n'),
  draft: ['你是规划者。根据已冻结的需求条目起草开发方案。', FROZEN_RULE, '方案必须对每个冻结条目（按 ID）给出覆盖说明；缺任何一个条目，本次输出将被判为不完整。'].join('\n'),
  review: [
    '你是评审者。你的职责是找出这份方案的错误、需求遗漏、风险和证据缺口，不是求共识，也不是夸奖。',
    FROZEN_RULE,
    '规划者的结论不是事实：每个判断都要在你收到的资料里找依据，找不到依据就写空字符串，不要编造出处。',
    '你必须严格按给定的 JSON 结构输出，包含：逐条冻结条目的检查（requirement_checks，一个条目一项）、评审意见（findings，每条六个字段：problem / severity / basis / impact / suggestion / resolution，resolution 必须留空）、需要的证据（missing_evidence）。',
    '未按这个结构输出（缺字段、多余的说明文字、严重程度取值不在 阻断/建议/信息补充 之内）将被判为不完整，你的评审将被作废。不要输出 JSON 之外的任何文字。',
    '如果资料不足以评审，把你需要的资料列在 missing_evidence 里；宿主不会替你补全。',
  ].join('\n'),
  revise: [
    '你是规划者。根据评审意见修订方案。',
    FROZEN_RULE,
    '必须：对每条评审意见（按序号）填写处理结果（已解决/未解决/交用户裁决）及理由；对每个冻结条目标注 保留/修改/删除；相对冻结条目新增的内容必须在 additions 中逐项单独列出。',
    '不要为了“已解决”而粉饰：不同意或无法解决的意见，如实写 未解决 或 交用户裁决。缺少上述任何一项，本次输出将被判为不完整。',
  ].join('\n'),
};

export function formatItems(items: RequirementItem[]): string {
  return items.map((i) => `${i.id}：${i.text}`).join('\n');
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((f, i) => `#${i + 1}【${f.severity}】${f.problem}\n  依据：${f.basis || '（空）'}\n  影响：${f.impact}\n  建议：${f.suggestion}`).join('\n\n') || '（评审者没有提出意见）';
}

/** 评审者看到的“方案正文”：只含方案和覆盖说明，不含规划者的原始输出全文或任何推理。 */
export function planBody(draft: { plan: string; coverage: { id: string; how: string }[] }): string {
  return `${draft.plan}\n\n## 条目覆盖说明\n${draft.coverage.map((c) => `- ${c.id}：${c.how}`).join('\n')}`;
}

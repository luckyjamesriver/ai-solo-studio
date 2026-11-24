/**
 * 验收视图使用的统一裁决入口（薄封装）。
 *
 * 存在的目的：`src/core/acceptance/view.ts` 不允许直接引用 evidence 模块（安全基线：
 * 视图不得读取原始证据字段）。视图只从这里拿到「已裁决好的状态 + 固定文案」。
 */
export {
  adjudicateRoundChecks,
  adjudicateSaveRecord,
  adjudicateTaskEvidence,
  saveChecksTextFor,
  type CheckAdjudication,
  type SavedChecksStatus,
} from '../evidence/adjudicate.js';

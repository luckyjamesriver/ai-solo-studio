import { createHash } from 'node:crypto';
import fs from 'node:fs';
/**
 * 统一宿主证据模型（AISS-A1-TRUSTED-EVIDENCE-001）。
 *
 * 设计原则：
 * 1. 证据只描述「宿主实际观察到的物理事实」：真实进程退出、真实结构化测试报告、被测内容指纹、
 *    检查脚本与运行器/报告器的完整性指纹。AI 的自述永远不进入这里。
 * 2. 「命令成功结束」与「自动测试真实通过」是两件不同的事：只有结构化报告证明有测试真实执行且全部通过，
 *    才允许出现 `passed`。其余一律 `unverified`（缺乏有效证据）或 `failed`（真实失败）/ `not_available`（未执行）。
 * 3. 证据与身份绑定：项目、任务、轮次、验收版本、被测内容 tree、检查配置指纹。任一不一致即失效。
 * 4. 宿主采集退出码与结构化报告不等于绝对不可伪造。信任边界与完整性检查（见 docs/plans 与 review 报告）：
 *    - 报告由宿主注入的 CLI 报告器写入宿主生成的随机路径，运行前清空、运行后校验「运行期间新产生」；
 *    - 报告与进程 stdout 摘要、内部计数交叉核对；
 *    - 检查脚本、锁文件、测试配置文件、测试运行器包、测试文件清单全部纳入指纹；
 *    - 运行前后各算一次被测内容 tree，运行期间内容变化即作废；
 *    - 执行体可修改的运行器/配置/测试若发生削弱，进入明确的失效或重新确认流程。
 */

export const EVIDENCE_SCHEMA = 1;
export const COLLECTOR_VERSION = 'a1-evidence-1';

/** 检查结论。`passed` 只能来自可信证据；`unverified` 表示「执行了但拿不到可信证据」，绝不等于通过。 */
export type CheckVerdict = 'passed' | 'failed' | 'not_available' | 'unverified';

/** 非通过结论的结构化原因（界面据此生成固定文案，不透传原始输出）。 */
export type CheckUnknownReason =
  | 'no_structured_evidence'
  | 'unsupported_test_runner'
  | 'report_missing'
  | 'report_invalid'
  | 'report_inconsistent'
  | 'report_reused'
  | 'tests_not_executed'
  | 'all_tests_skipped'
  | 'test_scope_weakened'
  | 'test_scope_changed'
  | 'check_config_changed'
  | 'source_changed_during_check'
  | 'sandbox_unavailable'
  | 'scripts_not_approved'
  | 'scripts_changed_reauth'
  | 'no_script'
  | 'evidence_invalidated'
  | 'acceptance_inconsistent'
  | 'legacy_unverified';

/** 证据可信度：trusted = 有结构化证据且完整性检查通过；weak = 只有命令级观察；none = 无。 */
export type EvidenceTrust = 'trusted' | 'weak' | 'none';

export interface EvidenceIdentity {
  schemaVersion: typeof EVIDENCE_SCHEMA;
  /** 每次真实运行唯一（随机），用于拒绝复用旧证据 */
  evidenceId: string;
  /** 项目根真实路径的哈希（不保存绝对路径） */
  projectRootHash: string;
  taskId: string;
  round: number;
  /** 生成证据时的验收版本序号 */
  acceptanceRev: number;
  /** 被测内容的 tree（运行开始时计算） */
  testedTree: string;
  /** 任务副本路径哈希 */
  worktreePathHash: string;
  /** R4-04：试检查对应的试合并提交（普通验收检查没有此字段） */
  trialCommit?: string;
}

export interface CheckRunRecord {
  runId: string;
  startedAt: string;
  finishedAt: string;
  env: 'sandbox' | 'local';
  /** 受限运行环境的种类（seatbelt / codex-app-server / test-runner），由运行器注入 */
  sandboxKind: string;
  /** 实际执行的 argv（仅本机受保护记录；界面显示前过滤） */
  argv: string[];
  timedOut: boolean;
  /** R4-04：是否真的尝试启动过进程。false 表示“未执行检查”（not_available 的占位记录），不是启动失败。 */
  attempted?: boolean;
  exitKind: 'exited' | 'signaled' | 'stopped' | 'timed_out' | 'spawn_error';
  exitCode: number | null;
  durationMs: number;
  stdoutSha256: string;
  stdoutBytes: number;
  stderrSha256: string;
}

export interface ConfigFileFingerprint {
  path: string;
  sha256: string;
}

/** 检查配置 / 运行器 / 报告器 / 测试清单的完整性指纹。 */
export interface ConfigFingerprint {
  /** package.json 中 build/test（含 pre/post）脚本摘要（与批准时授权摘要同一算法） */
  scriptsDigest?: string;
  /** package-lock.json 摘要（依赖树变化意味着运行器可能被替换） */
  packageLockDigest?: string;
  /** 解析到的测试运行器包身份（例如 vitest 的版本与 package.json 摘要） */
  runnerPackage?: { name: string; version: string; packageJsonSha256: string };
  /** 实际运行器入口文件（bin）的路径哈希与内容 sha256 */
  runnerEntry?: { pathHash: string; sha256: string };
  /** 运行器直接依赖（vite / @vitest/runner 等）的身份与内容摘要 */
  deps?: { name: string; version: string; packageJsonSha256: string }[];
  /** 测试配置文件（vitest.config.* / vite.config.* / jest.config.* 等） */
  testConfigFiles: ConfigFileFingerprint[];
  /** 测试文件清单摘要（路径 + 内容） */
  testInventoryDigest?: string;
  testFileCount?: number;
  testBlockCount?: number;
  assertionCount?: number;
  skipMarkerCount?: number;
  onlyMarkerCount?: number;
  /** 结构化报告采集方式；none 表示没有可信报告通道 */
  reporterMode: 'vitest-json-cli' | 'none';
  collectorVersion: string;
}

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
}

/** 单条测试用例的真实执行结果（身份 + 状态）。 */
export interface ExecutionCaseResult {
  file: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'todo' | 'other';
}

/** 每个测试文件的用例执行统计（与静态测试块数对账用）。 */
export interface ExecutionFileCounts {
  file: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
}

/**
 * 实际执行清单（R3-03）：文件、用例身份、执行状态与计数。
 * 静态范围指纹看不见「同一文件内用例减少/动态跳过/过滤变化」，必须由这份清单补足。
 */
export interface ExecutionManifest {
  schemaVersion: 1;
  files: string[];
  perFile: ExecutionFileCounts[];
  /** 对**全部**用例（文件 + 名称 + 状态）计算的摘要；cases 可能只是截断后的样本 */
  casesDigest: string;
  cases: ExecutionCaseResult[];
  casesTruncated: boolean;
  counts: TestCounts;
  /** 实际执行清单指纹（文件 + 每文件统计 + 用例身份与状态摘要 + 计数） */
  fingerprint: string;
}

export interface TestReportEvidence {
  format: 'vitest-json';
  /** 报告里实际执行到的测试文件（相对被测工作树根） */
  executedFiles: string[];
  /** R3-03：实际执行到的用例身份与执行状态清单（可选，只为旧记录兼容） */
  execution?: ExecutionManifest;
  /** 报告路径哈希（不保存绝对路径） */
  pathHash: string;
  sha256: string;
  bytes: number;
  /** 报告确实产生于本次运行窗口内（运行前已清空 + mtime/startTime 校验） */
  producedDuringRun: boolean;
  /** 报告中的运行开始时间落在本次运行窗口内 */
  startTimeWithinRun: boolean;
  counts: TestCounts;
  failedNames: string[];
  /** 完整性：ok 仅当所有必需校验**实际执行且通过**；checks 逐项记录是否真的发生 */
  integrity: { ok: boolean; problems: string[]; checks: Record<string, boolean> };
  /** 与进程 stdout 摘要的交叉核对（performed=false 表示无法核对，不得当作成功） */
  crossCheck: { performed: boolean; stdoutSummary?: { passed: number; failed: number }; agrees: boolean; detail?: string };
}

export interface ScopeDelta {
  filesRemoved: string[];
  filesAdded: string[];
  testsRemoved: string[];
  /** 逐文件断言减少的明细（防止被其它文件的新增断言抵消） */
  perFileAssertionDrops: { path: string; from: number; to: number }[];
  assertionsDelta: number;
  testBlocksDelta: number;
  skipMarkerDelta: number;
  onlyMarkerDelta: number;
  configChanged: string[];
  /** 已存在的测试/辅助文件内容发生变化（静态分析无法证明语义未削弱 → 保守进入待确认） */
  testFilesModified: string[];
  supportFilesChanged: string[];
  runnerChanged: boolean;
  lockfileChanged: boolean;
  scriptsChanged: boolean;
  /** 实际执行的文件/用例范围 vs 静态预期范围（防止只跑部分测试或动态跳过仍取得可信 PASS） */
  executedScope?: {
    expectedFiles: number;
    executedFiles: number;
    missing: string[];
    /** 静态可执行用例数 vs 本次真实执行用例数 */
    expectedCases?: number;
    executedCases?: number;
    skippedCases?: number;
    /** 运行期被动态跳过（静态没有 skip 标记）的用例，按文件聚合 */
    dynamicallySkipped?: { file: string; skipped: number; staticSkipMarkers: number }[];
  };
}

/** 相对「任务基线的测试范围」的评估。 */
export interface ScopeAssessment {
  kind: 'assessed_unchanged' | 'assessed_stronger' | 'assessed_weakened' | 'assessed_needs_review' | 'not_assessed';
  /** 基线来源（任务副本基线提交）是否可用 */
  baselineAvailable: boolean;
  baselineSource?: string;
  reasons: string[];
  delta?: ScopeDelta;
  /** 评估方法说明：保守静态核对 + 显式人工复核；不声称能证明测试语义绝对未被削弱。 */
  method?: 'conservative-static' | 'none';
  /** 本次评估时的**静态**范围指纹（测试清单 + 配置 + 运行器入口/依赖），用于绑定用户确认 */
  fingerprint?: string;
  /** 本次评估时的**实际执行清单**指纹（文件 + 用例身份 + 执行状态）；静态范围相同也可能不同 */
  executionFingerprint?: string;
}

export interface HostCheckEvidence {
  schemaVersion: typeof EVIDENCE_SCHEMA;
  kind: 'build' | 'test';
  verdict: CheckVerdict;
  trust: EvidenceTrust;
  /** 非通过 / 证据异常的结构化原因 */
  reason?: CheckUnknownReason;
  identity: EvidenceIdentity;
  run: CheckRunRecord;
  config: ConfigFingerprint;
  report?: TestReportEvidence;
  scope: ScopeAssessment;
  /** 证据在当前记录状态下是否仍然有效（身份 / 版本 / 配置 / 范围核对通过） */
  valid: boolean;
  invalidReason?: CheckUnknownReason;
  /** 旧任务记录升级后生成的历史未核实标记（不补造证据） */
  legacy?: boolean;
}

/** 任务基线（开工基线提交）上测试范围的清单，用于判断测试覆盖是否被削弱。 */
export interface TestInventoryFile {
  path: string;
  sha256: string;
  testBlocks: number;
  assertions: number;
  skipMarkers: number;
  onlyMarkers: number;
  todoMarkers: number;
  testNames: string[];
}

export interface TestInventory {
  files: TestInventoryFile[];
  /** 测试辅助文件（helpers/fixtures/setup 等，非测试用例文件）的指纹；其变化同样需要保守复核 */
  supportFiles: { path: string; sha256: string }[];
  testFileCount: number;
  testBlockCount: number;
  assertionCount: number;
  skipMarkerCount: number;
  onlyMarkerCount: number;
  todoMarkerCount: number;
  digest: string;
  supportDigest: string;
}

/** 发现并解析出来的测试运行器身份。 */
export interface DetectedTestRunner {
  name: 'vitest';
  version: string;
  packageJsonSha256: string;
  /** 实际入口文件（bin/vitest.mjs）的路径哈希与内容 sha256 */
  entry?: { pathHash: string; sha256: string };
  /** 运行器直接依赖（vite / @vitest/runner）的身份与内容摘要 */
  deps?: { name: string; version: string; packageJsonSha256: string }[];
  /** 声明该运行器的 package.json 脚本原文（已批准摘要对应的同一份内容） */
  script: string;
  /** 脚本是否可安全追加宿主报告器参数（无 shell 组合、无过滤范围） */
  argsAppendable: boolean;
}

/** 配置指纹的稳定键：用于把「重新确认」绑定到具体测试范围/配置/运行器状态。 */
export function configFingerprintKey(cfg: ConfigFingerprint): string {
  const files = [...cfg.testConfigFiles]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((c) => `${c.path}:${c.sha256}`)
    .join(',');
  // R3-03：静态范围必须覆盖运行器入口与实际依赖，否则“换掉运行器入口/依赖”不会改变指纹
  const deps = [...(cfg.deps ?? [])]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((d) => `${d.name}@${d.version}:${d.packageJsonSha256}`)
    .join(',');
  return [
    cfg.scriptsDigest ?? '-',
    cfg.packageLockDigest ?? '-',
    cfg.runnerPackage ? `${cfg.runnerPackage.name}@${cfg.runnerPackage.version}:${cfg.runnerPackage.packageJsonSha256}` : '-',
    cfg.runnerEntry ? `${cfg.runnerEntry.pathHash}:${cfg.runnerEntry.sha256}` : '-',
    deps || '-',
    cfg.testInventoryDigest ?? '-',
    String(cfg.testFileCount ?? 0),
    String(cfg.testBlockCount ?? 0),
    String(cfg.assertionCount ?? 0),
    String(cfg.skipMarkerCount ?? 0),
    String(cfg.onlyMarkerCount ?? 0),
    files,
  ].join('|');
}

/** 路径身份哈希：统一用真实路径（realpath）的 sha256 前 32 位，采集与复核必须用同一算法。 */
export function pathIdentityHash(p: string): string {
  let real = p;
  try {
    real = fs.realpathSync(p);
  } catch {
    real = p;
  }
  return createHash('sha256').update(real).digest('hex').slice(0, 32);
}

import { createHash } from 'node:crypto';
import type { Task, TimelineEntry } from '../task/model.js';
import type { TaskState } from '../task/state.js';
import { describePermissions, type PermissionSummary } from './permission-text.js';
import { extractIncomplete, type IncompleteReport } from '../acceptance/incomplete.js';
import { filterDiagnosticNoise } from './noise.js';
import { exitFailureText, notCheckedText } from '../acceptance/texts.js';
import { classifyTaskState, type TaskClassification } from './task-state-view.js';

/**
 * 给渲染层看的任务视图：只含大白话与必要事实。
 * - 任何位置都不含原始命令（适配器的“运行命令”工具事件只会被概括成一句话）；
 * - 不含内部名词；实际生效的权限已翻译成中文；
 * - 诊断记录经过已知噪音过滤（原始 task.timeline 不改）。
 */
export interface ExtraDirView {
  key: string;
  path: string;
}
export interface CheckPlanView {
  name: 'build' | 'test';
  label: string;
}
export interface FactView {
  label: string;
  status: 'ok' | 'bad' | 'unchecked';
  detail: string;
}
export interface ResultView {
  headline: string;
  /** 宿主可验证的事实（退出状态、改动、检查） */
  facts: FactView[];
  changes: { path: string; status: string }[];
  /** “AI 报告以下操作未能完成”——AI 自己的说法 */
  incomplete: IncompleteReport;
  /** 意外的权限请求（已自动拒绝）的次数 */
  unexpectedRequests: number;
}
export interface TaskView {
  id: string;
  request: string;
  state: TaskState;
  stateText: string;
  goal: string;
  criteria: string[];
  mode: 'standard' | 'full_trust';
  network: boolean;
  extraDirs: ExtraDirView[];
  /** 完全信任任务：列表与施工视图持续显示标记 */
  fullTrust: boolean;
  fullTrustConfirmed: boolean;
  checks: CheckPlanView[];
  /** 实际生效的权限（开工并核验通过后才有） */
  permissions: PermissionSummary | null;
  /** AI 的文字说明与“正在修改文件 / 正在运行命令”这类概括 */
  progress: string[];
  /** 没能开工的原因（权限核验失败、完全信任未确认等） */
  startFailure: string | null;
  running: boolean;
  /** 启动核对修正过这个任务：一句话说明（列表标“已核对”）；否则 null */
  reconciled: string | null;
  result: ResultView | null;
  diagnostics: string[];
  /** 执行者名称（来自实际运行记录或任务配置，如 Codex / 模拟执行体） */
  executorName: string;
  /** 执行模型（来自实际运行记录，如 gpt-5 / gpt-4o） */
  model?: string;
  /** 执行者与模型完整文案（如 "Codex · gpt-5" 或 "Codex"） */
  executorText: string;
  /** 保存记录的检查结论（已保存或曾保存任务显示“检查通过”或“未检查”，不含命令） */
  saveCheckText: '检查通过' | '未检查' | null;
  /** UI v2.1 第 3 节三层状态与看板归类 */
  layer: TaskClassification;
  createdAt: string;
  updatedAt: string;
}

export const STATE_TEXT: Record<TaskState, string> = {
  draft: '草稿',
  clarifying: '等待澄清',
  planned: '计划待批准',
  approved: '已批准，准备开工',
  running: '施工中',
  exec_succeeded: 'AI 已结束',
  exec_failed: 'AI 没有顺利结束',
  stopped: '已停止',
  timed_out: '已超时',
  reviewing: '等待你验收',
  saved: '已保存',
  saved_cleanup_pending: '已保存，临时文件还没清理干净（需要处理）',
  save_failed_unmerged: '有冲突，没有保存',
  discarded: '已放弃',
  discard_cleanup_pending: '已放弃，临时文件还没清理干净（需要处理）',
  undone: '已撤销保存',
  undo_failed: '撤销没有成功',
};

export const extraDirKey = (p: string): string => createHash('sha1').update(p).digest('hex').slice(0, 10);

const CHECK_LABEL = { build: '构建', test: '测试' } as const;

/** 应用自己加的说明（而不是 AI 的话） */
const isHost = ({ source: origin }: TimelineEntry): boolean => origin === 'host';

/** 适配器写进时间线的工具事件是“name: 摘要”，其中可能含命令原文——只保留一句概括。 */
function summarizeTool(text: string): string {
  const name = text.split(':')[0] ?? '';
  if (/file_change|^write$|^delete$/.test(name)) return '正在修改文件';
  if (/run_command/.test(name)) return '正在运行命令（内容不显示）';
  return '正在使用其他工具';
}

const START_FAILURE_MARKERS: [RegExp, string][] = [
  [/^隔离无法确认/, '无法确认 AI 的权限设置符合预期，所以没有开工。你的文件没有任何改动。'],
  [/^隔离失败/, '检测到不该启动的外部工具被启动，为安全起见已中止任务。'],
  [/^完全信任模式未获确认/, '完全信任模式没有得到你的确认，所以没有开工。'],
  [/^无法确认用户配置的 MCP/, '无法确认 AI 工具的外部扩展已全部关闭，所以没有开工。'],
  [/^无法启动 Codex 任务/, '没能启动 AI，任务没有开始。'],
];

const checkStatusText = (s: string) => (s === 'passed' ? '通过' : s === 'failed' ? '未通过' : '未检查');

export function buildTaskView(task: Task, opts: { scripts: ('build' | 'test')[]; running: boolean }): TaskView {
  const caps = task.plan?.capabilities;
  const aiMessages = task.timeline.filter((e) => e.kind === 'message' && !isHost(e)).map((e) => e.text);
  const hostMessages = task.timeline.filter((e) => e.kind === 'message' && isHost(e)).map((e) => e.text);

  const progress: string[] = [];
  for (const e of task.timeline) {
    if (e.kind === 'message' && !isHost(e)) progress.push(filterDiagnosticNoise(e.text));
    else if (e.kind === 'tool') progress.push(summarizeTool(e.text));
    else if (e.kind === 'check') {
      const [name, status] = e.text.split(': ');
      progress.push(`检查「${CHECK_LABEL[name as 'build' | 'test'] ?? name}」：${checkStatusText(status ?? '')}`);
    }
  }
  // 连续重复的概括只留一条
  const compact = progress.filter((p, i) => p && p !== progress[i - 1]);

  let startFailure: string | null = null;
  for (const m of hostMessages) {
    const hit = START_FAILURE_MARKERS.find(([re]) => re.test(m));
    if (hit) startFailure = hit[1];
  }

  const denied = task.denied ?? [];
  const unexpected = denied.filter((d) => d.anomaly).length;
  let result: ResultView | null = null;
  if (task.card && task.exit) {
    const facts: FactView[] = [];
    const exit = task.card.items.find((i) => i.key === 'exit');
    // 只给结论，不带卡片里的原始证据文字（可能含启动错误原文）
    if (exit) facts.push({ label: 'AI 执行过程是否正常结束', status: exit.status === 'verified' ? 'ok' : 'bad', detail: exit.status === 'verified' ? '正常结束' : exitFailureText(task.exit) });
    facts.push({
      label: '改动了哪些文件',
      status: task.card.changes.length ? 'ok' : 'bad',
      detail: task.card.changes.length ? `${task.card.changes.length} 个文件发生变化` : '没有任何文件被修改',
    });
    for (const key of ['build', 'test'] as const) {
      const item = task.card.items.find((i) => i.key === key);
      if (!item) continue;
      facts.push({
        label: `检查「${CHECK_LABEL[key]}」`,
        status: item.status === 'verified' ? 'ok' : item.status === 'failed' ? 'bad' : 'unchecked',
        // 通过/失败只给结论，不给命令原文；“未检查”的原因本身是大白话
        detail: item.status === 'verified' ? '通过' : item.status === 'failed' ? '未通过' : notCheckedText(key, item.evidence),
      });
    }
    const incompleteSignals = (task.exit.kind !== 'exited' || task.exit.code !== 0) || denied.length > 0 || !!startFailure;
    result = {
      headline: task.card.headline,
      facts,
      changes: task.card.changes.map((c) => ({ path: c.path, status: c.status })),
      incomplete: extractIncomplete(aiMessages, { incompleteSignals }),
      unexpectedRequests: unexpected,
    };
  }

  const extraDirs = (caps?.extraWritableDirs ?? []).map((p) => ({ key: extraDirKey(p), path: p }));
  const executorName = task.executorName ?? (task.executorId === 'fake' ? '模拟执行体（测试用）' : 'Codex');
  const modelFromTimeline = task.timeline.find((e) => e.kind === 'isolation' && e.text.includes('模型='))
    ?.text.match(/模型=([^，；\s]+)/)?.[1];
  const model = task.model ?? (modelFromTimeline && modelFromTimeline !== '未知' ? modelFromTimeline : undefined);
  const executorText = model ? `${executorName} · ${model}` : executorName;

  return {
    id: task.id,
    request: task.request,
    state: task.state,
    stateText: STATE_TEXT[task.state],
    goal: task.plan?.goal ?? task.request,
    criteria: task.plan?.criteria ?? [],
    mode: caps?.constructionMode ?? 'standard',
    network: caps?.externalNetwork === 'on',
    extraDirs,
    fullTrust: caps?.constructionMode === 'full_trust',
    fullTrustConfirmed: !!task.fullTrustConfirmedAt,
    checks: opts.scripts.map((name) => ({ name, label: CHECK_LABEL[name] })),
    permissions: describePermissions(task.effectivePermissions),
    progress: compact,
    startFailure,
    running: opts.running,
    reconciled: task.reconciled ? `已核对：${task.reconciled.note}` : null,
    result,
    executorName,
    model,
    executorText,
    saveCheckText: task.saveRecord ? (task.saveRecord.checked === true ? '检查通过' : '未检查') : null,
    layer: classifyTaskState(task, { isLiveRunning: opts.running }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    // 诊断记录：时间线的文字（含应用自己的说明），经已知噪音过滤；工具事件只留概括，不含命令
    diagnostics: task.timeline
      .filter((e) => e.kind !== 'tool' && e.kind !== 'isolation' && e.kind !== 'state')
      .map((e) => filterDiagnosticNoise(e.text))
      .filter(Boolean),
  };
}

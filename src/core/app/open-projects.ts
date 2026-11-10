import path from 'node:path';
import { scrubAiText } from '../acceptance/texts.js';
import type { Task } from '../task/model.js';
import type { TaskState } from '../task/state.js';
import type { ModePreference } from './prefs.js';
import { TaskController } from './task-controller.js';

export interface ClosableStore {
  close(): Promise<void>;
}

export interface OpenProjectEntry<TStore extends ClosableStore = ClosableStore> {
  id: string;
  path: string;
  name: string;
  controller: TaskController;
  recordStore: TStore;
}

export interface OpenProjectSummary {
  id: string;
  name: string;
  path: string;
  needsAttentionCount: number;
  runningCount: number;
  hasAbnormal: boolean;
  manualReviewLocked: boolean;
  preferredMode: ModePreference;
}

export type CloseProjectResult =
  | { ok: true }
  | { ok: false; reason: string };

export type WorkbenchNextAction =
  | { kind: 'open_task'; projectId: string; taskId: string; label: string }
  | { kind: 'open_history'; projectId: string; taskId: string; label: string }
  | { kind: 'open_settings_health'; label: string };

export interface WorkbenchEntry {
  id: string;
  kind: 'task' | 'health';
  projectId: string | null;
  projectName: string;
  taskId?: string;
  taskName: string;
  round?: number;
  state: TaskState | 'health_issue';
  statusLabel: string;
  isAbnormal: boolean;
  impact: string;
  nextAction: WorkbenchNextAction;
  updatedAt: string;
}

export interface WorkbenchView {
  needsDecision: WorkbenchEntry[];
  running: WorkbenchEntry[];
  recentEnded: WorkbenchEntry[];
  counts: {
    needsDecision: number;
    running: number;
    recentEnded: number;
  };
  projects: OpenProjectSummary[];
}

export const PROJECT_ID_RE = /^[a-z0-9-]{1,64}$/;
const RECENT_ENDED_LIMIT = 30;

function taskTitle(t: Task): string {
  return scrubAiText(t.plan?.goal ?? t.request);
}

/**
 * 已打开项目表：按 projectId 索引每个已打开项目的 TaskController 与 RecordStore。
 * - 打开新项目不关闭其他项目；
 * - 所有项目/任务操作先校验 projectId 是否存在于本表，伪造或未打开的项目编号立即拒绝；
 * - 关闭项目时若该项目仍有任务在施工/处理中，拒绝关闭并说明原因。
 */
export class OpenProjectManager<TStore extends ClosableStore = ClosableStore> {
  private readonly entries = new Map<string, OpenProjectEntry<TStore>>();
  private activeProjectId: string | null = null;
  private healthProbe: (() => Promise<WorkbenchEntry[]>) | undefined;

  setHealthProbe(fn: (() => Promise<WorkbenchEntry[]>) | undefined): void {
    this.healthProbe = fn;
  }

  isValidId(projectId: unknown): projectId is string {
    return typeof projectId === 'string' && PROJECT_ID_RE.test(projectId);
  }

  has(projectId: unknown): boolean {
    return this.isValidId(projectId) && this.entries.has(projectId);
  }

  get size(): number {
    return this.entries.size;
  }

  get activeId(): string | null {
    return this.activeProjectId;
  }

  setActive(projectId: unknown): OpenProjectEntry<TStore> {
    const entry = this.require(projectId);
    this.activeProjectId = entry.id;
    return entry;
  }

  find(projectId: unknown): OpenProjectEntry<TStore> | null {
    if (!this.isValidId(projectId)) return null;
    return this.entries.get(projectId) ?? null;
  }

  findByPath(repoPath: string): OpenProjectEntry<TStore> | null {
    for (const entry of this.entries.values()) {
      if (entry.path === repoPath) return entry;
    }
    return null;
  }

  /** 校验项目编号格式且必须在「已打开项目表」中；不属于则立即抛出错误，不触碰任何项目。 */
  require(projectId: unknown): OpenProjectEntry<TStore> {
    if (!this.isValidId(projectId)) throw new Error('无效的项目编号。');
    const entry = this.entries.get(projectId);
    if (!entry) throw new Error('找不到这个已打开的项目。');
    return entry;
  }

  /** 将已打开的项目登记进表（同一 id 或同一路径直接返回已有项，不重复创建）。 */
  open(input: Omit<OpenProjectEntry<TStore>, 'name'> & { name?: string }): OpenProjectEntry<TStore> {
    if (!this.isValidId(input.id)) throw new Error('无效的项目编号。');
    const byId = this.entries.get(input.id);
    if (byId) {
      this.activeProjectId = byId.id;
      return byId;
    }
    const byPath = this.findByPath(input.path);
    if (byPath) {
      this.activeProjectId = byPath.id;
      return byPath;
    }
    const entry: OpenProjectEntry<TStore> = {
      ...input,
      name: input.name ?? path.basename(input.path),
    };
    this.entries.set(entry.id, entry);
    this.activeProjectId = entry.id;
    return entry;
  }

  list(): OpenProjectEntry<TStore>[] {
    return [...this.entries.values()];
  }

  /** 关闭已打开项目：先校验归属；若项目内仍有施工中或处理中任务则拒绝关闭并说明原因；否则释放其存储锁并移除。 */
  async close(projectId: unknown): Promise<CloseProjectResult> {
    const entry = this.require(projectId);
    if (await entry.controller.hasRunningTasks()) {
      return { ok: false, reason: '这个项目还有任务正在施工或处理中，请先停止后再关闭。' };
    }
    this.entries.delete(entry.id);
    if (this.activeProjectId === entry.id) {
      this.activeProjectId = this.entries.keys().next().value ?? null;
    }
    await entry.recordStore.close();
    return { ok: true };
  }

  private async summarizeOne(entry: OpenProjectEntry<TStore>): Promise<{
    summary: OpenProjectSummary;
    entries: { group: 'needsDecision' | 'running' | 'recentEnded'; item: WorkbenchEntry }[];
  }> {
    const [tasks, preferredMode] = await Promise.all([
      entry.controller.listTasksRaw(),
      entry.controller.preferredMode(),
    ]);
    let needsAttentionCount = 0;
    let runningCount = 0;
    let hasAbnormal = false;
    let manualReviewLocked = false;
    const classified = await Promise.all(tasks.map(async (t) => ({ t, cls: await entry.controller.classifyTask(t) })));
    const entries: { group: 'needsDecision' | 'running' | 'recentEnded'; item: WorkbenchEntry }[] = [];

    for (const { t, cls } of classified) {
      if (t.manualReview) manualReviewLocked = true;
      if (cls.isAbnormal) hasAbnormal = true;
      if (cls.workbenchGroup === 'needs_decision') needsAttentionCount++;
      else if (cls.workbenchGroup === 'running') runningCount++;

      const nextAction: WorkbenchNextAction =
        cls.actionKind === 'open_history'
          ? { kind: 'open_history', projectId: entry.id, taskId: t.id, label: cls.actionLabel }
          : { kind: 'open_task', projectId: entry.id, taskId: t.id, label: cls.actionLabel };

      const group =
        cls.workbenchGroup === 'needs_decision'
          ? 'needsDecision'
          : cls.workbenchGroup === 'running'
            ? 'running'
            : 'recentEnded';

      entries.push({
        group,
        item: {
          id: `${entry.id}:${t.id}`,
          kind: 'task',
          projectId: entry.id,
          projectName: entry.name,
          taskId: t.id,
          taskName: taskTitle(t),
          round: t.currentRound ?? (t.rounds?.length ? Math.max(...t.rounds.map((r) => r.round)) : 1),
          state: t.state,
          statusLabel: cls.statusTag,
          isAbnormal: cls.isAbnormal,
          impact: cls.impact,
          nextAction,
          updatedAt: t.updatedAt,
        },
      });
    }

    return {
      summary: {
        id: entry.id,
        name: entry.name,
        path: entry.path,
        needsAttentionCount,
        runningCount,
        hasAbnormal,
        manualReviewLocked,
        preferredMode,
      },
      entries,
    };
  }

  async listSummaries(): Promise<OpenProjectSummary[]> {
    const results = await Promise.all(this.list().map((e) => this.summarizeOne(e)));
    return results.map((r) => r.summary);
  }

  /** 汇总所有已打开项目的任务：返回需要你决定 / 正在运行 / 最近结束三组及汇总计数。 */
  async getWorkbench(): Promise<WorkbenchView> {
    const perProject = await Promise.all(this.list().map((e) => this.summarizeOne(e)));
    const needsDecision: WorkbenchEntry[] = [];
    const running: WorkbenchEntry[] = [];
    const recentEnded: WorkbenchEntry[] = [];

    for (const p of perProject) {
      for (const e of p.entries) {
        if (e.group === 'needsDecision') needsDecision.push(e.item);
        else if (e.group === 'running') running.push(e.item);
        else recentEnded.push(e.item);
      }
    }

    if (this.healthProbe) {
      const issues = await this.healthProbe().catch(() => []);
      for (const issue of issues) needsDecision.push(issue);
    }

    needsDecision.sort((a, b) => {
      if (a.isAbnormal !== b.isAbnormal) return a.isAbnormal ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    running.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    recentEnded.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const trimmedEnded = recentEnded.slice(0, RECENT_ENDED_LIMIT);

    return {
      needsDecision,
      running,
      recentEnded: trimmedEnded,
      counts: {
        needsDecision: needsDecision.length,
        running: running.length,
        recentEnded: trimmedEnded.length,
      },
      projects: perProject.map((p) => p.summary),
    };
  }
}

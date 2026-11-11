import type { ApiProviderPreset } from '../executor/api/catalog.js';
import { DEFAULT_CLAUDE_API_MODEL } from '../thinking/claude-api.js';
import { AppStore, type AppStoreOptions } from './app-store.js';
import type { ClaudeKeyStatus } from './claude-key.js';
import type { ProviderProfileView } from './provider-profiles.js';

export type AiProviderId = 'codex' | 'claude';
export type ChiefRoleChoice = AiProviderId | 'unset';
export type ReviewerRoleChoice = AiProviderId | 'none' | 'unset';
export type ProjectRoleMode = 'global' | 'custom';
export type ExecutorChoice = 'codex' | `api:${string}` | 'unset';

export interface VerifiedExecutorOption {
  id: 'codex' | `api:${string}`;
  label: string;
  kind: 'codex' | 'api';
  presetId?: string;
  presetName?: string;
  model?: string;
  endpointOrigin?: string;
  officialEndpoint: boolean;
}

export interface EffectiveExecutorResult {
  source: 'project' | 'global';
  sourceLabel: string;
  id: string;
  label: string;
  problem: string | null;
}

export interface ProjectExecutorConfig {
  mode: ProjectRoleMode;
  executor: string;
}

export interface GlobalAiRoles {
  chief: ChiefRoleChoice;
  reviewer: ReviewerRoleChoice;
  claudeModel: string;
}

export interface ProjectAiRolesConfig {
  mode: ProjectRoleMode;
  chief: ChiefRoleChoice;
  reviewer: ReviewerRoleChoice;
}

export interface AiAvailability {
  codexAvailable: boolean;
  codexStatusLabel: string;
  codexDetail: string;
  claudeKey: ClaudeKeyStatus;
}

export interface EffectiveRolesResult {
  source: 'project' | 'global';
  sourceLabel: string;
  chief: ChiefRoleChoice;
  reviewer: ReviewerRoleChoice;
  sameAi: boolean;
  single: boolean;
  claudeModel: string;
  problem: string | null;
}

export interface GlobalAiSettingsView {
  codex: {
    available: boolean;
    statusLabel: string;
    detail: string;
  };
  claudeKey: ClaudeKeyStatus;
  roles: GlobalAiRoles;
  sameAiNotice: string | null;
  availableClaudeModels: string[];
  executorPresets?: readonly ApiProviderPreset[];
  providerProfiles?: ProviderProfileView[];
  verifiedExecutors?: VerifiedExecutorOption[];
  defaultExecutor?: string;
  executorProblem?: string | null;
}

export interface ProjectRolesView {
  mode: ProjectRoleMode;
  chief: ChiefRoleChoice;
  reviewer: ReviewerRoleChoice;
  globalRoles: GlobalAiRoles;
  effective: EffectiveRolesResult;
  codexAvailable: boolean;
  claudeAvailable: boolean;
  sameAiNotice: string | null;
  executorMode?: ProjectRoleMode;
  projectExecutor?: string;
  effectiveExecutor?: EffectiveExecutorResult;
  verifiedExecutors?: VerifiedExecutorOption[];
}

export const DEFAULT_GLOBAL_AI_ROLES: GlobalAiRoles = {
  chief: 'codex',
  reviewer: 'none',
  claudeModel: DEFAULT_CLAUDE_API_MODEL,
};

/** 已知可用的当前一代 Anthropic 模型选项（2026-11-11 查证），同时允许输入任意模型 ID。 */
export const SUGGESTED_CLAUDE_MODELS = [
  DEFAULT_CLAUDE_API_MODEL,
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
];

const GLOBAL_ROLES_RECORD_ID = 'ai-roles';
const PROJECT_ROLES_RECORD_ID = 'project-ai-roles';

export function providerDisplayName(id: AiProviderId): string {
  return id === 'claude' ? 'Claude（API）' : 'ChatGPT（Codex）';
}

export function buildSameAiNotice(chief: ChiefRoleChoice, reviewer: ReviewerRoleChoice): string | null {
  if ((chief === 'codex' || chief === 'claude') && chief === reviewer) {
    const label = chief === 'claude' ? 'Claude' : 'Codex';
    return `「首席」与「复核」都选择了 ${label}：由于不是两个独立的 AI，讨论将按单思考者模式运行，并标记「未经独立评审」。`;
  }
  return null;
}

function parseChief(raw: unknown, allowUnset: boolean): ChiefRoleChoice {
  if (raw === 'codex' || raw === 'claude') return raw;
  if (allowUnset && raw === 'unset') return 'unset';
  return 'codex';
}

function parseReviewer(raw: unknown, allowUnset: boolean): ReviewerRoleChoice {
  if (raw === 'codex' || raw === 'claude' || raw === 'none') return raw;
  if (allowUnset && raw === 'unset') return 'unset';
  return 'none';
}

function assertProviderConnected(
  roleLabel: string,
  choice: AiProviderId,
  avail: { codexAvailable: boolean; claudeAvailable: boolean },
): void {
  if (choice === 'codex' && !avail.codexAvailable) {
    throw new Error(`角色「${roleLabel}」所选 Codex 尚未接入或未登录，请先在终端完成 Codex 登录后再保存。`);
  }
  if (choice === 'claude' && !avail.claudeAvailable) {
    throw new Error(`角色「${roleLabel}」所选 Claude 尚未接入，请先在上方保存并验证 Anthropic API Key 后再保存。`);
  }
}

/**
 * 全局 AI 角色配置与项目级角色覆盖存储（userData AppStore）。
 * - 产品默认值（未设置过时）：首席 Codex、复核 不复核（与阶段 5a 一致）、执行 固定 Codex；
 * - 选了未接入的 AI 不允许保存；
 * - 删除 Claude API Key 后，全局及各项目中选了 Claude 的角色自动回退为 `unset`（「未设置」）。
 */
export class AiSettingsStore {
  private readonly app: AppStore;

  constructor(dataDir: string, storeOpts: AppStoreOptions = {}) {
    this.app = new AppStore(dataDir, storeOpts);
  }

  async getGlobalRoles(): Promise<GlobalAiRoles> {
    const raw = await this.app.read(GLOBAL_ROLES_RECORD_ID);
    if (!raw) return { ...DEFAULT_GLOBAL_AI_ROLES };
    const model =
      typeof raw.claudeModel === 'string' && raw.claudeModel.trim()
        ? raw.claudeModel.trim()
        : DEFAULT_CLAUDE_API_MODEL;
    return {
      chief: parseChief(raw.chief, true),
      reviewer: parseReviewer(raw.reviewer, true),
      claudeModel: model,
    };
  }

  async saveGlobalRoles(
    input: { chief: unknown; reviewer: unknown; claudeModel?: unknown },
    avail: { codexAvailable: boolean; claudeAvailable: boolean },
  ): Promise<GlobalAiRoles> {
    if (input.chief !== 'codex' && input.chief !== 'claude') {
      throw new Error('请先为默认「首席」选择一个已接入的 AI（Codex 或 Claude）。');
    }
    if (input.reviewer !== 'codex' && input.reviewer !== 'claude' && input.reviewer !== 'none') {
      throw new Error('请先为默认「复核」选择一个选项（Codex / Claude / 不复核）。');
    }
    assertProviderConnected('首席', input.chief, avail);
    if (input.reviewer !== 'none') {
      assertProviderConnected('复核', input.reviewer, avail);
    }

    const cur = await this.getGlobalRoles();
    const claudeModel =
      typeof input.claudeModel === 'string' && input.claudeModel.trim()
        ? input.claudeModel.trim().slice(0, 100)
        : cur.claudeModel || DEFAULT_CLAUDE_API_MODEL;

    const next: GlobalAiRoles = {
      chief: input.chief,
      reviewer: input.reviewer,
      claudeModel,
    };
    await this.app.update(
      GLOBAL_ROLES_RECORD_ID,
      {},
      () => ({ ...next, updatedAt: new Date().toISOString() }),
      'ai-roles-save',
    );
    return next;
  }

  private async readProjectMap(): Promise<Record<string, ProjectAiRolesConfig>> {
    const raw = await this.app.read(PROJECT_ROLES_RECORD_ID);
    const projects = raw?.projects;
    if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return {};
    const out: Record<string, ProjectAiRolesConfig> = {};
    for (const [key, val] of Object.entries(projects as Record<string, unknown>)) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
      const v = val as Record<string, unknown>;
      out[key] = {
        mode: v.mode === 'custom' ? 'custom' : 'global',
        chief: parseChief(v.chief, true),
        reviewer: parseReviewer(v.reviewer, true),
      };
    }
    return out;
  }

  async getProjectRoles(projectRoot: string): Promise<ProjectAiRolesConfig> {
    const map = await this.readProjectMap();
    const hit = map[projectRoot];
    if (hit) return hit;
    const global = await this.getGlobalRoles();
    return {
      mode: 'global',
      chief: global.chief,
      reviewer: global.reviewer,
    };
  }

  async saveProjectRoles(
    projectRoot: string,
    input: { mode: unknown; chief?: unknown; reviewer?: unknown },
    avail: { codexAvailable: boolean; claudeAvailable: boolean },
  ): Promise<ProjectAiRolesConfig> {
    if (input.mode !== 'global' && input.mode !== 'custom') {
      throw new Error('无效的角色来源设置，请选择「跟随全局设置」或「本项目单独设置」。');
    }

    const prev = await this.getProjectRoles(projectRoot);
    let chief: ChiefRoleChoice = prev.chief;
    let reviewer: ReviewerRoleChoice = prev.reviewer;

    if (input.mode === 'custom') {
      if (input.chief !== 'codex' && input.chief !== 'claude') {
        throw new Error('请为本项目的「首席」选择一个已接入的 AI（Codex 或 Claude）。');
      }
      if (input.reviewer !== 'codex' && input.reviewer !== 'claude' && input.reviewer !== 'none') {
        throw new Error('请为本项目的「复核」选择一个选项（Codex / Claude / 不复核）。');
      }
      assertProviderConnected('首席', input.chief, avail);
      if (input.reviewer !== 'none') {
        assertProviderConnected('复核', input.reviewer, avail);
      }
      chief = input.chief;
      reviewer = input.reviewer;
    }

    const next: ProjectAiRolesConfig = {
      mode: input.mode,
      chief,
      reviewer,
    };
    await this.app.update(
      PROJECT_ROLES_RECORD_ID,
      {},
      (cur) => ({
        projects: {
          ...((cur.projects && typeof cur.projects === 'object' && !Array.isArray(cur.projects)
            ? cur.projects
            : {}) as Record<string, unknown>),
          [projectRoot]: next,
        },
      }),
      'project-ai-roles-save',
    );
    return next;
  }

  /** 删除 Claude API Key 后调用：所有使用 Claude 的角色自动回退为「未设置」（unset）。 */
  async onClaudeKeyDeleted(): Promise<void> {
    const global = await this.getGlobalRoles();
    if (global.chief === 'claude' || global.reviewer === 'claude') {
      await this.app.update(
        GLOBAL_ROLES_RECORD_ID,
        {},
        () => ({
          chief: global.chief === 'claude' ? 'unset' : global.chief,
          reviewer: global.reviewer === 'claude' ? 'unset' : global.reviewer,
          claudeModel: global.claudeModel,
          updatedAt: new Date().toISOString(),
        }),
        'ai-roles-key-deleted',
      );
    }

    const projMap = await this.readProjectMap();
    let changed = false;
    const nextMap: Record<string, ProjectAiRolesConfig> = {};
    for (const [proj, cfg] of Object.entries(projMap)) {
      if (cfg.chief === 'claude' || cfg.reviewer === 'claude') {
        changed = true;
        nextMap[proj] = {
          mode: cfg.mode,
          chief: cfg.chief === 'claude' ? 'unset' : cfg.chief,
          reviewer: cfg.reviewer === 'claude' ? 'unset' : cfg.reviewer,
        };
      } else {
        nextMap[proj] = cfg;
      }
    }
    if (changed) {
      await this.app.update(
        PROJECT_ROLES_RECORD_ID,
        {},
        () => ({ projects: nextMap }),
        'project-ai-roles-key-deleted',
      );
    }
  }

  /** 按「项目设置 → 全局设置」解析当前项目讨论应使用的角色与问题提示。 */
  async resolveEffectiveRoles(
    projectRoot: string,
    avail?: { codexAvailable?: boolean; claudeAvailable?: boolean },
  ): Promise<EffectiveRolesResult> {
    const [global, project] = await Promise.all([
      this.getGlobalRoles(),
      this.getProjectRoles(projectRoot),
    ]);
    const useProject = project.mode === 'custom';
    const chief = useProject ? project.chief : global.chief;
    const reviewer = useProject ? project.reviewer : global.reviewer;
    const sameAi = (chief === 'codex' || chief === 'claude') && chief === reviewer;
    const single = sameAi || reviewer === 'none';

    let problem: string | null = null;
    if (chief === 'unset') {
      problem = '「首席」角色已回退为「未设置」（Anthropic API Key 已删除或未配置），请先在设置中重新指定 AI 或重新添加 Key。';
    } else if (reviewer === 'unset') {
      problem = '「复核」角色已回退为「未设置」（Anthropic API Key 已删除或未配置），请先在设置中重新指定 AI 或改为「不复核」。';
    } else if (avail?.claudeAvailable === false && (chief === 'claude' || reviewer === 'claude')) {
      problem = '当前角色配置用到了 Claude，但 Anthropic API Key 未设置或不可用，请先在设置中完成配置。';
    }

    return {
      source: useProject ? 'project' : 'global',
      sourceLabel: useProject ? '本项目单独设置' : '跟随全局设置',
      chief,
      reviewer,
      sameAi,
      single,
      claudeModel: global.claudeModel,
      problem,
    };
  }

  async getDefaultExecutor(): Promise<string> {
    const raw = await this.app.read('ai-executor');
    if (raw && typeof raw.executor === 'string' && raw.executor.trim()) {
      return raw.executor.trim();
    }
    return 'codex';
  }

  async saveDefaultExecutor(
    executorId: unknown,
    verified: VerifiedExecutorOption[],
  ): Promise<string> {
    if (typeof executorId !== 'string' || !executorId.trim()) {
      throw new Error('请选择一个已验证的执行者。');
    }
    const id = executorId.trim();
    if (!verified.some((v) => v.id === id)) {
      throw new Error(
        id === 'codex'
          ? 'Codex 尚未就绪（未安装或未登录），请先在终端登录 Codex 或选用已测通的 API 执行者。'
          : '所选 API 执行者尚未通过连接测试或不支持工具调用，请先在下方测试通过后再设为执行者。',
      );
    }
    await this.app.update('ai-executor', {}, () => ({ executor: id, updatedAt: new Date().toISOString() }), 'ai-executor-save');
    return id;
  }

  private async readProjectExecutorMap(): Promise<Record<string, ProjectExecutorConfig>> {
    const raw = await this.app.read('project-ai-executors');
    const projects = raw?.projects;
    if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return {};
    const out: Record<string, ProjectExecutorConfig> = {};
    for (const [k, v] of Object.entries(projects as Record<string, unknown>)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const cfg = v as Record<string, unknown>;
      out[k] = {
        mode: cfg.mode === 'custom' ? 'custom' : 'global',
        executor: typeof cfg.executor === 'string' && cfg.executor.trim() ? cfg.executor.trim() : 'codex',
      };
    }
    return out;
  }

  async getProjectExecutor(projectRoot: string): Promise<ProjectExecutorConfig> {
    const map = await this.readProjectExecutorMap();
    if (map[projectRoot]) return map[projectRoot]!;
    return { mode: 'global', executor: await this.getDefaultExecutor() };
  }

  async saveProjectExecutor(
    projectRoot: string,
    mode: unknown,
    executorId: unknown,
    verified: VerifiedExecutorOption[],
  ): Promise<ProjectExecutorConfig> {
    if (mode !== 'global' && mode !== 'custom') {
      throw new Error('无效的执行者来源设置，请选择「跟随全局设置」或「本项目单独设置」。');
    }
    let nextExec = await this.getDefaultExecutor();
    if (mode === 'custom') {
      if (typeof executorId !== 'string' || !executorId.trim()) {
        throw new Error('请为本项目选择一个已通过连接测试的执行者。');
      }
      nextExec = executorId.trim();
      if (!verified.some((v) => v.id === nextExec)) {
        throw new Error('所选执行者尚未连接测试通过，不能指定为本项目执行者。');
      }
    }
    const next: ProjectExecutorConfig = { mode, executor: nextExec };
    await this.app.update(
      'project-ai-executors',
      {},
      (cur) => ({
        projects: {
          ...((cur.projects && typeof cur.projects === 'object' && !Array.isArray(cur.projects)
            ? cur.projects
            : {}) as Record<string, unknown>),
          [projectRoot]: next,
        },
      }),
      'project-ai-executor-save',
    );
    return next;
  }

  /** 当某条 API 服务商配置被删除后，引用它的全局/项目执行者回退为 unset。 */
  async onProviderProfileDeleted(profileId: string): Promise<void> {
    const target = `api:${profileId}`;
    const def = await this.getDefaultExecutor();
    if (def === target) {
      await this.app.update('ai-executor', {}, () => ({ executor: 'unset', updatedAt: new Date().toISOString() }), 'ai-executor-deleted');
    }
    const map = await this.readProjectExecutorMap();
    let changed = false;
    const nextMap: Record<string, ProjectExecutorConfig> = {};
    for (const [k, v] of Object.entries(map)) {
      if (v.mode === 'custom' && v.executor === target) {
        changed = true;
        nextMap[k] = { mode: 'custom', executor: 'unset' };
      } else {
        nextMap[k] = v;
      }
    }
    if (changed) {
      await this.app.update('project-ai-executors', {}, () => ({ projects: nextMap }), 'project-ai-executor-deleted');
    }
  }

  async resolveEffectiveExecutor(
    projectRoot: string,
    verified: VerifiedExecutorOption[],
  ): Promise<EffectiveExecutorResult> {
    const [def, proj] = await Promise.all([this.getDefaultExecutor(), this.getProjectExecutor(projectRoot)]);
    const useProj = proj.mode === 'custom';
    const id = useProj ? proj.executor : def;
    const hit = verified.find((v) => v.id === id);
    let label = hit?.label ?? (id === 'codex' ? 'Codex' : id === 'unset' ? '未设置' : id);
    let problem: string | null = null;
    if (id === 'unset') {
      problem = '执行者已回退为「未设置」（原配置已删除），请先在设置中重新指定执行者。';
    } else if (!hit) {
      problem = `当前选定的执行者（${label}）尚未就绪或未通过连接测试，请前往「设置 → AI 与角色」检查后再开工。`;
    }
    return {
      source: useProj ? 'project' : 'global',
      sourceLabel: useProj ? '本项目单独设置' : '跟随全局设置',
      id,
      label,
      problem,
    };
  }
}

export function buildVerifiedExecutorOptions(
  codexAvailable: boolean,
  profiles: ProviderProfileView[],
): VerifiedExecutorOption[] {
  const out: VerifiedExecutorOption[] = [];
  if (codexAvailable) {
    out.push({
      id: 'codex',
      label: 'Codex（本机）',
      kind: 'codex',
      officialEndpoint: true,
    });
  }
  for (const p of profiles) {
    if (!p.executorReady) continue;
    out.push({
      id: `api:${p.id}`,
      label: `${p.label}（API）`,
      kind: 'api',
      presetId: p.presetId,
      presetName: p.presetName,
      model: p.model,
      endpointOrigin: p.endpointOrigin,
      officialEndpoint: p.officialEndpoint,
    });
  }
  return out;
}

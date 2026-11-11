import { AppStore, type AppStoreOptions } from './app-store.js';
import {
  findSubscriptionCliSpec,
  isSubscriptionCliId,
  SUBSCRIPTION_CLI_CATALOG,
  type RiskGateRecord,
  type SubscriptionCliId,
  type SubscriptionRiskGate,
} from '../executor/cli/subscriptions.js';
import type { DetectResult } from '../executor/types.js';

const RECORD_ID = 'subscription-clis';

export interface StoredSubscriptionEntry extends RiskGateRecord {
  enabled: boolean;
  model?: string;
  lastVerifiedAt?: string;
}

export interface SubscriptionCliProbeResult {
  detect: DetectResult;
}

export interface SubscriptionCliView {
  id: SubscriptionCliId;
  name: string;
  binaryName: 'claude' | 'agy' | 'agent';
  displayName: string;
  installed: boolean;
  loggedIn: 'yes' | 'no' | 'unknown';
  version: string | null;
  statusLabel: string;
  detail: string;
  riskVersion: number;
  riskTitle: string;
  riskBullets: readonly string[];
  officialAlternative: string;
  isolationHonesty: string;
  suggestedModels: readonly string[];
  model: string;
  enabled: boolean;
  riskAcknowledgedAt: string | null;
  lastVerifiedAt: string | null;
  executorReady: boolean;
}

export interface SubscriptionEnableInput {
  cliId: string;
  riskAck: boolean;
  model?: string;
}

export type SubscriptionEnableResult =
  | { ok: true; item: SubscriptionCliView; message: string }
  | { ok: false; message: string };

/**
 * 本地订阅制 CLI 的风险确认与启用状态持久化（userData `subscription-clis`）。
 * - 绝不读取、存储或转发任何外部工具的账号密码与登录令牌；
 * - 只有本机检测到命令、用户显式勾选确认当前版本风险并完成连接检查后，才标记 `executorReady: true`。
 */
export class SubscriptionCliStore implements SubscriptionRiskGate {
  private readonly app: AppStore;

  constructor(dataDir: string, storeOpts: AppStoreOptions = {}) {
    this.app = new AppStore(dataDir, storeOpts);
  }

  private async readMap(): Promise<Partial<Record<SubscriptionCliId, StoredSubscriptionEntry>>> {
    const raw = await this.app.read(RECORD_ID);
    const items = raw?.items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) return {};
    const out: Partial<Record<SubscriptionCliId, StoredSubscriptionEntry>> = {};
    for (const [k, v] of Object.entries(items as Record<string, unknown>)) {
      if (!isSubscriptionCliId(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
      const e = v as Partial<StoredSubscriptionEntry>;
      out[k] = {
        enabled: e.enabled === true,
        ...(typeof e.model === 'string' && e.model.trim() ? { model: e.model.trim().slice(0, 120) } : {}),
        ...(typeof e.riskAcknowledgedAt === 'string' ? { riskAcknowledgedAt: e.riskAcknowledgedAt } : {}),
        ...(typeof e.acknowledgedRiskVersion === 'number' ? { acknowledgedRiskVersion: e.acknowledgedRiskVersion } : {}),
        ...(typeof e.lastVerifiedAt === 'string' ? { lastVerifiedAt: e.lastVerifiedAt } : {}),
      };
    }
    return out;
  }

  async getRiskRecord(cliId: SubscriptionCliId): Promise<StoredSubscriptionEntry | null> {
    const map = await this.readMap();
    return map[cliId] ?? null;
  }

  async listViews(
    probeById: (cliId: SubscriptionCliId) => Promise<DetectResult>,
  ): Promise<SubscriptionCliView[]> {
    const map = await this.readMap();
    return Promise.all(
      SUBSCRIPTION_CLI_CATALOG.map(async (spec) => {
        const saved = map[spec.id];
        let detect: DetectResult;
        try {
          detect = await probeById(spec.id);
        } catch (err) {
          detect = {
            installed: false,
            loggedIn: 'unknown',
            note: err instanceof Error ? err.message : String(err),
          };
        }
        const riskValid =
          !!saved?.riskAcknowledgedAt && saved.acknowledgedRiskVersion === spec.riskVersion;
        const enabled = saved?.enabled === true && riskValid;
        const executorReady =
          enabled &&
          detect.installed &&
          detect.loggedIn !== 'no' &&
          !!saved?.lastVerifiedAt;

        let statusLabel = '未安装';
        if (!detect.installed) statusLabel = '未安装';
        else if (detect.loggedIn === 'no') statusLabel = '未登录';
        else if (executorReady) statusLabel = '已启用（风险自担）';
        else if (enabled) statusLabel = '待重新校验';
        else statusLabel = '未启用（需先确认风险）';

        const detail =
          detect.note ??
          (!detect.installed
            ? `未在本机找到 ${spec.binaryName} 命令`
            : detect.loggedIn === 'no'
              ? `已安装 ${spec.name}，但当前尚未登录`
              : executorReady
                ? `${spec.name}${detect.version ? ` (${detect.version})` : ''} 已通过检测并启用`
                : `已检测到 ${spec.name}${detect.version ? ` (${detect.version})` : ''}，勾选风险确认后可连接使用`);

        return {
          id: spec.id,
          name: spec.name,
          binaryName: spec.binaryName,
          displayName: spec.displayName,
          installed: detect.installed,
          loggedIn: detect.loggedIn,
          version: detect.version ?? null,
          statusLabel,
          detail,
          riskVersion: spec.riskVersion,
          riskTitle: spec.riskTitle,
          riskBullets: spec.riskBullets,
          officialAlternative: spec.officialAlternative,
          isolationHonesty: spec.isolationHonesty,
          suggestedModels: spec.suggestedModels,
          model: saved?.model ?? '',
          enabled,
          riskAcknowledgedAt: saved?.riskAcknowledgedAt ?? null,
          lastVerifiedAt: saved?.lastVerifiedAt ?? null,
          executorReady,
        };
      }),
    );
  }

  async testAndEnable(
    input: SubscriptionEnableInput,
    probe: (cliId: SubscriptionCliId, model?: string) => Promise<DetectResult>,
  ): Promise<SubscriptionEnableResult> {
    if (!isSubscriptionCliId(input.cliId)) {
      return { ok: false, message: '未识别的本地订阅 CLI 选项。' };
    }
    const spec = findSubscriptionCliSpec(input.cliId)!;
    if (input.riskAck !== true) {
      return {
        ok: false,
        message: `请先阅读并勾选同意「${spec.name}」的条款与风险说明，再开启连接。`,
      };
    }
    const model = typeof input.model === 'string' ? input.model.trim().slice(0, 120) : '';
    let d: DetectResult;
    try {
      d = await probe(spec.id, model || undefined);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : '检测本地工具失败。' };
    }
    if (!d.installed) {
      return {
        ok: false,
        message: d.note ?? `未在本机找到可执行的 ${spec.binaryName} 命令，请先安装后再试。`,
      };
    }
    if (d.loggedIn === 'no') {
      return {
        ok: false,
        message: d.note ?? `${spec.name} 当前尚未登录，请先在本机终端完成登录后再试。`,
      };
    }
    const now = new Date().toISOString();
    const entry: StoredSubscriptionEntry = {
      enabled: true,
      ...(model ? { model } : {}),
      riskAcknowledgedAt: now,
      acknowledgedRiskVersion: spec.riskVersion,
      lastVerifiedAt: now,
    };
    await this.app.update(
      RECORD_ID,
      { items: {} },
      (cur) => {
        const items = (cur.items && typeof cur.items === 'object' && !Array.isArray(cur.items) ? cur.items : {}) as Record<string, unknown>;
        return { items: { ...items, [spec.id]: entry } };
      },
      'subscription-cli-enable',
    );
    const all = await this.listViews(async (id) => (id === spec.id ? d : { installed: false, loggedIn: 'unknown' }));
    const item = all.find((x) => x.id === spec.id)!;
    return {
      ok: true,
      item,
      message: `${spec.name} 已通过连接检测并开启（风险已确认；可选用为执行者）。`,
    };
  }

  async disable(
    cliId: string,
    onDisabled?: (cliId: SubscriptionCliId) => Promise<void> | void,
  ): Promise<void> {
    if (!isSubscriptionCliId(cliId)) throw new Error('未识别的本地订阅 CLI 选项。');
    await this.app.update(
      RECORD_ID,
      { items: {} },
      (cur) => {
        const items = {
          ...((cur.items && typeof cur.items === 'object' && !Array.isArray(cur.items) ? cur.items : {}) as Record<string, unknown>),
        };
        delete items[cliId];
        return { items };
      },
      'subscription-cli-disable',
    );
    if (onDisabled) await onDisabled(cliId);
  }
}

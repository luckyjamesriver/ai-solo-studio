import { updateRecord, type OpenOptions } from '../persistence/index.js';
import { APP_COLLECTION, AppStore } from './app-store.js';

/**
 * 首次外发告知（需求 v1.5 §3.5）：本应用会把项目资料发给哪些 AI 服务、何时发送、不会发送什么。
 * 本轮只做告知与记录；“发送清单确认”本身属于 B2。
 */
export const DISCLOSURE_VERSION = 1;

export interface DisclosureService {
  /** 服务名（给人看） */
  name: string;
  /** 用在哪里 */
  role: string;
}

export interface DisclosureContent {
  version: number;
  services: DisclosureService[];
  when: string[];
  never: string[];
}

export interface DisclosureInput {
  /** 本机已安装的执行体 */
  codexInstalled: boolean;
  /** 用户已在设置中配置可用的 Anthropic API Key */
  claudeApiConfigured?: boolean;
  /** 开发者自用的 Claude 思考者是否可用（打包版永远为 false） */
  devPersonalClaude: boolean;
  /** 用户已在设置中连接测试通过的其它 AI API 服务 */
  apiServices?: DisclosureService[];
}

/** 按“当前可用的执行体与思考者”列出服务名。 */
export function buildDisclosure(input: DisclosureInput): DisclosureContent {
  const services: DisclosureService[] = [];
  if (input.codexInstalled) services.push({ name: 'OpenAI（Codex）', role: '动手修改你的项目（施工），也可担任方案评审者' });
  if (input.claudeApiConfigured) services.push({ name: 'Anthropic', role: '在讨论阶段担任思考者（拆解需求、起草或评审方案）' });
  if (input.devPersonalClaude) services.push({ name: 'Anthropic（Claude，开发者自用模式）', role: '起草和整理方案（规划）' });
  for (const s of input.apiServices ?? []) {
    if (!services.some((x) => x.name === s.name && x.role === s.role)) {
      services.push(s);
    }
  }
  return {
    version: DISCLOSURE_VERSION,
    services,
    when: ['在“规划”和“施工”时才会发送；', '每次发送前，应用会先列出清单（发给谁、发哪些内容），由你确认后才发出。'],
    never: ['你的登录凭证与密码（应用不读取、不转发）；', '你没有选中的文件；', '项目以外的电脑文件。'],
  };
}

export interface DisclosureRecord {
  version: number;
  acceptedAt: string;
  /** 用户确认时看到的服务名 */
  services: string[];
}

const ID = 'disclosure';

export class DisclosureStore {
  private readonly app: AppStore;
  constructor(dir: string, storeOpts: OpenOptions = {}) {
    this.app = new AppStore(dir, storeOpts);
  }

  async get(): Promise<DisclosureRecord | null> {
    const r = (await this.app.read(ID)) as Partial<DisclosureRecord> | null;
    if (!r || r.version !== DISCLOSURE_VERSION || typeof r.acceptedAt !== 'string') return null;
    return { version: r.version, acceptedAt: r.acceptedAt, services: Array.isArray(r.services) ? r.services.map(String) : [] };
  }

  async accept(content: DisclosureContent, now: Date = new Date()): Promise<DisclosureRecord> {
    const rec: DisclosureRecord = { version: DISCLOSURE_VERSION, acceptedAt: now.toISOString(), services: content.services.map((s) => s.name) };
    await updateRecord(await this.app.store(), APP_COLLECTION, ID, {}, () => ({ ...rec }));
    return rec;
  }

  /** 涉及外发的入口必须先通过它：未确认则抛错。 */
  async requireAccepted(): Promise<void> {
    if (!(await this.get())) throw new Error('你还没有确认外发说明，涉及发送资料的功能暂不可用。');
  }
}

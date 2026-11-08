import fs from 'node:fs/promises';
import path from 'node:path';

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
  /** 开发者自用的 Claude 思考者是否可用（打包版永远为 false） */
  devPersonalClaude: boolean;
}

/** 按“当前可用的执行体与思考者”列出服务名。 */
export function buildDisclosure(input: DisclosureInput): DisclosureContent {
  const services: DisclosureService[] = [];
  if (input.codexInstalled) services.push({ name: 'OpenAI（Codex）', role: '动手修改你的项目（施工），也可担任方案评审者' });
  if (input.devPersonalClaude) services.push({ name: 'Anthropic（Claude，开发者自用模式）', role: '起草和整理方案（规划）' });
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

const FILE = 'disclosure.json';

export class DisclosureStore {
  constructor(private readonly dir: string) {}

  private get file() {
    return path.join(this.dir, FILE);
  }

  async get(): Promise<DisclosureRecord | null> {
    try {
      const r = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<DisclosureRecord>;
      if (r.version !== DISCLOSURE_VERSION || typeof r.acceptedAt !== 'string') return null;
      return { version: r.version, acceptedAt: r.acceptedAt, services: Array.isArray(r.services) ? r.services.map(String) : [] };
    } catch {
      return null;
    }
  }

  async accept(content: DisclosureContent, now: Date = new Date()): Promise<DisclosureRecord> {
    const rec: DisclosureRecord = { version: DISCLOSURE_VERSION, acceptedAt: now.toISOString(), services: content.services.map((s) => s.name) };
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
    return rec;
  }

  /** 涉及外发的入口必须先通过它：未确认则抛错。 */
  async requireAccepted(): Promise<void> {
    if (!(await this.get())) throw new Error('你还没有确认外发说明，涉及发送资料的功能暂不可用。');
  }
}

/**
 * 常用 AI API 服务商内置目录（Stage 8A · ADR 0010）。
 * 底层全部收敛为 3 种协议：OpenAI Compatible / Anthropic Messages / Google Gemini v1beta。
 */

export type ApiProtocol = 'openai_compat' | 'anthropic' | 'gemini';

export type BuiltinApiProviderId =
  | 'deepseek'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'qwen'
  | 'zhipu'
  | 'moonshot'
  | 'minimax'
  | 'xai'
  | 'openrouter'
  | 'ollama'
  | 'custom_openai';

export type ProviderGroup = 'cn' | 'global' | 'aggregator' | 'local';

export interface ApiProviderPreset {
  readonly id: BuiltinApiProviderId;
  readonly name: string;
  readonly group: ProviderGroup;
  readonly protocol: ApiProtocol;
  readonly defaultEndpoint: string;
  readonly regionOptions?: readonly { readonly label: string; readonly endpoint: string }[];
  readonly officialHosts: readonly string[];
  readonly suggestedModels: readonly string[];
  readonly requiresKey: boolean;
  readonly keyPlaceholder: string;
  readonly supportsModelListing: boolean;
  readonly note: string;
}

export const API_PROVIDER_CATALOG: readonly ApiProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    group: 'cn',
    protocol: 'openai_compat',
    defaultEndpoint: 'https://api.deepseek.com',
    officialHosts: ['api.deepseek.com'],
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
    requiresKey: true,
    keyPlaceholder: 'sk-...',
    supportsModelListing: true,
    note: '国内直连低成本首选；deepseek-chat / deepseek-reasoner 原生兼容 OpenAI 接口。',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    group: 'global',
    protocol: 'openai_compat',
    defaultEndpoint: 'https://api.openai.com/v1',
    officialHosts: ['api.openai.com'],
    suggestedModels: ['gpt-5', 'gpt-5-mini', 'gpt-5.5'],
    requiresKey: true,
    keyPlaceholder: 'sk-...',
    supportsModelListing: true,
    note: '使用个人 OpenAI API Key 按量计费（与 ChatGPT 订阅分开）。',
  },
  {
    id: 'anthropic',
    name: 'Anthropic（Claude API）',
    group: 'global',
    protocol: 'anthropic',
    defaultEndpoint: 'https://api.anthropic.com/v1/messages',
    officialHosts: ['api.anthropic.com'],
    suggestedModels: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    requiresKey: true,
    keyPlaceholder: 'sk-ant-...',
    supportsModelListing: true,
    note: 'Anthropic 官方合规接入途径；可担任执行者，也可用于讨论思考。',
  },
  {
    id: 'gemini',
    name: 'Google Gemini API',
    group: 'global',
    protocol: 'gemini',
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta',
    officialHosts: ['generativelanguage.googleapis.com'],
    suggestedModels: ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-pro', 'gemini-4-argon'],
    requiresKey: true,
    keyPlaceholder: 'AIza...',
    supportsModelListing: true,
    note: '替代 Antigravity 消费级订阅的标准合规 API 接入方式（使用 x-goog-api-key）。',
  },
  {
    id: 'qwen',
    name: '阿里百炼（Qwen）',
    group: 'cn',
    protocol: 'openai_compat',
    defaultEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    regionOptions: [
      { label: '中国内地（dashscope.aliyuncs.com）', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { label: '国际（dashscope-intl.aliyuncs.com）', endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
    ],
    officialHosts: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'],
    suggestedModels: ['qwen3-coder-plus', 'qwen3-coder-flash'],
    requiresKey: true,
    keyPlaceholder: 'sk-...',
    supportsModelListing: true,
    note: '兼容百炼 OpenAI 兼容模式，也可手动填入任意通义千问模型 ID。',
  },
  {
    id: 'zhipu',
    name: '智谱（GLM）',
    group: 'cn',
    protocol: 'openai_compat',
    defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4',
    regionOptions: [
      { label: '通用 PaaS（open.bigmodel.cn）', endpoint: 'https://open.bigmodel.cn/api/paas/v4' },
      { label: 'Coding 专用端（open.bigmodel.cn/api/coding）', endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4' },
      { label: '国际（api.z.ai）', endpoint: 'https://api.z.ai/api/paas/v4' },
    ],
    officialHosts: ['open.bigmodel.cn', 'api.z.ai'],
    suggestedModels: ['glm-4.5', 'glm-4.5-air'],
    requiresKey: true,
    keyPlaceholder: '智谱 API Key',
    supportsModelListing: false,
    note: '支持通用 PaaS 与 Coding 套餐端切换，可手填对应模型名。',
  },
  {
    id: 'moonshot',
    name: '月之暗面（Kimi）',
    group: 'cn',
    protocol: 'openai_compat',
    defaultEndpoint: 'https://api.moonshot.cn/v1',
    regionOptions: [
      { label: '中国内地（api.moonshot.cn）', endpoint: 'https://api.moonshot.cn/v1' },
      { label: '国际（api.moonshot.ai）', endpoint: 'https://api.moonshot.ai/v1' },
    ],
    officialHosts: ['api.moonshot.cn', 'api.moonshot.ai'],
    suggestedModels: ['kimi-k3', 'kimi-k3.1-pro'],
    requiresKey: true,
    keyPlaceholder: 'sk-...',
    supportsModelListing: true,
    note: '支持长上下文编码；按需选择国内或国际端口。',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    group: 'cn',
    protocol: 'openai_compat',
    defaultEndpoint: 'https://api.minimaxi.com/v1',
    regionOptions: [
      { label: '中国内地（api.minimaxi.com）', endpoint: 'https://api.minimaxi.com/v1' },
      { label: '国际（api.minimax.io）', endpoint: 'https://api.minimax.io/v1' },
    ],
    officialHosts: ['api.minimaxi.com', 'api.minimax.io'],
    suggestedModels: ['MiniMax-M3.1-Flash'],
    requiresKey: true,
    keyPlaceholder: 'MiniMax API Key',
    supportsModelListing: false,
    note: '国内与国际账号域名独立，请核对所用账号对应接口地址。',
  },
  {
    id: 'xai',
    name: 'xAI（Grok）',
    group: 'global',
    protocol: 'openai_compat',
    defaultEndpoint: 'https://api.x.ai/v1',
    officialHosts: ['api.x.ai'],
    suggestedModels: ['grok-code-fast-1', 'grok-4'],
    requiresKey: true,
    keyPlaceholder: 'xai-...',
    supportsModelListing: true,
    note: '支持拉取账号可用模型列表或手填模型 ID。',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter（聚合）',
    group: 'aggregator',
    protocol: 'openai_compat',
    defaultEndpoint: 'https://openrouter.ai/api/v1',
    officialHosts: ['openrouter.ai'],
    suggestedModels: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5-mini', 'deepseek/deepseek-chat'],
    requiresKey: true,
    keyPlaceholder: 'sk-or-...',
    supportsModelListing: true,
    note: '单一 Key 接入上百家主流模型，适合作为备用聚合出口。',
  },
  {
    id: 'ollama',
    name: '本地模型（Ollama / LM Studio）',
    group: 'local',
    protocol: 'openai_compat',
    defaultEndpoint: 'http://localhost:11434/v1',
    regionOptions: [
      { label: 'Ollama 默认（localhost:11434）', endpoint: 'http://localhost:11434/v1' },
      { label: 'LM Studio 默认（localhost:1234）', endpoint: 'http://localhost:1234/v1' },
    ],
    officialHosts: ['localhost', '127.0.0.1', '[::1]'],
    suggestedModels: ['qwen2.5-coder:32b', 'deepseek-r1:14b'],
    requiresKey: false,
    keyPlaceholder: '本地服务可留空',
    supportsModelListing: true,
    note: '纯本地运行（无需联网和真实 Key）；需选择支持工具调用（Tool Calling）的本地模型才可当执行者。',
  },
  {
    id: 'custom_openai',
    name: '自定义 OpenAI 兼容服务',
    group: 'local',
    protocol: 'openai_compat',
    defaultEndpoint: '',
    officialHosts: [],
    suggestedModels: [],
    requiresKey: true,
    keyPlaceholder: '服务商 Key（若无要求可留空后取消必选）',
    supportsModelListing: true,
    note: '可填企业网关、OneAPI/LiteLLM、火山方舟、硅基流动等 OpenAI 兼容端点；资料会发往所填自定义地址。',
  },
];

export function findProviderPreset(id: string): ApiProviderPreset | undefined {
  return API_PROVIDER_CATALOG.find((p) => p.id === id);
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/** 校验并规范化 API 接口地址：远程要求 HTTPS，仅本机回环允许 HTTP。 */
export function normalizeApiEndpoint(raw: string): { ok: true; endpoint: string; origin: string; isLocal: boolean } | { ok: false; reason: string } {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return { ok: false, reason: '请填写 API 接口地址。' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: '接口地址格式无效，请填写完整的 http(s):// 地址。' };
  }
  const isLocal = isLoopbackHostname(parsed.hostname);
  if (parsed.protocol === 'https:') {
    return { ok: true, endpoint: trimmed, origin: parsed.origin, isLocal };
  }
  if (parsed.protocol === 'http:' && isLocal) {
    return { ok: true, endpoint: trimmed, origin: parsed.origin, isLocal: true };
  }
  if (parsed.protocol === 'http:') {
    return { ok: false, reason: '远程 API 地址必须使用 HTTPS 加密连接（仅本机回环地址允许 HTTP）。' };
  }
  return { ok: false, reason: `不支持的协议类型：${parsed.protocol}` };
}

export function isOfficialEndpointForPreset(presetId: BuiltinApiProviderId, endpoint: string): boolean {
  const preset = findProviderPreset(presetId);
  if (!preset || preset.officialHosts.length === 0) return false;
  try {
    const parsed = new URL(endpoint);
    return preset.officialHosts.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

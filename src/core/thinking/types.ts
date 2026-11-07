/**
 * 思考者（Thinker）：只“想”不“做”。需求 v1.5 第 3 节。
 * 思考者没有任何工具权限——不能读写文件、运行命令、联网搜索；所需资料全部由宿主放进请求。
 */
export type ThinkerRole = 'planner' | 'reviewer';

/** 一份资料：名称（文件名或标题）+ 文本。发送清单只记录名称与字节数。 */
export interface ContextItem {
  name: string;
  text: string;
}

/** 分层上下文（v1.5 第 3.5 节）：必带层每次都带；按需层只放当前任务相关的资料。第三层“历史讨论”需要时由宿主以引用方式放入按需层。 */
export interface ThinkContext {
  required: ContextItem[];
  optional?: ContextItem[];
}

/** 要求的输出结构：一个最小的 JSON Schema 子集（object / string / number / boolean / array / enum）。 */
export interface OutputSchema {
  type: 'object';
  properties: Record<string, SchemaNode>;
  required: string[];
}
export type SchemaNode =
  | { type: 'string'; enum?: string[]; description?: string }
  | { type: 'number' | 'boolean'; description?: string }
  | { type: 'array'; items: SchemaNode; description?: string }
  | { type: 'object'; properties: Record<string, SchemaNode>; required: string[]; description?: string };

export interface ThinkRequest {
  role: ThinkerRole;
  /** 系统说明：角色职责（例如评审者的职责是找错而不是求共识） */
  system: string;
  context: ThinkContext;
  /** 本次要回答的问题 */
  task: string;
  output: OutputSchema;
  timeoutMs?: number;
}

export type ThinkStatus = 'complete' | 'incomplete' | 'failed' | 'rate_limited' | 'quota_exhausted' | 'auth_error' | 'timeout';

export interface SentItem {
  name: string;
  bytes: number;
  layer: 'system' | 'required' | 'optional' | 'task';
}

export interface ThinkUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface ThinkResult {
  status: ThinkStatus;
  /** 结构化内容：只有 status==='complete' 才有；解析或校验失败即为 incomplete，不得当作正式产物 */
  content?: Record<string, unknown>;
  rawText: string;
  usage?: ThinkUsage;
  /** 实际使用的模型（服务报告的） */
  model?: string;
  /** 发送资料清单：文件名与字节数 */
  sent: SentItem[];
  /** 发往的服务名称 */
  service: string;
  /** 失败/不完整时的原因（给人看，不含密钥） */
  error?: string;
  /** 调用后核验到的隔离证据（如实际可用的工具数量），供界面/日志记录 */
  isolationEvidence?: string;
  /** 思考者不该请求工具；若请求了，这里记录（一律被拒绝） */
  refusedToolRequests?: string[];
}

export interface ThinkerDetect {
  available: boolean;
  /** 不可用时的原因，或可用时需要提示的限制 */
  note?: string;
  /** 无法确认的隔离项（写入 ADR 0001“已知限制”并在此提示） */
  unconfirmed?: string[];
}

export interface Thinker {
  readonly id: string;
  readonly displayName: string;
  /** 数据会发往的服务名称（首次使用须告知用户，v1.5 第 3.5 节） */
  readonly service: string;
  detect(): Promise<ThinkerDetect>;
  think(request: ThinkRequest): Promise<ThinkResult>;
}

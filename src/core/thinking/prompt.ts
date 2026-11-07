import type { OutputSchema, SchemaNode, SentItem, ThinkRequest } from './types.js';

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** 构造发给思考者的完整提示词，并同时给出发送资料清单（名称+字节数）。 */
export function buildThinkPrompt(req: ThinkRequest): { prompt: string; sent: SentItem[] } {
  const sent: SentItem[] = [];
  const parts: string[] = [];
  const add = (layer: SentItem['layer'], name: string, text: string) => sent.push({ name, bytes: bytes(text), layer });

  const system = [
    req.system,
    '',
    '硬性规则：你没有任何工具。不要读写文件、不要运行命令、不要联网搜索，也不要请求这些能力。只能依据下面提供的资料回答；资料不够时，在输出里列出你还需要哪些证据，不要自己编造事实。',
  ].join('\n');
  add('system', 'system', system);
  parts.push(system);

  const section = (layer: 'required' | 'optional', title: string, items: { name: string; text: string }[]) => {
    if (!items.length) return;
    parts.push(`\n## ${title}`);
    for (const it of items) {
      add(layer, it.name, it.text);
      parts.push(`\n### 资料：${it.name}\n${it.text}`);
    }
  };
  section('required', '必带资料（项目目标与不变约束）', req.context.required);
  section('optional', '按需资料（与当前任务相关）', req.context.optional ?? []);

  add('task', 'task', req.task);
  parts.push(`\n## 本次任务\n${req.task}`);

  const format = [
    '\n## 输出格式',
    '只输出一个 JSON 对象，符合下面的 JSON Schema；不要输出任何其他文字，也不要使用代码围栏以外的说明。',
    JSON.stringify(req.output, null, 2),
  ].join('\n');
  add('system', 'output-schema', format);
  parts.push(format);

  return { prompt: parts.join('\n'), sent };
}

function validateNode(node: SchemaNode, v: unknown, path: string, errs: string[]): void {
  switch (node.type) {
    case 'string':
      if (typeof v !== 'string') errs.push(`${path} 应为字符串`);
      else if (node.enum && !node.enum.includes(v)) errs.push(`${path} 取值不在允许范围内`);
      return;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(`${path} 应为数字`);
      return;
    case 'boolean':
      if (typeof v !== 'boolean') errs.push(`${path} 应为布尔值`);
      return;
    case 'array':
      if (!Array.isArray(v)) errs.push(`${path} 应为数组`);
      else v.forEach((x, i) => validateNode(node.items, x, `${path}[${i}]`, errs));
      return;
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        errs.push(`${path} 应为对象`);
        return;
      }
      const o = v as Record<string, unknown>;
      for (const k of node.required) if (!(k in o)) errs.push(`${path}.${k} 缺失`);
      for (const [k, child] of Object.entries(node.properties)) if (k in o) validateNode(child, o[k], `${path}.${k}`, errs);
    }
  }
}

/** 从原始文本里取出第一个完整的 JSON 对象（允许被 ``` 围栏或少量前后文字包裹）。 */
export function extractJsonObject(text: string): unknown | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1]!, text] : [text];
  for (const c of candidates) {
    for (let start = c.indexOf('{'); start >= 0; start = c.indexOf('{', start + 1)) {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < c.length; i++) {
        const ch = c[i]!;
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
          try {
            return JSON.parse(c.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

/** 解析并校验结构化输出。失败 → ok:false（调用方应标为 incomplete，不得当作正式产物）。 */
export function parseStructured(text: string, schema: OutputSchema): { ok: true; content: Record<string, unknown> } | { ok: false; error: string } {
  const obj = extractJsonObject(text);
  if (obj === undefined) return { ok: false, error: '回复中没有可解析的 JSON 对象' };
  const errs: string[] = [];
  validateNode(schema as SchemaNode, obj, '$', errs);
  if (errs.length) return { ok: false, error: `结构不符合要求：${errs.slice(0, 5).join('；')}` };
  return { ok: true, content: obj as Record<string, unknown> };
}

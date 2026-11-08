import fs from 'node:fs/promises';
import path from 'node:path';

/** compatible / incompatible：能判断；undeclared：项目没有声明；unknown：有声明但本应用无法判断（不得显示为通过）。 */
export type NodeCompat =
  | { status: 'compatible' | 'incompatible'; declared: string; source: '.nvmrc' | 'package.json' }
  | { status: 'undeclared' }
  | { status: 'unknown'; declared: string; source: '.nvmrc' | 'package.json' };

export function parseVersion(v: string): [number, number, number] | null {
  const m = v.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i);
  if (!m) return null;
  const n = (s: string | undefined) => (s === undefined || /^[x*]$/i.test(s) ? NaN : Number(s));
  return [Number(m[1]), n(m[2]), n(m[3])] as [number, number, number];
}

/** .nvmrc：返回要求的主版本；lts/*、node、stable 等无法确定的写法返回 null。 */
export function nvmrcMajor(content: string): number | null {
  const line = content.split('\n').map((l) => l.replace(/#.*/, '').trim()).find(Boolean);
  if (!line) return null;
  const p = parseVersion(line);
  return p ? p[0] : null;
}

type Cmp = { op: '>=' | '>' | '<=' | '<' | '='; v: [number, number, number] };

const full = (p: [number, number, number]): [number, number, number] => [p[0], Number.isNaN(p[1]) ? 0 : p[1], Number.isNaN(p[2]) ? 0 : p[2]];
function cmp3(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

/** 把一个比较集合（空格分隔）展开为比较器；遇到看不懂的写法返回 null。 */
function parseSet(set: string): Cmp[] | null {
  const out: Cmp[] = [];
  const toks = set.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  for (const t of toks) {
    const m = t.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/);
    if (!m) return null;
    const op = m[1] ?? '';
    const p = parseVersion(m[2]!);
    if (!p) return null;
    const lo = full(p);
    if (op === '' || op === '=') {
      if (Number.isNaN(p[1])) out.push({ op: '>=', v: lo }, { op: '<', v: [p[0] + 1, 0, 0] });
      else if (Number.isNaN(p[2])) out.push({ op: '>=', v: lo }, { op: '<', v: [p[0], p[1] + 1, 0] });
      else out.push({ op: '=', v: lo });
    } else if (op === '^') {
      out.push({ op: '>=', v: lo });
      out.push({ op: '<', v: p[0] > 0 ? [p[0] + 1, 0, 0] : Number.isNaN(p[1]) ? [1, 0, 0] : [0, p[1] + 1, 0] });
    } else if (op === '~') {
      out.push({ op: '>=', v: lo });
      out.push({ op: '<', v: Number.isNaN(p[1]) ? [p[0] + 1, 0, 0] : [p[0], p[1] + 1, 0] });
    } else {
      out.push({ op: op as Cmp['op'], v: lo });
    }
  }
  return out;
}

/** 判断版本是否满足 engines.node 范围。看不懂的写法返回 null（未知）。 */
export function satisfiesRange(version: string, range: string): boolean | null {
  const cur = parseVersion(version);
  if (!cur) return null;
  const c = full(cur);
  const r = range.trim();
  if (!r || r === '*' || r === 'x') return true;
  let known = false;
  for (const set of r.split('||')) {
    const cs = parseSet(set);
    if (!cs) return null;
    known = true;
    const ok = cs.every((k) => {
      const d = cmp3(c, k.v);
      return k.op === '>=' ? d >= 0 : k.op === '>' ? d > 0 : k.op === '<=' ? d <= 0 : k.op === '<' ? d < 0 : d === 0;
    });
    if (ok) return true;
  }
  return known ? false : null;
}

const readText = async (p: string): Promise<string | null> => {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
};

/** 命令环境的 Node 版本（如 v22.23.4）是否与项目声明一致。只读项目里的 .nvmrc 与 package.json。 */
export async function checkNodeCompat(nodeVersion: string, projectDir: string): Promise<NodeCompat> {
  const cur = parseVersion(nodeVersion);
  let unknown: NodeCompat | null = null;

  const nvm = await readText(path.join(projectDir, '.nvmrc'));
  if (nvm !== null && nvm.trim()) {
    const declared = nvm.split('\n').map((l) => l.replace(/#.*/, '').trim()).find(Boolean) ?? '';
    const major = nvmrcMajor(nvm);
    if (major !== null && cur) return { status: cur[0] === major ? 'compatible' : 'incompatible', declared, source: '.nvmrc' };
    unknown = { status: 'unknown', declared, source: '.nvmrc' };
  }
  const pkg = await readText(path.join(projectDir, 'package.json'));
  if (pkg) {
    try {
      const engines = (JSON.parse(pkg) as { engines?: { node?: unknown } }).engines?.node;
      if (typeof engines === 'string' && engines.trim()) {
        const ok = satisfiesRange(nodeVersion, engines);
        if (ok !== null) return { status: ok ? 'compatible' : 'incompatible', declared: engines, source: 'package.json' };
        unknown ??= { status: 'unknown', declared: engines, source: 'package.json' };
      }
    } catch {
      // package.json 损坏：当作没有声明，不报错
    }
  }
  return unknown ?? { status: 'undeclared' };
}

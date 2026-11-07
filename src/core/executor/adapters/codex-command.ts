/**
 * 把 Codex 审批请求里的命令字符串整理成风险评估需要的形态。
 * Codex 给出的是 shell 包装后的字符串（例如 `/bin/zsh -lc "printf hi > ../x"`），
 * 这里只做尽力而为的解析：用户永远能看到原文，解析不出来的一律按“未知命令”处理（中风险、不可恢复，不会自动批准）。
 */

export interface ParsedCommand {
  /** 去掉 shell 包装后的命令原文 */
  inner: string;
  /** 用于风险评估的命令（多段命令时取最危险的一段，否则第一段） */
  argv: string[];
  /** 看起来指向工作区之外或无法判断位置的路径（绝对路径、~、$VAR、含 .. 的路径、重定向目标） */
  paths: string[];
  /** 含管道、重定向、&&、; 等 shell 结构 */
  complex: boolean;
}

const WRAPPER = /^(?:\S*\/)?(?:zsh|bash|sh)\s+-[a-z]*c\s+(["'])([\s\S]*)\1\s*$/;
const OPERATORS = /(&&|\|\||;|\||>>?|<|\$\(|`)/;
const DANGEROUS = new Set(['rm', 'sudo', 'chmod', 'chown', 'dd', 'mkfs', 'kill', 'killall', 'curl', 'wget', 'ssh', 'scp', 'rsync']);
const HARMLESS_DEVICES = new Set(['/dev/null']);

export function unwrapShell(command: string): string {
  const m = command.trim().match(WRAPPER);
  if (!m) return command.trim();
  const body = m[2] ?? '';
  return m[1] === '"' ? body.replace(/\\(["\\$`])/g, '$1') : body;
}

/** 极简分词：支持单双引号与反斜杠转义。不展开变量，不处理子 shell。 */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

function looksOutside(token: string): boolean {
  if (HARMLESS_DEVICES.has(token)) return false;
  return token.startsWith('/') || token.startsWith('~') || token.startsWith('$') || /(^|\/)\.\.(\/|$)/.test(token);
}

export function parseCommand(command: string): ParsedCommand {
  const inner = unwrapShell(command);
  const complex = OPERATORS.test(inner);
  // 按操作符切成若干段，每段单独分词；重定向目标单独收集
  const segments = inner.split(/&&|\|\||;|\|/).map((x) => x.trim()).filter(Boolean);
  const redirectTargets: string[] = [];
  const cleaned = segments.map((seg) => {
    const toks = tokenize(seg);
    const keep: string[] = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      const redir = t.match(/^(\d*)(>>?|<)(.*)$/);
      if (redir) {
        const target = redir[3] || toks[++i];
        if (target && !target.startsWith('&')) redirectTargets.push(target);
      } else keep.push(t);
    }
    return keep;
  });
  const base = (a: string[]) => (a[0] ?? '').split('/').pop() ?? '';
  const argv = cleaned.find((a) => DANGEROUS.has(base(a))) ?? cleaned[0] ?? [];
  const paths = [
    ...cleaned.flatMap((a) => a.slice(1).filter(looksOutside)),
    ...redirectTargets.filter(looksOutside),
  ];
  return { inner, argv, paths: [...new Set(paths)], complex };
}

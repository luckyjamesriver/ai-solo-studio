import { run } from '../proc/run.js';
import type { DetectResult } from '../executor/types.js';
import { checkNodeCompat } from './node-compat.js';
import { withSupplementalPath } from './host-env.js';
import type { HostPathResolution, ToolLocation } from './path.js';

/**
 * 分层环境体检（R10）。每个检查项给出五层状态：
 * 已安装 / 能启动 / 版本兼容 / 已登录 / 安全配置已核验。
 * pass 通过；fail 不通过；na 不适用；unknown 无法判断——unknown 永远不会显示为通过。
 * 只读：不安装、不修改任何用户环境，不读取凭证文件。
 */
export type LayerState = 'pass' | 'fail' | 'unknown' | 'na';
export interface Layer {
  state: LayerState;
  /** 一句大白话说明（可空） */
  note?: string;
}
export const LAYER_KEYS = ['installed', 'starts', 'compatible', 'loggedIn', 'secured'] as const;
export type LayerKey = (typeof LAYER_KEYS)[number];
export type Layers = Record<LayerKey, Layer>;

export interface HealthItem {
  id: 'git' | 'node' | 'npm' | 'codex';
  label: string;
  layers: Layers;
  /** 汇总：任一层 fail → fail；否则任一层 unknown → unknown；否则 pass（na 不计） */
  overall: 'pass' | 'fail' | 'unknown';
  /** 工具位置与发现方式（path = 当前 PATH 中找到；fallback = 通过补全路径找到） */
  foundVia: 'path' | 'fallback' | null;
  location?: string;
  version?: string;
  /** 不通过或未知时的一句“怎么办” */
  advice?: string;
  help?: string;
}

export interface HealthReport {
  items: HealthItem[];
  /** 与所选执行体相关、且无法关闭的已知限制（一句大白话一条） */
  limitations: string[];
  /** 用于排查：宿主看到的 PATH 与补全的目录 */
  pathInfo: { processPath: string; supplementalDirs: string[] };
  project: { name: string } | null;
}

export interface CodexProbe {
  detect(): Promise<DetectResult>;
  preflight(): Promise<{ problems: string[] }>;
}

export interface HealthOptions {
  /** 已解析的工具位置（含补全路径信息） */
  tools: HostPathResolution;
  processPath: string;
  /** 当前打开项目的真实路径；没有则为 null */
  projectDir: string | null;
  /** 所选执行体 */
  executor: 'codex';
  /** Codex 探测器；注入便于测试。null = 未找到 codex 命令 */
  codex: CodexProbe | null;
  /** 已验证的 Codex 版本（来自适配器，不在这里写死） */
  verifiedCodexVersion: string;
}

const L = (state: LayerState, note?: string): Layer => (note ? { state, note } : { state });
const NA = (): Layer => L('na');
const UNK = (note?: string): Layer => L('unknown', note);

function overallOf(layers: Layers): HealthItem['overall'] {
  const s = LAYER_KEYS.map((k) => layers[k].state);
  return s.includes('fail') ? 'fail' : s.includes('unknown') ? 'unknown' : 'pass';
}

async function versionOf(tool: ToolLocation, env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await run(tool.path, ['--version'], { cwd: process.cwd(), env, timeoutMs: 10_000, killGraceMs: 500 });
  if (r.outcome.kind === 'exited' && r.outcome.code === 0) return (r.stdout || r.stderr).trim().split('\n')[0] ?? '';
  return null;
}

function make(id: HealthItem['id'], label: string, tool: ToolLocation | null, layers: Layers, extra: Partial<HealthItem> = {}): HealthItem {
  return { id, label, layers, overall: overallOf(layers), foundVia: tool?.via ?? null, ...(tool ? { location: tool.path } : {}), ...extra };
}

export async function runHealthCheck(o: HealthOptions): Promise<HealthReport> {
  const env = withSupplementalPath(process.env, o.tools.supplementalDirs);
  const t = o.tools.tools;

  const simple = async (id: 'git' | 'npm', label: string, help: string, missing: string, broken: string): Promise<HealthItem> => {
    const tool = t[id] ?? null;
    if (!tool) {
      return make(id, label, null, { installed: L('fail', '没有找到'), starts: UNK('没有安装，无法判断'), compatible: NA(), loggedIn: NA(), secured: NA() }, { advice: missing, help });
    }
    const v = await versionOf(tool, env);
    if (!v) return make(id, label, tool, { installed: L('pass'), starts: L('fail', '无法运行'), compatible: NA(), loggedIn: NA(), secured: NA() }, { advice: broken, help });
    return make(id, label, tool, { installed: L('pass'), starts: L('pass'), compatible: NA(), loggedIn: NA(), secured: NA() }, { version: v });
  };

  const gitP = simple('git', 'Git', 'https://git-scm.com/downloads', '请安装 Git（用来保存你的每个版本，必须安装）。', 'Git 已找到但无法运行，请重新安装 Git。');
  const npmP = simple('npm', 'npm', 'https://nodejs.org/', '请安装 Node.js（npm 随它一起安装），网页项目的构建和测试需要它。', 'npm 已找到但无法运行，请重新安装 Node.js。');

  const nodeP = (async (): Promise<HealthItem> => {
    const tool = t.node ?? null;
    if (!tool) {
      return make('node', 'Node.js', null, { installed: L('fail', '没有找到'), starts: UNK('没有安装，无法判断'), compatible: UNK('没有安装，无法判断'), loggedIn: NA(), secured: NA() }, { advice: '请安装 Node.js（网页项目的预览、构建和测试需要它）。', help: 'https://nodejs.org/' });
    }
    const v = await versionOf(tool, env);
    if (!v) {
      return make('node', 'Node.js', tool, { installed: L('pass'), starts: L('fail', '无法运行'), compatible: UNK('无法运行，无法判断'), loggedIn: NA(), secured: NA() }, { advice: 'Node.js 已找到但无法运行，请重新安装。', help: 'https://nodejs.org/' });
    }
    let compatible: Layer;
    let advice: string | undefined;
    if (!o.projectDir) compatible = UNK('打开项目后才能判断');
    else {
      const c = await checkNodeCompat(v, o.projectDir);
      if (c.status === 'undeclared') compatible = NA_NOTE('项目未声明');
      else if (c.status === 'unknown') {
        compatible = UNK(`项目声明了「${c.declared}」（${c.source}），本应用无法判断是否一致`);
        advice = `请自行确认你的 Node 版本（${v}）符合项目声明「${c.declared}」。`;
      } else if (c.status === 'compatible') compatible = L('pass', `项目要求 ${c.declared}`);
      else {
        compatible = L('fail', `项目要求 ${c.declared}，你的是 ${v}`);
        const major = c.declared.match(/\d+/)?.[0];
        advice = major ? `请安装 Node ${major}，项目要求这个版本（本应用不会替你修改电脑环境）。` : `项目要求 Node「${c.declared}」，请安装对应版本。`;
      }
    }
    return make('node', 'Node.js', tool, { installed: L('pass'), starts: L('pass'), compatible, loggedIn: NA(), secured: NA() }, { version: v, ...(advice ? { advice } : {}) });
  })();

  const codexP = (async (): Promise<HealthItem> => {
    const tool = t.codex ?? null;
    const help = 'https://developers.openai.com/codex/cli';
    if (!tool || !o.codex) {
      return make('codex', 'Codex', null, { installed: L('fail', '没有找到'), starts: UNK('没有安装，无法判断'), compatible: UNK('没有安装，无法判断'), loggedIn: UNK('没有安装，无法判断'), secured: UNK('没有安装，无法判断') }, { advice: '请安装 Codex（负责动手写代码的 AI 工具），安装后重新检查。', help });
    }
    const d = await o.codex.detect();
    if (!d.installed) {
      return make('codex', 'Codex', tool, { installed: L('pass'), starts: L('fail', '无法运行'), compatible: UNK('无法运行，无法判断'), loggedIn: UNK('无法运行，无法判断'), secured: UNK('无法运行，无法判断') }, { advice: 'Codex 已找到但无法运行，请重新安装或更新。', help });
    }
    const compatible: Layer = d.verified === undefined ? UNK('无法读取版本号') : d.verified ? L('pass', `已验证的版本（${o.verifiedCodexVersion}）`) : UNK(`这个版本没有经过验证（已验证的是 ${o.verifiedCodexVersion}），可能不兼容`);
    const loggedIn: Layer = d.loggedIn === 'yes' ? L('pass') : d.loggedIn === 'no' ? L('fail', '还没有登录') : UNK('无法确认登录状态');
    let secured: Layer;
    try {
      const p = await o.codex.preflight();
      secured = p.problems.length ? L('fail', `启动前自检未通过：${p.problems.join('、')}`) : L('pass', '启动前自检通过（只读检查，没有启动任务）');
    } catch (e) {
      secured = UNK(`无法完成启动前自检：${(e as Error).message}`);
    }
    const advice: string[] = [];
    if (d.loggedIn === 'no') advice.push('请在 Codex 中登录你的账号后重新检查。');
    else if (d.loggedIn === 'unknown') advice.push('请确认 Codex 已登录。');
    if (compatible.state === 'unknown' && d.verified === false) advice.push(`建议使用已验证的 Codex 版本 ${o.verifiedCodexVersion}。`);
    if (secured.state === 'fail') advice.push('安全自检没有通过，在修复前不能开始任务。');
    else if (secured.state === 'unknown') advice.push('无法确认安全配置，开始任务前会再次自检。');
    return make('codex', 'Codex', tool, { installed: L('pass'), starts: L('pass'), compatible, loggedIn, secured }, { ...(d.version ? { version: d.version } : {}), ...(advice.length ? { advice: advice.join('') } : {}), help });
  })();

  const [git, node, npm, codex] = await Promise.all([gitP, nodeP, npmP, codexP]);

  // 已知无法关闭的限制：仅当所选执行体是 Codex 且已安装时显示
  const limitations: string[] = [];
  if (o.executor === 'codex' && codex.layers.installed.state === 'pass' && o.codex) {
    try {
      limitations.push(...((await o.codex.detect()).isolationNotes ?? []));
    } catch {
      // 忽略：限制说明拿不到不影响体检
    }
  }
  return {
    items: [git, node, npm, codex],
    limitations,
    pathInfo: { processPath: o.processPath, supplementalDirs: [...o.tools.supplementalDirs] },
    project: null,
  };
}

function NA_NOTE(note: string): Layer {
  return { state: 'na', note };
}

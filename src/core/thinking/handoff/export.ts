import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../../git/git.js';
import { atomicWrite, atomicWriteExclusive, sha256 } from '../flow/store.js';

/** 任务清单（.studio/tasks/<任务编号>.json，宿主生成；已存在则拒绝覆盖）。 */
export interface TaskManifest {
  schema: 1;
  taskId: string;
  threadId: string;
  repoRoot: string;
  branch: string;
  worktreePath: string;
  startHead: string;
  plan: { path: string; sha256: string; artifactVersion: number };
  singleThinker: boolean;
  exportedAt: string;
  taskFile: { path: string; sha256: string };
}

export interface ExportInput {
  projectRoot: string;
  taskId: string;
  threadId: string;
  /** 导出目录：由参数或配置给出，代码中不写死任何路径 */
  exportDir: string;
  /** 只有用户明确选择“设为当前任务”才更新 next-task.md */
  setCurrent?: boolean;
  /** 更新 next-task.md 前，若它已存在：显示其首行编号并要求确认 */
  confirmReplaceCurrent?: (firstLine: string) => Promise<boolean>;
  plan: { path: string; text: string; sha256: string; artifactVersion: number };
  requirements: { id: string; text: string }[];
  single: boolean;
  now?: () => Date;
}

export interface ExportResult {
  taskFile: string;
  manifestFile: string;
  manifest: TaskManifest;
  currentUpdated: boolean;
  currentNote?: string;
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function gitBinding(projectRoot: string): Promise<{ repoRoot: string; worktreePath: string; branch: string; head: string }> {
  const top = (await git(projectRoot, ['rev-parse', '--show-toplevel'])).trim();
  const common = (await git(projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  const worktreePath = await fs.realpath(top);
  const repoRoot = await fs.realpath(path.basename(common) === '.git' ? path.dirname(common) : common);
  const branch = (await git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const head = (await git(projectRoot, ['rev-parse', 'HEAD'])).trim();
  return { repoRoot, worktreePath, branch, head };
}

/** 生成符合 docs/PROTOCOL.md 的任务文件正文（首行任务编号）。 */
export function renderTaskFile(i: { taskId: string; binding: { repoRoot: string; worktreePath: string; branch: string; head: string }; plan: ExportInput['plan']; requirements: ExportInput['requirements']; single: boolean; threadId: string }): string {
  return [
    `任务编号：${i.taskId}`,
    '',
    `# ${i.taskId}：按已批准方案实施`,
    '',
    i.single ? '> ⚠ **本方案未经独立评审**（单思考者模式）。请执行者在报告中特别说明对方案的任何疑问。\n' : '> 本方案经规划者起草、评审者独立评审、规划者修订，并由用户批准。\n',
    `来源线程：${i.threadId}；批准的方案：${i.plan.path}（版本 ${i.plan.artifactVersion}，sha256 ${i.plan.sha256}）。`,
    '',
    '工作目录与起点（执行者开工前请核对）：',
    `- 仓库根路径：${i.binding.repoRoot}`,
    `- 工作树路径：${i.binding.worktreePath}`,
    `- 分支：${i.binding.branch}`,
    `- 起始 Git HEAD：${i.binding.head}`,
    '',
    '请先完整阅读 docs/PROTOCOL.md 并遵守，然后执行本任务。',
    '',
    '## 1. 目标（需求条目，用户已确认并冻结）',
    ...i.requirements.map((r) => `- ${r.id}：${r.text}`),
    '',
    '## 2. 方案（已批准）',
    i.plan.text,
    '',
    '## 3. 约束',
    '- 只做上面列出的事；发现任务外的问题，记录进报告，不顺手修改。',
    '- 每项单独提交；未经用户确认不推送。',
    '- 遵守 docs/PROTOCOL.md 的通用约束（不读取或转发任何登录凭证；不使用跳过权限或关闭沙箱的参数；安全断言只能变严、不能放宽）。',
    '- 不自动开始下一个任务。',
    '',
    '## 4. 验证要求',
    '- 每完成一项就验证：typecheck、test、build、smoke（以项目实际脚本为准）；报告写出命令与结果数量。',
    '- 对每个需求条目（R1、R2…）说明满足与否及证据。',
    '',
    '## 5. 报告要求',
    '覆盖写入报告文件，**第一行写任务编号**（与本文件首行一致）。报告必须包含“绑定信息”区块，逐行使用下面的标签（导入时据此核对，缺失则只能只读查看）：',
    '```',
    `任务编号：${i.taskId}`,
    '仓库：<仓库根路径>',
    '分支：<分支名>',
    '工作树路径：<工作树路径>',
    '开始 HEAD：<开始时的 Git HEAD>',
    '结束 HEAD：<结束时的 Git HEAD>',
    '```',
    '然后汇报：改动、证据、测试结果、未解决问题、新增提交哈希。',
    '',
  ].join('\n');
}

const firstLineOf = (t: string) => t.split('\n', 1)[0]!.trim();
const numberOf = (line: string) => /^任务编号[:：]\s*(\S+)/.exec(line)?.[1];

export async function exportTask(i: ExportInput): Promise<ExportResult> {
  if (!TASK_ID.test(i.taskId)) throw new Error(`任务编号不合法：${i.taskId}`);
  if (!i.exportDir) throw new Error('必须指定导出目录（--export-dir 或配置）');
  const now = (i.now ?? (() => new Date()))();
  const binding = await gitBinding(i.projectRoot);
  const manifestFile = path.join(i.projectRoot, '.studio', 'tasks', `${i.taskId}.json`);
  const exportDir = path.resolve(i.exportDir);
  const taskFile = path.join(exportDir, `${i.taskId}-task.md`);

  // 先检查两个唯一性，再写入任何东西
  for (const [what, f] of [['任务清单', manifestFile], ['任务文件', taskFile]] as const) {
    if (await fs.stat(f).then(() => true, () => false)) throw new Error(`${what}已存在，拒绝覆盖：${f}`);
  }

  const text = renderTaskFile({ taskId: i.taskId, binding, plan: i.plan, requirements: i.requirements, single: i.single, threadId: i.threadId });
  const manifest: TaskManifest = {
    schema: 1,
    taskId: i.taskId,
    threadId: i.threadId,
    repoRoot: binding.repoRoot,
    branch: binding.branch,
    worktreePath: binding.worktreePath,
    startHead: binding.head,
    plan: { path: i.plan.path, sha256: i.plan.sha256, artifactVersion: i.plan.artifactVersion },
    singleThinker: i.single,
    exportedAt: now.toISOString(),
    taskFile: { path: taskFile, sha256: sha256(text) },
  };
  // 原子且不覆盖：临时文件 + link（目标存在则失败）
  await atomicWriteExclusive(taskFile, text);
  await atomicWriteExclusive(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

  const result: ExportResult = { taskFile, manifestFile, manifest, currentUpdated: false };
  if (!i.setCurrent) return result;

  // 设为当前任务：更新 next-task.md
  const current = path.join(exportDir, 'next-task.md');
  const old = await fs.readFile(current, 'utf8').catch(() => undefined);
  if (old !== undefined) {
    const line = firstLineOf(old);
    const oldNo = numberOf(line);
    if (!i.confirmReplaceCurrent || !(await i.confirmReplaceCurrent(line))) return { ...result, currentNote: `未更新 next-task.md：现有首行为“${line}”，未获确认。` };
    if (!oldNo || !TASK_ID.test(oldNo)) return { ...result, currentNote: `未更新 next-task.md：无法从现有首行“${line}”读出任务编号，无法安全另存旧文件。` };
    const backup = path.join(exportDir, `${oldNo}-task.md`);
    try {
      await atomicWriteExclusive(backup, old);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { ...result, currentNote: `未更新 next-task.md：旧文件应另存为 ${oldNo}-task.md，但该文件已存在，不覆盖。请先处理后再设为当前任务。` };
      throw e;
    }
  }
  await atomicWrite(current, text);
  return { ...result, currentUpdated: true };
}

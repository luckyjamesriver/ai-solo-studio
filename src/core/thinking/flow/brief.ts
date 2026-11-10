import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './store.js';
import { extractSections, loadRequiredContext } from './support.js';

export interface ProjectBriefInput {
  whatItIs: string;
  principles: string;
  targetUsers: string;
}

export interface ProjectBriefView {
  source: 'project_context' | 'project_brief' | 'none';
  readOnly: boolean;
  readOnlyNote: string | null;
  exists: boolean;
  brief: ProjectBriefInput | null;
  outboundNotice: string;
}

export const PROJECT_BRIEF_OUTBOUND_NOTICE =
  '项目简介会作为必带背景资料发送给参与讨论的 AI 服务；首次向该服务发送资料前仍会先征得你的同意。';

const BRIEF_REL_PATH = path.join('.studio', 'project-brief.md');

/** 清理用户输入里的顶层标题标记，避免破坏按 `## N.` 分节的结构。 */
function sanitizeSectionBody(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^#{1,2}\s+/, '### '))
    .join('\n')
    .trim();
}

function extractSectionBody(md: string, num: number): string {
  const sec = extractSections(md, [num]);
  if (!sec) return '';
  const lines = sec.split('\n');
  // 去掉首行 `## N. ...` 标题
  return lines.slice(1).join('\n').trim();
}

export function parseProjectBriefMarkdown(md: string): ProjectBriefInput {
  const whatItIs = extractSectionBody(md, 1);
  const rawPrinciples = extractSectionBody(md, 2);
  const targetUsers = extractSectionBody(md, 4);
  return {
    whatItIs,
    principles: rawPrinciples === '暂无' ? '' : rawPrinciples,
    targetUsers,
  };
}

export function formatProjectBriefMarkdown(input: ProjectBriefInput): string {
  const what = sanitizeSectionBody(input.whatItIs);
  const principles = sanitizeSectionBody(input.principles) || '暂无';
  const target = sanitizeSectionBody(input.targetUsers);
  if (!what) throw new Error('请先填写「这个项目是什么」。');
  if (!target) throw new Error('请先填写「做给谁用」。');
  return [
    '# 项目简介',
    '',
    '## 1. 一句话',
    '',
    what,
    '',
    '## 2. 核心原则',
    '',
    principles,
    '',
    '## 4. 目标用户',
    '',
    target,
    '',
  ].join('\n');
}

export async function hasRequiredContext(projectRoot: string): Promise<boolean> {
  try {
    await loadRequiredContext(projectRoot);
    return true;
  } catch {
    return false;
  }
}

export async function readProjectBriefView(projectRoot: string): Promise<ProjectBriefView> {
  const contextFile = path.join(projectRoot, 'docs', 'PROJECT_CONTEXT.md');
  try {
    const contextMd = await fs.readFile(contextFile, 'utf8');
    const valid = !!extractSections(contextMd, [1, 2, 4]);
    return {
      source: 'project_context',
      readOnly: true,
      readOnlyNote: '本项目使用 docs/PROJECT_CONTEXT.md',
      exists: valid,
      brief: null,
      outboundNotice: PROJECT_BRIEF_OUTBOUND_NOTICE,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return {
        source: 'project_context',
        readOnly: true,
        readOnlyNote: '本项目存在 docs/PROJECT_CONTEXT.md，但当前无法读取。',
        exists: false,
        brief: null,
        outboundNotice: PROJECT_BRIEF_OUTBOUND_NOTICE,
      };
    }
  }

  const briefFile = path.join(projectRoot, BRIEF_REL_PATH);
  try {
    const briefMd = await fs.readFile(briefFile, 'utf8');
    const valid = !!extractSections(briefMd, [1, 2, 4]);
    const parsed = parseProjectBriefMarkdown(briefMd);
    return {
      source: 'project_brief',
      readOnly: false,
      readOnlyNote: null,
      exists: valid && !!parsed.whatItIs && !!parsed.targetUsers,
      brief: parsed,
      outboundNotice: PROJECT_BRIEF_OUTBOUND_NOTICE,
    };
  } catch {
    return {
      source: 'none',
      readOnly: false,
      readOnlyNote: null,
      exists: false,
      brief: null,
      outboundNotice: PROJECT_BRIEF_OUTBOUND_NOTICE,
    };
  }
}

/** 将用户填写的项目简介原子写入 `.studio/project-brief.md`（绝不写进 `docs/`）。 */
export async function saveProjectBrief(projectRoot: string, input: ProjectBriefInput): Promise<ProjectBriefView> {
  const contextFile = path.join(projectRoot, 'docs', 'PROJECT_CONTEXT.md');
  const hasContext = await fs
    .access(contextFile)
    .then(() => true)
    .catch(() => false);
  if (hasContext) {
    throw new Error('本项目使用 docs/PROJECT_CONTEXT.md，无法在此覆盖。');
  }
  const md = formatProjectBriefMarkdown(input);
  await atomicWrite(path.join(projectRoot, BRIEF_REL_PATH), md);
  return readProjectBriefView(projectRoot);
}

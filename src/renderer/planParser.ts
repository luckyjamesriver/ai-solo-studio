/**
 * 方案结构化解析模块（ChatGPT -> Studio）
 * 
 * 职责：
 * 1. 从 ChatGPT 讨论生成的文本、Markdown 或用户输入中提炼出结构化的方案对象（目标、验收标准、涉及文件、重要约束、代码块）。
 * 2. 对齐 TaskController 和 PlanCard 协议，不建立平行任务模型。
 * 3. 严格合规：无法确定的文件范围和验收项必须显式标记为「【待确认】」，绝不擅自补全为已批准的硬性约束。
 * 4. 供方案导入预览卡片使用，确保在用户核准前不创建任务、不自动施工。
 */

export interface ParsedPlan {
  readonly title: string;
  readonly goal: string;
  readonly criteria: readonly string[];
  readonly criteriaConfirmed: boolean;
  readonly inScope: readonly string[];
  readonly scopeConfirmed: boolean;
  readonly constraints: readonly string[];
  readonly codeBlocks: readonly string[];
  readonly rawText: string;
}

export function extractCodeBlocks(text: string): string[] {
  const codeRegex = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  const blocks: string[] = [];
  for (const match of text.matchAll(codeRegex)) {
    if (match[1]?.trim()) {
      blocks.push(match[1].trim());
    }
  }
  return blocks;
}

/**
 * 结构化解析方案文本
 */
export function parsePlanFromText(rawText: string): ParsedPlan {
  const text = (rawText || '').trim();
  if (!text) {
    return {
      title: '新建任务',
      goal: '',
      criteria: ['【待确认】按方案要求完成实现并通过相关测试与检查'],
      criteriaConfirmed: false,
      inScope: ['【待确认】未指定涉及文件范围'],
      scopeConfirmed: false,
      constraints: [],
      codeBlocks: [],
      rawText: '',
    };
  }

  const codeBlocks = extractCodeBlocks(text);

  // 1. 尝试提取标题或目标
  let title = '';
  let goal = '';

  const titleMatch = text.match(/(?:^|\n)(?:#+\s*任务[:：]?|【来自\s*ChatGPT\s*(?:网页)?方案】|【方案】|任务[:：])\s*([^\n]+)/i);
  if (titleMatch?.[1]?.trim()) {
    title = titleMatch[1].replace(/^[：:\s]+/, '').trim();
  }

  const goalMatch = text.match(/(?:^|\n)(?:#+\s*目标[:：]?|目标[:：]|一、任务目标|【目标】)\s*([^\n]+(?:\n(?![#-]|验收|涉及|范围|约束)[^\n]+)*)/i);
  if (goalMatch?.[1]?.trim()) {
    goal = goalMatch[1].replace(/^[：:\s]+/, '').trim();
  }

  // 若没有显式标题，取首行或首句作为标题
  if (!title) {
    const firstLine = text.split('\n').find((l) => l.trim().length > 0) || '';
    title = firstLine.replace(/^[#*-]\s*/, '').slice(0, 60).trim();
  }

  // 若没有显式目标，优先以标题或整段说明为目标
  if (!goal) {
    goal = text.slice(0, 300).trim();
  }

  // 2. 尝试提取条目化验收标准
  const criteria: string[] = [];
  let criteriaConfirmed = false;
  const criteriaSectionMatch = text.match(/(?:#+\s*验收标准|验收标准[:：]|二、验收标准|【验收标准】)([\s\S]*?)(?:\n#+|\n===|\n---|$)/i);
  const criteriaSource = criteriaSectionMatch?.[1];

  if (criteriaSource && criteriaSource.trim()) {
    const itemMatches = criteriaSource.matchAll(/(?:^|\n)\s*(?:-\s*\[[ xX]\]|-\s+|\*\s+|\d+[.)]\s+)([^\n]+)/g);
    for (const match of itemMatches) {
      const item = match[1]?.trim();
      if (item && item.length > 2 && !item.startsWith('http')) {
        criteria.push(item);
      }
    }
  }

  if (criteria.length > 0) {
    criteriaConfirmed = true;
  } else {
    // 从全文尝试匹配 checklist
    const generalMatches = text.matchAll(/(?:^|\n)\s*-\s*\[[ xX]\]\s*([^\n]+)/g);
    for (const match of generalMatches) {
      const item = match[1]?.trim();
      if (item && item.length > 2) {
        criteria.push(item);
      }
    }
    if (criteria.length > 0) {
      criteriaConfirmed = true;
    } else {
      criteriaConfirmed = false;
      criteria.push('【待确认】按方案要求完成代码修改');
      criteria.push('【待确认】运行类型检查、单元测试并通过验证');
    }
  }

  // 3. 提取涉及文件 / 施工范围 (例如 `src/...` 或 filename.ext)
  const inScope: string[] = [];
  let scopeConfirmed = false;
  const scopeSectionMatch = text.match(/(?:#+\s*(?:施工范围|涉及文件|改动文件)|(?:施工范围|涉及文件)[:：])([\s\S]*?)(?:\n#+|\n===|\n---|$)/i);
  const scopeSource = scopeSectionMatch?.[1] ?? text;

  const fileMatches = scopeSource.matchAll(/(?:^|\s|`|')((?:src|tests|e2e|docs|scripts)\/[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_-]+\.(?:mjs|cjs|ts|tsx|js|jsx|json|md))(?:`|'|\s|$)/g);
  for (const match of fileMatches) {
    const f = match[1]?.trim();
    if (f && !inScope.includes(f)) {
      inScope.push(f);
    }
  }

  if (inScope.length > 0) {
    scopeConfirmed = true;
  } else {
    scopeConfirmed = false;
    inScope.push('【待确认】由执行体在施工前分析并确认具体受影响文件');
  }

  // 4. 提取重要约束
  const constraints: string[] = [];
  const constraintsSectionMatch = text.match(/(?:#+\s*(?:重要约束|技术约束|安全约束|约束条件)|(?:重要约束|技术约束)[:：])([\s\S]*?)(?:\n#+|\n===|\n---|$)/i);
  if (constraintsSectionMatch?.[1]) {
    const cMatches = constraintsSectionMatch[1].matchAll(/(?:^|\n)\s*(?:-\s*|\*\s+|\d+[.)]\s+)([^\n]+)/g);
    for (const match of cMatches) {
      const item = match[1]?.trim();
      if (item && item.length > 2) {
        constraints.push(item);
      }
    }
  }

  return {
    title,
    goal,
    criteria,
    criteriaConfirmed,
    inScope,
    scopeConfirmed,
    constraints,
    codeBlocks,
    rawText: text,
  };
}

/**
 * 将解析与核准后的方案序列化为标准 TaskController 输入请求文本。
 * 遵循严格优先级层级：
 * 1. 用户核准要求（最高优先级约束）：目标、施工范围、验收标准、重要约束。用户清空、修改的值必须如实体现，绝不悄悄复活旧值。
 * 2. 原始讨论参考（仅作背景说明，低于上方核准要求）：代码块、补充说明、未提取原始说明。
 */
export function serializePlanForTask(params: {
  goal: string;
  inScope: readonly string[];
  criteria: readonly string[];
  constraints?: readonly string[];
  codeBlocks?: readonly string[];
  rawPlanNotes?: string;
  rawText?: string;
}): string {
  if (!params.goal || !params.goal.trim()) {
    throw new Error('任务目标不可为空，必须明确指定任务目标');
  }

  const sections: string[] = [];
  sections.push(`【来自 ChatGPT 方案】${params.goal.trim()}`);

  // 最高优先级：用户明确核准的要求与约束
  const approvedSections: string[] = [];

  if (params.inScope) {
    if (params.inScope.length > 0) {
      approvedSections.push(`#### 施工范围（涉及文件）\n${params.inScope.map((f) => `- ${f}`).join('\n')}`);
    } else {
      approvedSections.push('#### 施工范围（涉及文件）\n- 【无特定文件限制/由执行体按方案分析决定】');
    }
  }

  if (params.criteria && params.criteria.length > 0) {
    approvedSections.push(`#### 验收标准\n${params.criteria.map((c) => `- [ ] ${c}`).join('\n')}`);
  }

  if (params.constraints && params.constraints.length > 0) {
    approvedSections.push(`#### 重要约束\n${params.constraints.map((c) => `- ${c}`).join('\n')}`);
  }

  if (approvedSections.length > 0) {
    sections.push(`### 施工要求（用户核准要求为最高优先级约束）\n\n${approvedSections.join('\n\n')}`);
  }

  // 参考级别：原始未结构化参考信息（代码块、用户补充说明与原始讨论文本互不排斥，全部完整保留）
  const referenceSections: string[] = [];

  if (params.codeBlocks && params.codeBlocks.length > 0) {
    referenceSections.push(`#### 方案代码与实现参考\n${params.codeBlocks.map((b) => `\`\`\`\n${b}\n\`\`\``).join('\n\n')}`);
  }

  if (params.rawPlanNotes && params.rawPlanNotes.trim()) {
    referenceSections.push(`#### 原始方案补充说明\n${params.rawPlanNotes.trim()}`);
  }

  if (params.rawText && params.rawText.trim()) {
    referenceSections.push(`#### 原始讨论文本（未结构化参考）\n${params.rawText.trim()}`);
  }

  if (referenceSections.length > 0) {
    sections.push(`### 原始方案参考（仅作背景与实现参考，若与上方核准要求冲突，以上方核准要求为准）\n\n${referenceSections.join('\n\n')}`);
  }

  return sections.join('\n\n');
}

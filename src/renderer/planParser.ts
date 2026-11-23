/**
 * 方案结构化解析模块（ChatGPT -> Studio）
 * 
 * 职责：
 * 1. 从 ChatGPT 讨论生成的文本、Markdown 或用户输入中提炼出结构化的方案对象（目标、验收标准、涉及文件、代码块）。
 * 2. 提供容错机制：无论是规整的 Markdown 蓝图还是非结构化的口语化方案，均能提取出可靠的初始任务模型。
 * 3. 供方案导入预览卡片使用，确保在用户核准前不创建任务、不自动施工。
 */

export interface ParsedPlan {
  readonly title: string;
  readonly goal: string;
  readonly criteria: readonly string[];
  readonly inScope: readonly string[];
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
      criteria: ['按要求完成实现并通过相关测试与检查'],
      inScope: [],
      codeBlocks: [],
      rawText: '',
    };
  }

  const codeBlocks = extractCodeBlocks(text);

  // 1. 尝试提取标题或目标
  let title = '';
  let goal = '';

  const titleMatch = text.match(/(?:^|\n)(?:#+\s*任务[:：]?|【来自\s*ChatGPT\s*网页方案】|【方案】|任务[:：])\s*([^\n]+)/i);
  if (titleMatch?.[1]?.trim()) {
    title = titleMatch[1].replace(/^[：:\s]+/, '').trim();
  }

  const goalMatch = text.match(/(?:^|\n)(?:#+\s*目标[:：]?|目标[:：]|一、任务目标|【目标】)\s*([^\n]+(?:\n(?![#-]|验收|涉及)[^\n]+)*)/i);
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
  const criteriaSectionMatch = text.match(/(?:#+\s*验收标准|验收标准[:：]|二、验收标准|【验收标准】)([\s\S]*?)(?:\n#+|\n===|\n---|$)/i);
  const criteriaSource = criteriaSectionMatch?.[1] ?? text;

  // 匹配 "- [ ] ...", "- [x] ...", "- ...", "* ...", "1. ...", "1) ..."
  const itemMatches = criteriaSource.matchAll(/(?:^|\n)\s*(?:-\s*\[[ xX]\]|-\s+|\*\s+|\d+[.)]\s+)([^\n]+)/g);
  for (const match of itemMatches) {
    const item = match[1]?.trim();
    if (item && item.length > 2 && !item.startsWith('http') && !item.startsWith('修改文件')) {
      criteria.push(item);
    }
  }

  // 兜底验收标准
  if (criteria.length === 0) {
    criteria.push('按方案要求完成代码修改');
    criteria.push('运行类型检查、单元测试并通过验证');
  }

  // 3. 提取涉及文件 / 作用域 (例如 `src/...` 或 filename.ext)
  const inScope: string[] = [];
  const fileMatches = text.matchAll(/(?:^|\s|`)((?:src|tests|e2e|docs|scripts)\/[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_-]+\.(?:mjs|cjs|ts|tsx|js|jsx|json|md))(?:`|\s|$)/g);
  for (const match of fileMatches) {
    const f = match[1]?.trim();
    if (f && !inScope.includes(f)) {
      inScope.push(f);
    }
  }

  return {
    title,
    goal,
    criteria,
    inScope,
    codeBlocks,
    rawText: text,
  };
}

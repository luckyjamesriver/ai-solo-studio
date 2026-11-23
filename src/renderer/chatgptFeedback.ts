import type { TaskView } from '../core/app/task-view.js';

export interface ChatGPTFeedbackMetadata {
  readonly mode: 'human-in-the-loop';
  readonly stage: 'P0-2';
  readonly taskId: string;
  readonly round: number;
  readonly state: string;
}

export interface FeedbackReviewOptions {
  /** 遮蔽常见凭证与密钥（如 sk-..., Bearer, token 等） */
  maskCredentials?: boolean;
  /** 脱敏绝对路径为工作区相对路径或 ~/ */
  relativePaths?: boolean;
  /** 是否包含诊断摘要 */
  includeDiagnostics?: boolean;
}

/**
 * 敏感信息过滤与脱敏工具
 */
export function sanitizeFeedbackText(text: string, options: FeedbackReviewOptions = {}): string {
  let result = text || '';

  if (options.relativePaths !== false) {
    // 遮蔽常见 macOS/Linux 根目录绝对路径
    result = result.replace(/(?:\/(?:Users|home|root)\/[a-zA-Z0-9_.-]+)(\/[^\s"')`\]]+)/g, '~$1');
  }

  if (options.maskCredentials !== false) {
    // 遮蔽 OpenAI/DeepSeek API Key (sk-...)
    result = result.replace(/\b(sk-[a-zA-Z0-9_-]{6})[a-zA-Z0-9_-]+/g, '$1***[REDACTED]');
    // 遮蔽 Bearer tokens
    result = result.replace(/(Bearer\s+)[a-zA-Z0-9_.-]{12,}/gi, '$1***[REDACTED]');
    // 遮蔽形如 password=... / token=...
    result = result.replace(/(password|token|secret|credential)\s*[:=]\s*['"]?[a-zA-Z0-9_.-]{8,}['"]?/gi, '$1: ***[REDACTED]');
  }

  return result;
}

/**
 * 构建结构化执行结果反馈包（Studio -> ChatGPT）
 * 
 * 严格遵从工程可信与防伪原则：
 * 1. 明确区分【宿主真实检查事实 (Host Verified Facts)】与【AI 自述 (AI Self-Reported)】；
 * 2. 没有宿主测试证据绝不宣称 OK，AI 生成的代码或建议不可标记为已执行结果；
 * 3. 明确列出【用户尚未验收的内容】与【未运行检查项】；
 * 4. 固化 Human-in-the-loop 人工审查交接声明。
 */
export function buildChatGPTFeedbackPacket(
  task: TaskView,
  projectName?: string,
  options: FeedbackReviewOptions = {},
): string {
  const pName = projectName || '当前工作区项目';

  // 1. 真实修改清单
  const changes = task.result?.changes || [];
  let changesText = '暂无已记录的文件修改。';
  if (changes.length > 0) {
    changesText = changes
      .map((c) => `- \`${c.path}\` (${c.status || 'modified'})`)
      .join('\n');
  }

  // 2. 检查与测试事实（严格区分宿主事实与 AI 自述）
  const facts = task.result?.facts || [];
  const hostFactsLines: string[] = [];
  const aiSelfReportLines: string[] = [];

  if (facts.length > 0) {
    for (const f of facts) {
      const icon = f.status === 'ok' ? '✅' : f.status === 'bad' ? '❌' : '⚠️';
      hostFactsLines.push(`- ${icon} **${f.label}**: ${f.detail}（宿主执行验证）`);
    }
  } else {
    hostFactsLines.push('- ⚠️ **无宿主自动化测试事实记录**（尚未运行或未产出测试证据，不可视为已通过）。');
  }

  // 区分 AI 自述与未完成
  const incomplete = task.result?.incomplete;
  if (incomplete?.kind === 'items') {
    for (const item of incomplete.items) {
      aiSelfReportLines.push(`- ⚠️ 未完成操作: ${item}`);
    }
  } else if (incomplete?.kind === 'raw') {
    aiSelfReportLines.push(`- ℹ️ AI 自述状态（未经宿主工具独立核验）: ${incomplete.text}`);
  }

  // 计划内未检查项
  const plannedChecks = task.checks || [];
  const uncheckedLines: string[] = [];
  if (plannedChecks.length > 0) {
    const verifiedLabels = facts.map((f) => f.label.toLowerCase());
    for (const c of plannedChecks) {
      if (!verifiedLabels.some((vl) => vl.includes(c.label.toLowerCase()))) {
        uncheckedLines.push(`- ⏳ **${c.label}**: 计划内但本次未运行或无事实产出`);
      }
    }
  }

  // 用户尚未确认的验收标准
  const pendingCriteriaLines: string[] = [];
  if (task.criteria && task.criteria.length > 0) {
    for (const cr of task.criteria) {
      pendingCriteriaLines.push(`- [ ] ${cr}（待人工核验）`);
    }
  }

  let factsSection = `### 宿主真实检查事实 (Host Verified Facts)\n${hostFactsLines.join('\n')}\n`;
  if (uncheckedLines.length > 0) {
    factsSection += `\n### 计划内未运行项 (Unchecked Items)\n${uncheckedLines.join('\n')}\n`;
  }
  if (aiSelfReportLines.length > 0) {
    factsSection += `\n### AI 自述记录 (AI Self-Reported · 非宿主证据)\n${aiSelfReportLines.join('\n')}\n`;
  }
  if (pendingCriteriaLines.length > 0) {
    factsSection += `\n### 尚未验收条目 (Pending User Acceptance)\n${pendingCriteriaLines.join('\n')}\n`;
  }

  // 3. 诊断与阻断问题
  const diagnostics = task.diagnostics || [];
  const problems: string[] = [];

  if (options.includeDiagnostics !== false && diagnostics.length > 0) {
    for (const d of diagnostics.slice(0, 5)) {
      problems.push(`- 🔍 诊断记录: ${d}`);
    }
  }

  if (task.stoppedInfo) {
    problems.push(`- 🛑 任务停止原因: ${task.stoppedInfo.reasonLabel} — ${task.stoppedInfo.reasonDetail}`);
  }

  if (task.startFailure) {
    problems.push(`- ⛔ 任务启动失败: ${task.startFailure}`);
  }

  const problemsText = problems.length > 0 ? problems.join('\n') : '目前无阻断性异常或未决问题。';

  // 4. 需要裁决的事项
  const adjudications: string[] = [];
  if (task.reapproveNotice) {
    adjudications.push(`- 需确认验收标准变更: ${task.reapproveNotice}`);
  }
  if (task.result?.unexpectedRequests && task.result.unexpectedRequests > 0) {
    adjudications.push(`- 异常权限拦截: AI 尝试发起了 ${task.result.unexpectedRequests} 次未声明权限请求，已被安全策略自动拒绝。`);
  }
  if (task.state === 'clarifying') {
    adjudications.push('- 需补充澄清信息: 执行体对方案范围有疑问，请核对需求。');
  }
  const adjudicationsText = adjudications.length > 0
    ? adjudications.join('\n')
    : '无需人工裁决，可按原计划推进。';

  // 5. 下一轮建议
  const nextSteps: string[] = [];
  if (task.state === 'saved') {
    nextSteps.push('1. 本轮任务已成功合并保存至项目。');
    nextSteps.push('2. 如需扩展功能，请基于当前成果提出新任务方案。');
  } else if (task.state === 'exec_failed' || task.state === 'stopped' || task.state === 'timed_out') {
    nextSteps.push('1. 针对上述报错与未完成项，给出针对性的修复或放宽建议。');
    nextSteps.push('2. 修改方案目标或代码思路后，重新提炼方案继续执行。');
  } else {
    nextSteps.push('1. 请根据上述测试事实，评审是否需要补充测试或微调实现。');
    nextSteps.push('2. 继续提供具体的重构或补全代码指导。');
  }
  const nextStepsText = nextSteps.join('\n');

  const rawPacket = `# AI Solo Studio 执行结果反馈包 (ChatGPT 协同交接)

> **交接模式**：人工确认交接（Human-in-the-loop transfer · 阶段 P0-2）  
> **审查说明**：本反馈包由用户在 AI Solo Studio 审查后手动生成与确认，用于粘贴至 ChatGPT 网页继续讨论与指导；非全自动后台双向通信。无证据绝不宣称通过。  
> **隐私安全声明**：本反馈包经由通用规则初步脱敏，但正则脱敏无法保证 100% 覆盖所有私有凭证与隐私信息；外发前必须由人工逐行核验确认。

## 1. 任务背景与当前阶段
- **所属项目**：${pName}
- **任务编号**：\`${task.id}\`
- **当前轮次**：第 ${task.round} 轮
- **当前状态**：${task.stateText} (\`${task.state}\`)
- **任务目标**：${task.goal}
- **执行角色**：${task.executorText}

## 2. 真实完成的代码修改
${changesText}

## 3. 测试与环境检查事实 (宿主可验证证据 vs AI 自述)
${factsSection}

## 4. 未解决或阻断的问题
${problemsText}

## 5. 需要用户或 ChatGPT 裁决的事项
${adjudicationsText}

## 6. 下一轮开发建议
${nextStepsText}

---
<!-- AI-SOLO-STUDIO-HANDOFF: mode=human-in-the-loop, stage=P0-2, task=${task.id}, round=${task.round} -->
`;

  return sanitizeFeedbackText(rawPacket, options);
}

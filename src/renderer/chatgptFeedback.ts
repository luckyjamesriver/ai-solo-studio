import type { TaskView } from '../core/app/task-view.js';

export interface ChatGPTFeedbackMetadata {
  readonly mode: 'human-in-the-loop';
  readonly stage: 'P0-2';
  readonly taskId: string;
  readonly round: number;
  readonly state: string;
}

/**
 * 构建结构化执行结果反馈包（Studio -> ChatGPT）
 * 
 * 包含六大核心模块：
 * 1. 任务背景与当前阶段
 * 2. 真实完成的代码修改
 * 3. 宿主核验的测试与检查事实
 * 4. 未解决或阻断的问题
 * 5. 需要用户或 ChatGPT 裁决的事项
 * 6. 下一轮开发建议
 * 
 * 诚实与透明声明：
 * 明确标注本交接属于人工确认交接（Human-in-the-loop transfer），
 * 杜绝将手动复制交接宣称为全自动双向通信。
 */
export function buildChatGPTFeedbackPacket(task: TaskView, projectName?: string): string {
  const pName = projectName || '当前工作区项目';

  // 1. 真实修改清单
  const changes = task.result?.changes || [];
  let changesText = '暂无已记录的文件修改。';
  if (changes.length > 0) {
    changesText = changes
      .map((c) => `- \`${c.path}\` (${c.status || 'modified'})`)
      .join('\n');
  }

  // 2. 检查与测试事实
  const facts = task.result?.facts || [];
  let factsText = '暂无宿主运行的事实验证记录。';
  if (facts.length > 0) {
    factsText = facts
      .map((f) => {
        const icon = f.status === 'ok' ? '✅' : f.status === 'bad' ? '❌' : '⚠️';
        return `- ${icon} **${f.label}**: ${f.detail}`;
      })
      .join('\n');
  }

  const checksSummary = task.checks && task.checks.length > 0
    ? `计划内检查项: ${task.checks.map((c) => c.label).join('、')}`
    : '无额外检查计划';

  // 3. 未解决或阻断的问题
  const incomplete = task.result?.incomplete;
  const diagnostics = task.diagnostics || [];
  const problems: string[] = [];

  if (incomplete?.kind === 'items') {
    for (const item of incomplete.items) {
      problems.push(`- ⚠️ 未完成操作: ${item}`);
    }
  } else if (incomplete?.kind === 'raw') {
    problems.push(`- ⚠️ AI 自述未完成: ${incomplete.text}`);
  }

  if (diagnostics.length > 0) {
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

  return `# AI Solo Studio 执行结果反馈包 (ChatGPT 协同交接)

> **交接模式**：人工确认交接（Human-in-the-loop transfer · 阶段 P0-2）  
> **交接说明**：本反馈包由用户在 AI Solo Studio 中手动生成与确认，用于粘贴至 ChatGPT 网页继续讨论与指导；非全自动后台双向通信。

## 1. 任务背景与当前阶段
- **所属项目**：${pName}
- **任务编号**：\`${task.id}\`
- **当前轮次**：第 ${task.round} 轮
- **当前状态**：${task.stateText} (\`${task.state}\`)
- **任务目标**：${task.goal}
- **执行角色**：${task.executorText}

## 2. 真实完成的代码修改
${changesText}

## 3. 测试与环境检查事实 (宿主可验证证据)
${factsText}
- ${checksSummary}

## 4. 未解决或阻断的问题
${problemsText}

## 5. 需要用户或 ChatGPT 裁决的事项
${adjudicationsText}

## 6. 下一轮开发建议
${nextStepsText}

---
<!-- AI-SOLO-STUDIO-HANDOFF: mode=human-in-the-loop, stage=P0-2, task=${task.id}, round=${task.round} -->
`;
}

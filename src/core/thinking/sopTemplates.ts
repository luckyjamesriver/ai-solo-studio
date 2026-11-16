/**
 * 工业级 SOP 蓝图模板库 (Standard Operating Procedure Blueprints)
 * 为独立开发者内置常用经典工程研发蓝图，一键填充标准化实施步骤。
 */

export interface SopBlueprint {
  id: string;
  name: string;
  badge: string;
  description: string;
  targetAudience: string;
  corePrinciples: string[];
  standardPhases: Array<{ step: number; title: string; owner: string }>;
  recommendedPrompt: string;
}

export const SOP_BLUEPRINTS: SopBlueprint[] = [
  {
    id: 'sop-desktop-offline',
    name: '极简桌面离线工具',
    badge: '推荐 · 独立工具',
    description: '适用于单人开发菜单栏、多剪贴板、离线格式转换等桌面级工具。',
    targetAudience: '独立开发者 / 个人创作者',
    corePrinciples: [
      '100% 纯本地运行，默认禁用网络上传',
      '拒绝过度抽象，单功能单模块',
      '必须包含本地数据容灾备份 (.json/.sqlite)',
    ],
    standardPhases: [
      { step: 1, title: '用户极简交互蓝图', owner: 'Claude (架构规划)' },
      { step: 2, title: '系统原生 API 与合规把关', owner: 'ChatGPT (技术评审)' },
      { step: 3, title: '骨架搭建与本地存储持久化', owner: 'CLI 施工队' },
      { step: 4, title: '核心交互逻辑与快捷键监听', owner: 'CLI 施工队' },
      { step: 5, title: '无网离线测试与门禁交付', owner: '客观门禁引擎' },
    ],
    recommendedPrompt: '我想开发一款极简的桌面离线小工具。请按照「极简桌面离线工具 SOP」标准，两位专家先针对核心交互与本地存储方案进行磋商，并拆解出施工工单。',
  },
  {
    id: 'sop-saas-landing',
    name: '现代极简 SaaS 落地页',
    badge: '高转化 · 前端',
    description: '适用于快速发布产品官网、Waitlist 收集页或移动端自适应介绍页。',
    targetAudience: '出海创作者 / 独立站长',
    corePrinciples: [
      '首屏秒开，杜绝臃肿重型三方库',
      '移动端响应式极致适配',
      '清晰的价值主张 (Hero) 与行动号召 (CTA)',
    ],
    standardPhases: [
      { step: 1, title: '价值主张与文案架构梳理', owner: 'Claude (架构规划)' },
      { step: 2, title: '响应式排版与性能瓶颈评审', owner: 'ChatGPT (技术评审)' },
      { step: 3, title: '响应式框架搭设', owner: 'CLI 施工队' },
      { step: 4, title: '转化组件与表单交互实现', owner: 'CLI 施工队' },
      { step: 5, title: '性能优化与门禁体检', owner: '客观门禁引擎' },
    ],
    recommendedPrompt: '我想打造一个现代极简的高转化 SaaS 官网落地页。请按照「SaaS 落地页 SOP」标准，帮助我拆解页面模块与施工步骤。',
  },
  {
    id: 'sop-local-automation',
    name: '本地数据与批处理脚本',
    badge: '高生产力 · 自动化',
    description: '适用于本地 Excel/PDF/图片批处理、定时采集整理等个人提效场景。',
    targetAudience: '办公人员 / 数据分析员',
    corePrinciples: [
      '幂等性：重复运行不产生脏数据',
      '详细的本地运行日志记录',
      '开箱即用，依赖最少化',
    ],
    standardPhases: [
      { step: 1, title: '输入输出数据格式契约定义', owner: 'Claude (架构规划)' },
      { step: 2, title: '异常数据与脏数据容错评审', owner: 'ChatGPT (技术评审)' },
      { step: 3, title: '核心批处理解析脚本编写', owner: 'CLI 施工队' },
      { step: 4, title: '边界异常测试与空值自检', owner: 'CLI 施工队' },
      { step: 5, title: '一键运行 CLI 封装与门禁交付', owner: '客观门禁引擎' },
    ],
    recommendedPrompt: '我需要编写一个本地自动化批处理脚本。请按照「本地自动化 SOP」规范，指导我完成从数据清洗到稳定执行的闭环。',
  },
];

export function getBlueprintById(id: string): SopBlueprint {
  const found = SOP_BLUEPRINTS.find((b) => b.id === id);
  if (found) return found;
  const first = SOP_BLUEPRINTS[0];
  if (!first) throw new Error('No SOP blueprints configured');
  return first;
}

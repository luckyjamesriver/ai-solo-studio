import type { Capabilities } from '../capabilities/model.js';
import type { EffectivePermissions } from '../executor/modes.js';

export function summarizeCapabilities(caps: Capabilities | undefined): string {
  const mode = caps?.constructionMode === 'full_trust' ? '完全信任' : '标准';
  const dirCount = caps?.extraWritableDirs.length ?? 0;
  const dirPart = caps?.constructionMode === 'full_trust' ? '' : dirCount > 0 ? `任务副本 + ${dirCount} 个文件夹` : '仅任务副本';
  const netPart = caps?.externalNetwork === 'on' ? '可联网' : '不联网';
  return [mode, ...(dirPart ? [dirPart] : []), netPart].join(' · ');
}

export interface PermissionSummary {
  /** 模式名（中文） */
  modeName: string;
  /** 一句一条的大白话说明 */
  lines: string[];
}

/**
 * 把“实际生效的权限”（task.effectivePermissions，取自启动后核验）翻译成给用户看的中文。
 * 网络以响应里实际报告的状态为准（没有报告时才用我们的期望值）。界面不出现任何内部名词。
 */
export function describePermissions(ep: EffectivePermissions | undefined): PermissionSummary | null {
  if (!ep) return null;
  const net = typeof ep.networkAccess === 'boolean' ? ep.networkAccess : ep.networkEnabled;
  if (ep.mode === 'full_trust') {
    return {
      modeName: '完全信任模式',
      lines: ['可修改的位置：你这个电脑账户能修改的任何位置（包括项目以外）', '联网：可以访问任意网站', '读取：可以读取任何文件'],
    };
  }
  if (ep.mode === 'read_only') {
    return { modeName: '只读模式', lines: ['可修改的位置：无（只能查看）', '联网：不可以'] };
  }
  // writableRoots[0] 是任务副本，其余是用户选定的额外文件夹
  const where = ['任务副本', ...ep.writableRoots.slice(1).map((p) => `你选定的文件夹：${p}`)];
  return {
    modeName: '标准模式',
    lines: [
      `可修改的位置：${where.join('；')}`,
      net ? (ep.allowedDomains.length ? `联网：已开启，仅限 ${ep.allowedDomains.join('、')}` : '联网：已开启，可访问任意网站') : '联网：不可以',
      '读取：已阻止读取密钥、账号凭证等敏感位置，其他位置 AI 仍可读取',
    ],
  };
}

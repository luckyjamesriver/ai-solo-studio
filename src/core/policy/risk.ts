import path from 'node:path';
import type { PermissionRequest } from '../executor/types.js';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskAssessment {
  level: RiskLevel;
  /** 该操作的影响能否通过撤销任务完全恢复 */
  reversible: boolean;
  /** 给用户看的大白话解释 */
  explanation: string;
}

const NETWORK_CMDS = new Set(['curl', 'wget', 'ssh', 'scp', 'rsync']);
const DANGEROUS_CMDS = new Set(['rm', 'sudo', 'chmod', 'chown', 'dd', 'mkfs', 'kill', 'killall']);
const PKG_INSTALL = /^(npm|pnpm|yarn|bun)$/;

function insideWorktree(p: string, wt: string): boolean {
  const abs = path.resolve(wt, p);
  return abs === wt || abs.startsWith(wt + path.sep);
}

/** 评估一次权限请求的风险。worktree 外的任何路径一律高风险且不可恢复。 */
export function assess(req: PermissionRequest, worktree: string): RiskAssessment {
  const outside = (req.paths ?? []).some((p) => !insideWorktree(p, worktree));
  if (outside) {
    return {
      level: 'high',
      reversible: false,
      explanation: '它想访问当前任务文件夹以外的位置。这类改动无法通过“撤销任务”恢复，默认不建议允许。',
    };
  }
  switch (req.kind) {
    case 'read_file':
      return { level: 'low', reversible: true, explanation: '读取项目里的文件，不会做任何修改。' };
    case 'write_file':
      return { level: 'low', reversible: true, explanation: '在任务的独立副本里修改文件。撤销任务即可完全恢复。' };
    case 'delete_file': {
      const many = (req.paths?.length ?? 0) > 10;
      return {
        level: many ? 'high' : 'medium',
        reversible: true,
        explanation: many
          ? `它想一次删除 ${req.paths!.length} 个文件。虽然撤销任务可以恢复，但请确认这是你想要的。`
          : '删除任务副本中的文件。撤销任务即可恢复。',
      };
    }
    case 'network':
      return { level: 'high', reversible: false, explanation: '它想访问网络。发出去的数据无法收回。' };
    case 'run_command': {
      const [cmd = '', sub = ''] = req.command ?? [];
      const base = path.basename(cmd);
      if (base === 'git' && ['push', 'remote', 'config'].includes(sub)) {
        return { level: 'high', reversible: false, explanation: '它想修改 Git 远程或配置，可能把代码发到外部。' };
      }
      if (DANGEROUS_CMDS.has(base)) {
        return { level: 'high', reversible: false, explanation: `它想运行 ${base}，这是可能造成破坏的系统命令。` };
      }
      if (NETWORK_CMDS.has(base)) {
        return { level: 'high', reversible: false, explanation: `它想用 ${base} 访问网络。` };
      }
      if (PKG_INSTALL.test(base) && ['install', 'i', 'add'].includes(sub)) {
        return {
          level: 'medium',
          reversible: false,
          explanation: '它想下载安装项目依赖。文件改动可撤销，但会联网下载，且依赖包会运行自己的安装脚本。',
        };
      }
      if (PKG_INSTALL.test(base) && ['run', 'test', 'build'].includes(sub)) {
        return { level: 'medium', reversible: true, explanation: '运行项目自带的脚本（如构建或测试）。' };
      }
      return { level: 'medium', reversible: false, explanation: `它想运行命令：${(req.command ?? []).join(' ')}` };
    }
    default:
      return { level: 'medium', reversible: false, explanation: req.description };
  }
}

export interface AutoApproveRule {
  /** 本任务内自动批准低风险操作 */
  autoLow: boolean;
}

/** 是否可以不询问用户直接批准。中、高风险永远需要用户决定。 */
export function canAutoApprove(a: RiskAssessment, rule: AutoApproveRule): boolean {
  return rule.autoLow && a.level === 'low' && a.reversible;
}

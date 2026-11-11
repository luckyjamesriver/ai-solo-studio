import type { SandboxCommandRunner } from '../../checks/scripts.js';
import { SeatbeltSandboxRunner, type SeatbeltSandboxRunnerOptions } from './seatbelt.js';

export interface StandaloneSandboxStatus {
  available: boolean;
  kind: 'seatbelt' | 'none';
  label: string;
  detail: string;
}

export interface StandaloneSandboxResult {
  runner?: SandboxCommandRunner;
  status: StandaloneSandboxStatus;
}

/**
 * 探测并构造脱离 Codex 的独立受限检查沙箱（阶段 8C）。
 * - macOS：通过 `/usr/bin/sandbox-exec` 在受限规则下运行项目构建与测试脚本；
 * - Linux / 非支持环境或自检失败：返回 `{ runner: undefined, status: { available: false, ... } }`，
 *   调用方（`runProjectChecks`）按 `not_available` → `unchecked_needs_confirm` 处理，绝不宿主直跑。
 */
export async function createStandaloneSandboxRunner(
  opts: SeatbeltSandboxRunnerOptions = {},
): Promise<StandaloneSandboxResult> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      status: {
        available: false,
        kind: 'none',
        label: '当前平台不可用',
        detail:
          '当前系统不是 macOS，应用未内置独立受限检查环境；使用非 Codex 执行者且未配备可用的 Codex 检查环境时，保存前需手动确认未检查项。',
      },
    };
  }

  const candidate = new SeatbeltSandboxRunner(opts);
  const probe = await candidate.detect();
  if (!probe.available) {
    return {
      status: {
        available: false,
        kind: 'none',
        label: '不可用',
        detail: probe.reason ?? '系统独立受限检查环境自检失败；保存前需手动确认未检查项。',
      },
    };
  }

  return {
    runner: candidate,
    status: {
      available: true,
      kind: 'seatbelt',
      label: '可用（独立受限检查）',
      detail:
        '不依赖 Codex 登录即可自动运行构建与测试检查：拦截常见凭证目录读取、禁止修改任务副本与额外目录以外文件、标准模式默认断网。',
    },
  };
}

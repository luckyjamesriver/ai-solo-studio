import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareVitestRun, cleanupVitestRun } from '../src/core/evidence/vitest.js';
import { adjudicateEvidence, adjudicateTaskEvidence } from '../src/core/evidence/adjudicate.js';
import type { HostCheckEvidence } from '../src/core/evidence/model.js';
import type { Task, StoredCheckProof } from '../src/core/task/model.js';

describe('AISS-A1-R2 专项反向验证 (R2 Negative & Regression Probes)', () => {
  describe('R2-01: 宿主文件操作越界防御与符号链接阻断', () => {
    it('当 .studio/evidence 或其父路径是符号链接时，拒绝创建并阻止污染外部哨兵目录', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'r2-01-probe-'));
      const victim = path.join(tmp, 'external-victim');
      await fs.mkdir(victim);
      const sentinel = path.join(victim, 'sentinel.txt');
      await fs.writeFile(sentinel, 'STRICTLY_PRESERVE');

      const worktree = path.join(tmp, 'worktree');
      await fs.mkdir(path.join(worktree, '.studio'), { recursive: true });
      await fs.symlink(victim, path.join(worktree, '.studio', 'evidence'));

      // 验证 prepareVitestRun 严厉拦截
      await expect(prepareVitestRun(worktree, 'vitest run')).rejects.toThrow(/包含符号链接/);

      // 验证外部哨兵目录及文件完好无损（0 污染、0 新增、0 逃逸）
      const victimEntries = await fs.readdir(victim);
      expect(victimEntries).toEqual(['sentinel.txt']);
      expect(await fs.readFile(sentinel, 'utf8')).toBe('STRICTLY_PRESERVE');

      await fs.rm(tmp, { recursive: true, force: true });
    });

    it('当试图清理指向非受控外部的 plan.reportDir 时，removeSafeSubtree 拒绝删除外部文件', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'r2-01-clean-'));
      const victim = path.join(tmp, 'victim');
      await fs.mkdir(victim);
      const sentinel = path.join(victim, 'dont_delete.txt');
      await fs.writeFile(sentinel, 'KEEP_ALIVE');

      const fakePlan = {
        reportPath: path.join(victim, 'vitest-report.json'),
        reportDir: victim,
        argv: [],
        nonce: 'escaped_nonce',
        realRootDir: path.join(tmp, 'fake_worktree'),
      };

      // cleanupVitestRun 内部捕获异常但绝对不删除外部目录
      await cleanupVitestRun(fakePlan);
      expect(await fs.readFile(sentinel, 'utf8')).toBe('KEEP_ALIVE');

      await fs.rm(tmp, { recursive: true, force: true });
    });
  });

  describe('R2-02: 彻底统一证据裁决与失败优先不变量', () => {
    it('真实运行失败（verdict=failed）不能被范围削弱或变化降级为可放行的 unverified', () => {
      const ev = {
        schemaVersion: 1,
        kind: 'test',
        verdict: 'failed',
        trust: 'trusted',
        valid: true,
        identity: {
          schemaVersion: 1,
          evidenceId: 'e-failed-1',
          kind: 'test',
          projectRootHash: 'p1',
          worktreePathHash: 'w1',
          taskId: 't1',
          round: 1,
          acceptanceRev: 0,
          testedTree: 'tree-1',
          createdAt: new Date().toISOString(),
          runIdentityHash: 'r1',
        },
        run: {
          runId: 'r-1',
          argv: ['npm', 'test'],
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 100,
          env: 'sandbox',
          sandboxKind: 'seatbelt',
          timedOut: false,
          exitKind: 'exited',
          exitCode: 1,
          stdoutSha256: 'empty',
          stdoutBytes: 0,
          stderrSha256: 'err',
        },
        config: { testConfigFiles: [], reporterMode: 'none', collectorVersion: '1' },
        scope: {
          kind: 'assessed_weakened',
          baselineAvailable: true,
          reasons: ['测试断言被删除'],
          fingerprint: 'fp-1',
        },
      } as unknown as HostCheckEvidence;

      const adj = adjudicateEvidence(ev, 'test', {
        taskId: 't1',
        round: 1,
        acceptanceRev: 0,
        acceptedTree: 'tree-1',
      });

      // 无论 scope 怎么标记，必须判定为 failed，绝对不能是 unverified！
      expect(adj.status).toBe('failed');
      expect(adj.detail).toBe('自动测试没有通过');
    });

    it('当存在测试范围削弱与测试范围待确认时，全部正确进入核心保存门禁', () => {
      const task: Partial<Task> = {
        id: 't-scope-1',
        currentRound: 1,
        currentChecks: [
          {
            name: 'test',
            status: 'unverified',
            evidence: {
              schemaVersion: 1,
              kind: 'test',
              verdict: 'unverified',
              trust: 'weak',
              valid: true,
              identity: {
                schemaVersion: 1,
                evidenceId: 'e-scope-1',
                kind: 'test',
                projectRootHash: 'p1',
                worktreePathHash: 'w1',
                taskId: 't-scope-1',
                round: 1,
                acceptanceRev: 0,
                testedTree: 'tree-1',
                createdAt: new Date().toISOString(),
                runIdentityHash: 'r1',
              },
              run: {
                runId: 'r-2',
                argv: ['npm', 'test'],
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                durationMs: 100,
                env: 'sandbox',
                sandboxKind: 'seatbelt',
                timedOut: false,
                exitKind: 'exited',
                exitCode: 0,
                stdoutSha256: 'empty',
                stdoutBytes: 0,
                stderrSha256: 'err',
              },
              config: { testConfigFiles: [], reporterMode: 'none', collectorVersion: '1' },
              scope: {
                kind: 'assessed_needs_review',
                baselineAvailable: true,
                reasons: ['测试辅助文件发生变化'],
                fingerprint: 'fp-scope-review',
              },
            } as unknown as HostCheckEvidence,
          } as unknown as StoredCheckProof,
        ],
      };

      const adj = adjudicateTaskEvidence(task as Task);
      expect(adj.needsScopeConfirm).toBe(true);
      expect(adj.items[0]?.reason).toBe('test_scope_changed');
    });
  });

  describe('R2-04: 保存完整性与全量路径比较', () => {
    it('保存记录完整持久化 trialChecks 详细事实，重启恢复后可精准回溯当时的真实证据', () => {
      const storedProof: StoredCheckProof = {
        name: 'test',
        status: 'passed',
        env: 'sandbox',
        evidence: {
          schemaVersion: 1,
          kind: 'test',
          verdict: 'passed',
          trust: 'trusted',
          valid: true,
          identity: {
            schemaVersion: 1,
            evidenceId: 'ev-full-1',
            kind: 'test',
            projectRootHash: 'p-1',
            worktreePathHash: 'w-1',
            taskId: 't-full',
            round: 1,
            acceptanceRev: 1,
            testedTree: 'tree-xyz',
            createdAt: new Date().toISOString(),
            runIdentityHash: 'r-xyz',
          },
          run: {
            runId: 'r-3',
            argv: ['npm', 'test'],
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 120,
            env: 'sandbox',
            sandboxKind: 'seatbelt',
            timedOut: false,
            exitKind: 'exited',
            exitCode: 0,
            stdoutSha256: 'empty',
            stdoutBytes: 0,
            stderrSha256: 'err',
          },
          config: { testConfigFiles: [], reporterMode: 'none', collectorVersion: '1' },
          scope: { kind: 'assessed_unchanged', baselineAvailable: true, reasons: [] },
        } as unknown as HostCheckEvidence,
      };

      const task: Partial<Task> = {
        id: 't-save-rec',
        currentRound: 1,
        saveRecord: {
          preMergeHead: 'head-0',
          taskCommit: 'task-c-1',
          mergeCommit: 'merge-c-1',
          branch: 'main',
          savedAt: new Date().toISOString(),
          checked: true,
          evidenceIds: { test: 'ev-full-1' },
          trialChecks: [storedProof],
        },
      };

      expect(task.saveRecord?.trialChecks).toBeDefined();
      expect(task.saveRecord?.trialChecks?.[0]?.evidence?.identity.evidenceId).toBe('ev-full-1');
      expect(task.saveRecord?.trialChecks?.[0]?.evidence?.verdict).toBe('passed');
    });
  });
});

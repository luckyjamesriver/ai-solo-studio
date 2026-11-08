import { describe, it, expect } from 'vitest';
import { DEFAULT_CAPABILITIES, resolveCapabilities } from '../src/core/capabilities/model.js';
import { TaskRunner } from '../src/core/task/runner.js';
import { FakeExecutor } from '../src/core/executor/adapters/fake.js';
import { makeRepo } from './helpers.js';

describe('能力模型', () => {
  it('默认值 = 最小权限（v1.5 第 5.1 节）', () => {
    expect(resolveCapabilities()).toEqual({ fileAccess: 'worktree_write', externalNetwork: 'off', credentialAccess: 'none', grantedMcp: [], nonOfficialModelEndpoint: 'deny', constructionMode: 'standard', extraWritableDirs: [], allowedNetworkDomains: [] });
    expect(DEFAULT_CAPABILITIES.grantedMcp).toEqual([]);
  });
  it('可以放宽个别项，其余仍为默认；MCP 授予列表去重', () => {
    const c = resolveCapabilities({ externalNetwork: 'on', grantedMcp: ['a', 'a', 'b'] });
    expect(c).toMatchObject({ externalNetwork: 'on', constructionMode: 'standard', fileAccess: 'worktree_write', extraWritableDirs: [] });
    expect(c.grantedMcp).toEqual(['a', 'b']);
  });
  it('扩展权限：额外可写目录必须是绝对路径；放行域名必须同时开启联网；模式取值受限', () => {
    expect(resolveCapabilities({ extraWritableDirs: ['/a', '/a', '/b'] }).extraWritableDirs).toEqual(['/a', '/b']);
    expect(() => resolveCapabilities({ extraWritableDirs: ['relative/dir'] })).toThrow(/绝对路径/);
    expect(() => resolveCapabilities({ allowedNetworkDomains: ['example.com'] })).toThrow(/开启联网/);
    expect(resolveCapabilities({ externalNetwork: 'on', allowedNetworkDomains: ['example.com'] }).allowedNetworkDomains).toEqual(['example.com']);
    expect(() => resolveCapabilities({ externalNetwork: 'on', allowedNetworkDomains: ['bad domain;'] })).toThrow();
    expect(() => resolveCapabilities({ constructionMode: 'yolo' as never })).toThrow(/施工模式/);
  });
  it('永远不能授予凭证访问；非法取值被拒绝', () => {
    expect(() => resolveCapabilities({ credentialAccess: 'all' as never })).toThrow(/凭证/);
    expect(() => resolveCapabilities({ fileAccess: 'anywhere' as never })).toThrow();
    expect(() => resolveCapabilities({ grantedMcp: [''] })).toThrow();
  });
  it('计划默认带最小权限能力；执行体收到的就是计划里的能力', async () => {
    const repo = await makeRepo();
    let seen: unknown;
    const inner = new FakeExecutor([{ do: 'exit', code: 0 }]);
    const executor = Object.assign(Object.create(inner), {
      start: (o: Parameters<FakeExecutor['start']>[0]) => {
        seen = o.capabilities;
        return inner.start(o);
      },
    }) as FakeExecutor;
    const runner = new TaskRunner({ repo, executor, runChecks: false });
    const t0 = await runner.create('x');
    const t = await runner.setPlan(t0.id, { goal: 'g', inScope: [], outOfScope: [], criteria: [], risks: [], irreversible: [] });
    expect(t.plan?.capabilities).toEqual(resolveCapabilities());
    await runner.approve(t0.id);
    await runner.start(t0.id);
    expect(seen).toEqual(resolveCapabilities());
    await expect(runner.setPlan(t0.id, { goal: 'g', inScope: [], outOfScope: [], criteria: [], risks: [], irreversible: [], capabilities: { credentialAccess: 'x' as never } })).rejects.toThrow();
  });
});

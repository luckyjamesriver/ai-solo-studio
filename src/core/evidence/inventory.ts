import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../git/git.js';
import { pathIdentityHash } from './model.js';
import type { ConfigFileFingerprint, DetectedTestRunner, ScopeAssessment, ScopeDelta, TestInventory, TestInventoryFile } from './model.js';

/**
 * 测试范围清单与完整性指纹（AISS-A1）。
 *
 * 目的：判断执行体是否削弱了已有测试覆盖（删除测试文件、减少测试块、减少断言、增加 skip/only、替换配置或运行器）。
 * 基线不是「上一次 AI 运行的结果」，而是**任务副本的基线提交**（开工时的 WT.baseSha），因此执行体无法通过
 * 事后再改一次来伪造基线。合法新增与修订测试不会被判为削弱；只有相对基线变少/被跳过/被排除才会。
 */

/** 可能是测试文件的路径模式（Vitest 默认 glob 及常见约定）。 */
const TEST_FILE_RE = /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.[cm]?[jt]sx?$/i;
// docs/ 里可能有文档示例源码（例如 *.test.ts 片段），测试运行器不会执行它们；
// 不计入“测试范围”否则会把文档示例误当成测试覆盖。
const SKIP_DIRS = new Set(['node_modules', '.git', '.studio', 'dist', 'dist-electron', 'build', 'coverage', 'out', '.next', '.cache', 'docs']);

/** vitest / vite / jest 的配置文件候选（按优先级）。 */
const CONFIG_CANDIDATES = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.cts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
  'vite.config.mjs',
  'jest.config.js',
  'jest.config.ts',
  'jest.config.mjs',
  'jest.config.cjs',
];

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function sha256Bytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function shortHash(text: string, len = 16): string {
  return sha256Text(text).slice(0, len);
}

/** 过滤出测试文件路径（相对路径，统一用 /）。 */
export function isTestFilePath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('..')) return false;
  if (/\.d\.[cm]?ts$/.test(relPath)) return false;
  return TEST_FILE_RE.test(relPath);
}

const SUPPORT_DIR_RE = /(^|\/)(?:tests?|__tests__|e2e|spec|fixtures|__fixtures__)(\/|$)/;

/** 测试辅助文件：位于测试目录下、但不是测试用例文件（helpers / fixtures / setup / 数据文件等）。 */
export function isTestSupportPath(relPath: string): boolean {
  if (!relPath || isTestFilePath(relPath)) return false;
  return SUPPORT_DIR_RE.test(relPath);
}

/** 遍历工作树内的普通文件（跳过内部缓存与依赖目录）。 */
async function walkAllFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  };
  await walk('');
  return out.sort();
}

async function walkTestFiles(dir: string): Promise<string[]> {
  return (await walkAllFiles(dir)).filter(isTestFilePath);
}

async function loadSupportFiles(dir: string): Promise<{ path: string; sha256: string }[]> {
  const out: { path: string; sha256: string }[] = [];
  for (const rel of await walkAllFiles(dir)) {
    if (!isTestSupportPath(rel)) continue;
    try {
      out.push({ path: rel, sha256: sha256Bytes(await fs.readFile(path.join(dir, rel))) });
    } catch {
      // 读取失败不伪造：跳过该文件（缺失会在与基线对比时体现为差异）
    }
  }
  return out;
}

interface ParsedTestFile {
  testBlocks: number;
  assertions: number;
  skipMarkers: number;
  onlyMarkers: number;
  todoMarkers: number;
  testNames: string[];
}

const TEST_BLOCK_RE = /\b(?:it|test|specify)(?:\.(?:concurrent|fails|each|for|skip|todo|only|runIf|skipIf|mock|extend))?\s*(?:<[^>]*>)?\s*\(/g;
const ASSERTION_RE = /\bexpect\s*(?:\.\w+)*\s*\(|\bassert(?:\.\w+)?\s*\(/g;
const SKIP_MARKER_RE = /\.(?:skip|skipIf|todo)\s*(?:\(|\.)|\bx(?:it|describe|test)\s*\(/g;
const ONLY_MARKER_RE = /\.only\s*(?:\(|\.)|\bf(?:it|describe|test)\s*\(/g;
const TODO_MARKER_RE = /\.todo\s*\(/g;
const TEST_NAME_RE = /\b(?:it|test|specify)(?:\.(?:concurrent|fails|each|for|skip|todo|only|runIf|skipIf))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** 解析一份测试源码：测试块、断言、skip/only/todo 标记与测试名称。 */
export function parseTestSource(content: string): ParsedTestFile {
  const blanked = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const testNames: string[] = [];
  for (const m of content.matchAll(TEST_NAME_RE)) {
    const name = (m[2] ?? '').trim().slice(0, 200);
    if (name) testNames.push(name);
  }
  return {
    testBlocks: (blanked.match(TEST_BLOCK_RE) ?? []).length,
    assertions: (blanked.match(ASSERTION_RE) ?? []).length,
    skipMarkers: (blanked.match(SKIP_MARKER_RE) ?? []).length,
    onlyMarkers: (blanked.match(ONLY_MARKER_RE) ?? []).length,
    todoMarkers: (blanked.match(TODO_MARKER_RE) ?? []).length,
    testNames,
  };
}

function inventoryDigest(files: TestInventoryFile[]): string {
  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => [f.path, f.sha256, f.testBlocks, f.assertions, f.skipMarkers, f.onlyMarkers, f.todoMarkers].join(':'));
  return sha256Text(canonical.join('\n'));
}

function summarize(files: TestInventoryFile[], supportFiles: { path: string; sha256: string }[] = []): TestInventory {
  const sum = (k: 'testBlockCount' | 'assertionCount' | 'skipMarkerCount' | 'onlyMarkerCount' | 'todoMarkerCount', pick: (f: TestInventoryFile) => number) =>
    files.reduce((acc, f) => acc + pick(f), 0);
  const supportDigest = sha256Text([...supportFiles].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => `${f.path}:${f.sha256}`).join('\n'));
  return {
    files,
    supportFiles,
    testFileCount: files.length,
    testBlockCount: sum('testBlockCount', (f) => f.testBlocks),
    assertionCount: sum('assertionCount', (f) => f.assertions),
    skipMarkerCount: sum('skipMarkerCount', (f) => f.skipMarkers),
    onlyMarkerCount: sum('onlyMarkerCount', (f) => f.onlyMarkers),
    todoMarkerCount: sum('todoMarkerCount', (f) => f.todoMarkers),
    digest: inventoryDigest(files),
    supportDigest,
  };
}

/** 扫描工作目录（任务副本）中的测试文件，得到当前测试范围清单。 */
export async function scanTestInventory(dir: string): Promise<TestInventory> {
  const relPaths = await walkTestFiles(dir);
  const files: TestInventoryFile[] = [];
  for (const rel of relPaths) {
    let buf: Buffer;
    try {
      buf = await fs.readFile(path.join(dir, rel));
    } catch {
      continue;
    }
    const parsed = parseTestSource(buf.toString('utf8'));
    files.push({
      path: rel,
      sha256: sha256Bytes(buf),
      testBlocks: parsed.testBlocks,
      assertions: parsed.assertions,
      skipMarkers: parsed.skipMarkers,
      onlyMarkers: parsed.onlyMarkers,
      todoMarkers: parsed.todoMarkers,
      testNames: parsed.testNames,
    });
  }
  return summarize(files, await loadSupportFiles(dir));
}

/**
 * 从 Git 提交（任务基线提交）读取测试范围清单。执行体无法篡改历史提交，
 * 因此这是判断「已有测试覆盖是否被削弱」的可信基线。
 */
export async function scanTestInventoryFromTree(dir: string, rev: string): Promise<TestInventory> {
  if (!/^[0-9a-f]{40}$/.test(rev)) return summarize([]);
  let listing = '';
  try {
    // -z 输出以 NUL 分隔，避免文件名含空格/引号时解析错误
    listing = await git(dir, ['ls-tree', '-r', '-z', '--name-only', rev]);
  } catch {
    return summarize([]);
  }
  const all = listing.split('\0').filter(Boolean);
  const files: TestInventoryFile[] = [];
  for (const rel of all) {
    if (!isTestFilePath(rel)) continue;
    let content: string;
    try {
      content = await git(dir, ['show', `${rev}:${rel}`]);
    } catch {
      continue;
    }
    const parsed = parseTestSource(content);
    files.push({
      path: rel,
      sha256: sha256Text(content),
      testBlocks: parsed.testBlocks,
      assertions: parsed.assertions,
      skipMarkers: parsed.skipMarkers,
      onlyMarkers: parsed.onlyMarkers,
      todoMarkers: parsed.todoMarkers,
      testNames: parsed.testNames,
    });
  }
  const supportFiles: { path: string; sha256: string }[] = [];
  for (const rel of all) {
    if (!isTestSupportPath(rel)) continue;
    try {
      supportFiles.push({ path: rel, sha256: sha256Text(await git(dir, ['show', `${rev}:${rel}`])) });
    } catch {
      // 该提交没有这个文件
    }
  }
  return summarize(files, supportFiles);
}

/** 读取存在的测试配置文件指纹。 */
export async function readConfigFingerprints(dir: string): Promise<ConfigFileFingerprint[]> {
  const out: ConfigFileFingerprint[] = [];
  for (const rel of CONFIG_CANDIDATES) {
    try {
      const buf = await fs.readFile(path.join(dir, rel));
      out.push({ path: rel, sha256: sha256Bytes(buf) });
    } catch {
      // 不存在则跳过
    }
  }
  return out;
}

/** 从 Git 基线提交读取配置文件指纹。 */
export async function readConfigFingerprintsFromTree(dir: string, rev: string): Promise<ConfigFileFingerprint[]> {
  if (!/^[0-9a-f]{40}$/.test(rev)) return [];
  const out: ConfigFileFingerprint[] = [];
  for (const rel of CONFIG_CANDIDATES) {
    try {
      const content = await git(dir, ['show', `${rev}:${rel}`]);
      out.push({ path: rel, sha256: sha256Text(content) });
    } catch {
      // 该提交没有这个配置文件
    }
  }
  return out;
}

export async function readPackageLockDigest(dir: string): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(path.join(dir, 'package-lock.json'));
    return sha256Bytes(buf);
  } catch {
    return undefined;
  }
}

export async function readPackageLockDigestFromTree(dir: string, rev: string): Promise<string | undefined> {
  if (!/^[0-9a-f]{40}$/.test(rev)) return undefined;
  try {
    return sha256Text(await git(dir, ['show', `${rev}:package-lock.json`]));
  } catch {
    return undefined;
  }
}

/** 测试脚本是否是「可安全追加宿主报告器参数」的 Vitest 调用（无 shell 组合、无管道重定向）。 */
export function parseVitestScript(script: string): { vitest: boolean; argsAppendable: boolean } | null {
  const s = script.trim();
  if (!s) return null;
  // 含 shell 组合/重定向/命令替换：追加参数会落到错误的命令上，且可能吞掉失败退出码 → 不得视为可信结构化采集
  const shellCombined = /[;&|`$<>]|&&|\|\|/.test(s);
  // 支持 `vitest ...`、`.bin/vitest ...`、`node_modules/.bin/vitest ...`，以及直接执行包内入口
  // `.../node_modules/vitest/vitest.mjs ...`（测试夹具用绝对路径调用真实运行器时就是这一种）。
  const isVitest = /^(?:\S*\/)?(?:node_modules\/\.bin\/|\.bin\/)?vitest(?:\.mjs|\.js)?(?:\s|$)/.test(s);
  if (!isVitest) return { vitest: false, argsAppendable: false };
  return { vitest: true, argsAppendable: !shellCombined };
}

/** 从脚本中显式写出的 vitest 路径推断 node_modules 根目录（用于 fixtures / 非标准安装位置）。 */
function nodeModulesFromScript(script: string): string | undefined {
  const m = script.match(/(\S*?)\/node_modules\/(?:\.bin\/)?vitest(?:\/vitest\.m?js)?(?:\s|$)/);
  if (!m) return undefined;
  const base = m[1];
  return base && base !== '' ? `${base}/node_modules` : 'node_modules';
}

/** 读取某个已安装包的 package.json 摘要（用于运行器入口/依赖完整性）。 */
async function packageIdentity(nodeModulesRoot: string, name: string): Promise<{ name: string; version: string; packageJsonSha256: string } | undefined> {
  try {
    const pkgPath = path.join(nodeModulesRoot, ...name.split('/'), 'package.json');
    const buf = await fs.readFile(pkgPath);
    const pkg = JSON.parse(buf.toString('utf8')) as { version?: string };
    return { name, version: typeof pkg.version === 'string' ? pkg.version : 'unknown', packageJsonSha256: sha256Bytes(buf) };
  } catch {
    return undefined;
  }
}

const RUNNER_DEPS = ['vite', '@vitest/runner'] as const;

async function finishDetected(
  nodeModulesRoot: string,
  pkg: { version?: string },
  buf: Buffer,
  script: string,
  argsAppendable: boolean,
): Promise<DetectedTestRunner> {
  const entryFile = path.join(nodeModulesRoot, 'vitest', 'vitest.mjs');
  let entry: { pathHash: string; sha256: string } | undefined;
  try {
    entry = { pathHash: pathIdentityHash(entryFile), sha256: sha256Bytes(await fs.readFile(entryFile)) };
  } catch {
    entry = undefined;
  }
  const deps: { name: string; version: string; packageJsonSha256: string }[] = [];
  for (const name of RUNNER_DEPS) {
    const id = await packageIdentity(nodeModulesRoot, name);
    if (id) deps.push(id);
  }
  return {
    name: 'vitest',
    version: typeof pkg.version === 'string' ? pkg.version : 'unknown',
    packageJsonSha256: sha256Bytes(buf),
    ...(entry ? { entry } : {}),
    deps,
    script,
    argsAppendable,
  };
}

/** 解析项目实际使用的测试运行器（目前完整支持 Vitest；其他运行器仅记录命令级结果）。 */
export async function detectTestRunner(dir: string, script: string): Promise<DetectedTestRunner | undefined> {
  const parsed = parseVitestScript(script);
  if (!parsed?.vitest) return undefined;
  // 1) 脚本里显式写了 vitest 路径（绝对/相对）：直接按它推断 node_modules
  const explicit = nodeModulesFromScript(script);
  if (explicit) {
    const base = path.isAbsolute(explicit) ? explicit : path.resolve(dir, explicit);
    const pkgPath = path.join(base, 'vitest', 'package.json');
    try {
      const buf = await fs.readFile(pkgPath);
      const pkg = JSON.parse(buf.toString('utf8')) as { version?: string };
      return await finishDetected(base, pkg, buf, script, parsed.argsAppendable);
    } catch {
      // 继续按 node 解析规则向上找
    }
  }
  // 2) 任务副本通常没有自己的 node_modules：Node 解析会向上找到主项目的 node_modules，
  // 这里按同一规则向上查找，才能拿到执行体实际会加载的那一份运行器身份。
  let probe = path.resolve(dir);
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = path.join(probe, 'node_modules', 'vitest', 'package.json');
    try {
      const buf = await fs.readFile(pkgPath);
      const pkg = JSON.parse(buf.toString('utf8')) as { version?: string };
      return await finishDetected(path.join(probe, 'node_modules'), pkg, buf, script, parsed.argsAppendable);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return undefined;
}

/**
 * 对比「基线测试范围」与「当前测试范围」。
 * 判定为 weakened 的条件（任何一项）：
 * - 测试文件被删除（基线存在、当前不存在）；
 * - 测试块总数或任一文件测试块数减少；
 * - 断言总数或任一文件断言数减少；
 * - 测试名称被删除；
 * - skip/todo 标记增加；
 * - 出现 `.only`（会只跑一部分测试）而基线没有。
 * 仅新增文件/测试/断言、删除 skip 标记 → stronger（不阻断）。
 * 配置文件、runner 版本、锁文件变化 → 单独归类（配置/运行器变化必须重新确认）。
 */
export function assessScopeChange(opts: {
  baseline: TestInventory;
  current: TestInventory;
  baselineConfigs: ConfigFileFingerprint[];
  currentConfigs: ConfigFileFingerprint[];
  baselineLock?: string | undefined;
  currentLock?: string | undefined;
  baselineRunner?: { name: string; version: string; packageJsonSha256: string } | undefined;
  currentRunner?: { name: string; version: string; packageJsonSha256: string } | undefined;
  baselineScriptsDigest?: string | undefined;
  currentScriptsDigest?: string | undefined;
  /** 报告里实际执行到的测试文件（相对工作树根）；用于防止只跑一部分测试仍取得可信 PASS */
  executedFiles?: string[] | undefined;
}): ScopeAssessment {
  const base = opts.baseline;
  const cur = opts.current;
  const method: ScopeAssessment['method'] = 'conservative-static';
  if (base.testFileCount === 0 && cur.testFileCount === 0) {
    return { kind: 'not_assessed', baselineAvailable: false, reasons: ['基线与当前都没有测试文件，无法评估测试范围。'], method: 'none' };
  }
  const reasons: string[] = [];
  const weakened: string[] = [];
  const review: string[] = [];
  const byPath = new Map(cur.files.map((f) => [f.path, f]));
  const baseByPath = new Map(base.files.map((f) => [f.path, f]));
  const filesRemoved: string[] = [];
  const filesAdded: string[] = [];
  const testsRemoved: string[] = [];
  const testFilesModified: string[] = [];
  const perFileAssertionDrops: { path: string; from: number; to: number }[] = [];
  let assertionsDelta = 0;
  let testBlocksDelta = 0;

  for (const bf of base.files) {
    const cf = byPath.get(bf.path);
    if (!cf) {
      filesRemoved.push(bf.path);
      weakened.push(`测试文件被删除：${bf.path}`);
      continue;
    }
    // 逐文件比较：任何单文件下降都必须独立成立，不能被其它文件的新增抵消
    if (cf.testBlocks < bf.testBlocks) {
      testBlocksDelta += cf.testBlocks - bf.testBlocks;
      weakened.push(`测试块减少：${bf.path}（${bf.testBlocks} → ${cf.testBlocks}）`);
    } else if (cf.testBlocks > bf.testBlocks) {
      testBlocksDelta += cf.testBlocks - bf.testBlocks;
    }
    if (cf.assertions < bf.assertions) {
      assertionsDelta += cf.assertions - bf.assertions;
      perFileAssertionDrops.push({ path: bf.path, from: bf.assertions, to: cf.assertions });
      weakened.push(`断言减少：${bf.path}（${bf.assertions} → ${cf.assertions}）`);
    } else if (cf.assertions > bf.assertions) {
      assertionsDelta += cf.assertions - bf.assertions;
    }
    const curNames = new Set(cf.testNames);
    const removed = bf.testNames.filter((n) => !curNames.has(n));
    if (removed.length) {
      testsRemoved.push(...removed.map((n) => `${bf.path} :: ${n}`));
      weakened.push(`测试用例被删除：${bf.path}（${removed.slice(0, 3).join(' / ')}${removed.length > 3 ? ' …' : ''}）`);
    }
    if (cf.skipMarkers > bf.skipMarkers) weakened.push(`跳过标记增加：${bf.path}（${bf.skipMarkers} → ${cf.skipMarkers}）`);
    if (cf.onlyMarkers > bf.onlyMarkers) weakened.push(`出现 .only（只运行部分测试）：${bf.path}`);
    // 已存在的测试文件内容发生变化（含断言逻辑、条件跳过等）：
    // 静态分析无法证明语义未削弱 → 保守进入「待确认」，绝不算 assessed_unchanged。
    if (cf.sha256 !== bf.sha256) testFilesModified.push(bf.path);
  }
  for (const cf of cur.files) if (!baseByPath.has(cf.path)) filesAdded.push(cf.path);
  const skipMarkerDelta = cur.skipMarkerCount - base.skipMarkerCount;
  const onlyMarkerDelta = cur.onlyMarkerCount - base.onlyMarkerCount;

  // 辅助文件（helpers/fixtures/setup/数据）变化同样需要保守复核
  const baseSupport = new Map(base.supportFiles.map((f) => [f.path, f.sha256]));
  const curSupport = new Map(cur.supportFiles.map((f) => [f.path, f.sha256]));
  const supportFilesChanged: string[] = [];
  for (const [p, sha] of curSupport) {
    const b = baseSupport.get(p);
    if (b === undefined) supportFilesChanged.push(`${p}（新增）`);
    else if (b !== sha) supportFilesChanged.push(`${p}（改变）`);
  }
  for (const p of baseSupport.keys()) if (!curSupport.has(p)) supportFilesChanged.push(`${p}（删除）`);

  const configChanged: string[] = [];
  const baseCfg = new Map(opts.baselineConfigs.map((c) => [c.path, c.sha256]));
  const curCfg = new Map(opts.currentConfigs.map((c) => [c.path, c.sha256]));
  for (const [p, sha] of curCfg) {
    const b = baseCfg.get(p);
    if (b === undefined) configChanged.push(`${p}（新增）`);
    else if (b !== sha) configChanged.push(`${p}（改变）`);
  }
  for (const p of baseCfg.keys()) if (!curCfg.has(p)) configChanged.push(`${p}（删除）`);

  const runnerChanged = opts.baselineRunner !== undefined
    && (opts.currentRunner === undefined
      || opts.baselineRunner.name !== opts.currentRunner.name
      || opts.baselineRunner.version !== opts.currentRunner.version
      || opts.baselineRunner.packageJsonSha256 !== opts.currentRunner.packageJsonSha256);
  const lockfileChanged = !!opts.baselineLock !== !!opts.currentLock || (!!opts.baselineLock && opts.baselineLock !== opts.currentLock);
  const scriptsChanged = !!opts.baselineScriptsDigest !== !!opts.currentScriptsDigest || (!!opts.baselineScriptsDigest && opts.baselineScriptsDigest !== opts.currentScriptsDigest);

  // 实际执行范围 vs 预期范围：报告必须覆盖全部预期测试文件，否则可能只跑了部分测试
  let executedScope: ScopeDelta['executedScope'];
  if (opts.executedFiles) {
    const expected = cur.files.map((f) => f.path).sort();
    const executedSet = new Set(opts.executedFiles);
    const missing = expected.filter((p) => !executedSet.has(p));
    executedScope = { expectedFiles: expected.length, executedFiles: executedSet.size, missing: missing.slice(0, 20) };
    if (missing.length) review.push(`报告只执行了 ${executedSet.size}/${expected.length} 个测试文件，缺少：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ' …' : ''}`);
  }

  if (testFilesModified.length) review.push(`已有测试文件内容发生变化（静态分析无法证明语义未削弱）：${testFilesModified.slice(0, 5).join('、')}${testFilesModified.length > 5 ? ' …' : ''}`);
  if (supportFilesChanged.length) review.push(`测试辅助文件/夹具发生变化：${supportFilesChanged.slice(0, 5).join('、')}${supportFilesChanged.length > 5 ? ' …' : ''}`);
  if (configChanged.length) review.push(`测试配置被修改：${configChanged.join('、')}`);
  if (runnerChanged) review.push('测试运行器被替换或版本改变。');
  if (lockfileChanged) review.push('依赖锁文件被修改（运行器可能被替换）。');
  if (scriptsChanged) review.push('测试/构建脚本被修改。');

  reasons.push(...weakened, ...review);
  const delta: ScopeDelta = {
    filesRemoved,
    filesAdded,
    testsRemoved,
    perFileAssertionDrops,
    assertionsDelta,
    testBlocksDelta,
    skipMarkerDelta,
    onlyMarkerDelta,
    configChanged,
    testFilesModified,
    supportFilesChanged,
    runnerChanged,
    lockfileChanged,
    scriptsChanged,
    ...(executedScope ? { executedScope } : {}),
  };

  const isWeakened = weakened.length > 0 || filesRemoved.length > 0 || testsRemoved.length > 0
    || base.testBlockCount > cur.testBlockCount || base.assertionCount > cur.assertionCount
    || skipMarkerDelta > 0 || onlyMarkerDelta > 0;
  if (isWeakened) return { kind: 'assessed_weakened', baselineAvailable: true, reasons, delta, method };
  if (review.length > 0) return { kind: 'assessed_needs_review', baselineAvailable: true, reasons, delta, method };
  const stronger = cur.testFileCount > base.testFileCount || cur.testBlockCount > base.testBlockCount || cur.assertionCount > base.assertionCount || cur.skipMarkerCount < base.skipMarkerCount;
  return { kind: stronger ? 'assessed_stronger' : 'assessed_unchanged', baselineAvailable: true, reasons, delta, method };
}

export interface ScopeFingerprintOptions {
  scriptsDigest?: string;
  packageLockDigest?: string;
  executedFiles?: string[];
  executionCounts?: { passed: number; failed: number; skipped: number; total: number };
}

export function scopeFingerprint(
  inv: TestInventory,
  configs: ConfigFileFingerprint[],
  runner?: { version: string; packageJsonSha256: string },
  extra?: ScopeFingerprintOptions,
): string {
  const cfg = [...configs].sort((a, b) => (a.path < b.path ? -1 : 1)).map((c) => `${c.path}:${c.sha256}`).join(',');
  const executed = extra?.executedFiles ? [...extra.executedFiles].sort().join(',') : '-';
  const counts = extra?.executionCounts ? `${extra.executionCounts.total}:${extra.executionCounts.passed}:${extra.executionCounts.failed}:${extra.executionCounts.skipped}` : '-';
  const parts = [
    inv.digest,
    cfg,
    runner ? `${runner.version}:${runner.packageJsonSha256}` : 'none',
    extra?.scriptsDigest ?? '-',
    extra?.packageLockDigest ?? '-',
    executed,
    counts,
  ];
  return sha256Text(parts.join('|')).slice(0, 32);
}

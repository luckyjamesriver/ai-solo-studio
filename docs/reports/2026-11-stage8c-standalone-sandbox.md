# 阶段 8C 完成报告 · 脱离 Codex 的独立沙箱检查器

> 日期：2026-11-12  
> 分支：`rebuild`（基准：`a8d8223`）  
> 依据：`docs/plans/2026-11-11-multi-executor.md`（阶段 8C）、`docs/adr/0010-multi-executor-and-opt-in-subscriptions.md`（§2 红线 #4）

---

## 一、交付提交清单（功能与修复）

| 提交 | 内容摘要 |
| --- | --- |
| `f3365da` | `feat(sandbox)`: 新增脱离 Codex 的 macOS Seatbelt 运行器 `SeatbeltSandboxRunner` 与跨平台工厂 `createStandaloneSandboxRunner`，配套 3 组单元与真实 macOS Seatbelt 哨兵测试（`tests/stage8c-seatbelt.test.ts`）。 |
| `9299a4c` | `feat(sandbox)`: 将独立检查沙箱接入 `TaskRunner`（`fallbackSandboxRunner`）、`TaskController`、`src/main/index.ts`、`GlobalAiSettingsView` 与 `SettingsPage`（`独立受限检查环境`），补充控制器集成测试（`tests/stage8c-controller.test.ts`）、`tests/security.test.ts` 阶段 8C 安全基线及 Electron E2E + 4 张界面截图。 |
| `a9c3ed6` | `fix(settings)`: 为 `App.tsx` 的 `aiSettings` 异步刷新路径增加 `aiSettingsSeqRef` 递增序列号防乱序覆盖，并将主进程 `SUB_PROBE_TTL_MS` 从 30 秒提升至 5 分钟（保留显式失效触发），解决慢速 CLI 探测返回晚于配置修改引发的状态闪烁。 |

---

## 二、核心实现与安全边界

### 1. macOS 独立 Seatbelt 检查运行器（`src/core/executor/sandbox/seatbelt.ts`）

- 实现 `SandboxCommandRunner` 接口，直接通过 `/usr/bin/sandbox-exec`（`DEFAULT_SANDBOX_EXEC_PATH`，`shell: false`）执行 `runCheck` 下发的构建与测试命令，**完全不依赖 Codex CLI 安装、登录态或 `command/exec`**。
- 路径规范化与控制字符拦截（`canonicalizeSandboxPaths`）：
  - 拒绝包含 `\0` / `\r` / `\n` 的路径或规则。
  - 同时纳入绝对路径与穿透已存在祖先目录符号链接解析出的物理路径（保证 `/tmp` ↔ `/private/tmp`、`/var` ↔ `/private/var` 在 Seatbelt SBPL 中双向一致生效）。
- 最小权限 SBPL 策略（`buildSeatbeltProfile`）：
  - 以 `(deny default)` 起步，放行运行期所需最小系统能力与默认文件读取，同时通过 `(deny file-read* ...)` 拦截 `sensitiveFallbackList(os.homedir())`（如 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.npmrc` 等）。
  - 写入权限严格限定为任务副本 `cwd`、`caps.extraWritableDirs`（以及 `/dev/null`、`/dev/dtracehelper`），并显式添加 `(deny file-write* (literal ".../.git") (subpath ".../.git"))` 防止检查脚本篡改 Git 元数据或逃逸修改主仓库。
  - 网络策略：当 `externalNetwork === 'off'` 时强制 `(deny network*)`；仅当 `externalNetwork === 'on'` 且无域名白名单限制时允许 `(allow network*)`。
  - **严格失败关闭（Fail-Closed）**：
    - 当 `allowedNetworkDomains.length > 0`（Seatbelt 无 TLS 域名代理过滤能力）、非 macOS 平台、`/usr/bin/sandbox-exec` 不可执行、参数异常或超时中断之外的启动错误时，一律返回 `{ status: 'unavailable', reason }`，绝不静默回退到无沙箱宿主直跑。
    - `constructionMode === 'full_trust'`（且非只读）进入 `fullTrust` 前，必须先通过 `buildFullTrustMode(taskId, cwd, fullTrustRecords)` 核验，先于 `buildSeatbeltProfile(..., fullTrust)` 执行。

### 2. 跨平台工厂与降级（`src/core/executor/sandbox/index.ts`）

- `createStandaloneSandboxRunner`：
  - `platform !== 'darwin'`：直接返回 `{ runner: undefined, status: { available: false, kind: 'none', label: '当前平台不可用', ... } }`；
  - `darwin`：实例化 `SeatbeltSandboxRunner` 并调用 `detect()` 执行真实 `sandbox-exec -p <probe> /bin/echo ok` 自检；通过才返回 `runner` 与 `kind: 'seatbelt'`（`可用（独立受限检查）`）。
- 链路联动结果：当既无 Codex 沙箱又无独立沙箱（如 Linux 且未配备 Codex）时，`runProjectChecks` 诚实标为 `not_available`（原因含 `sandbox_unavailable`），验收项为「无法运行」，保存走「需要确认未检查项（`unchecked_needs_confirm`）」，**绝不跳过沙箱在宿主直接运行项目脚本**。

### 3. 全链路接入与界面展示

- `src/core/task/runner.ts`：`RunnerOptions` 新增 `fallbackSandboxRunner?: SandboxCommandRunner`；当选中执行者未自带可用 `sandboxRunner`（例如 `api:*` / `sub:*` / 外部交接 `external`）且存在可用 `fallbackSandboxRunner` 时，使用独立沙箱执行自动 `build`/`test` 检查；对于真实 `codex` 执行者自身任务，仍保留其自身（及显式注入的）检查通道而不被覆盖。
- `src/core/app/task-controller.ts` & `src/main/index.ts`：
  - 主进程缓存并暴露 `getStandaloneSandbox()`，在 `health()` 刷新时重测；
  - `resolveNonCodexSandboxRunner()` 为非 Codex 执行者提供优先级：「可用独立 Seatbelt 沙箱 → 已配妥的 Codex 沙箱（如测试环境或仅依赖 Codex 检查的环境）→ `undefined`」；
  - `GlobalAiSettingsView` 新增 `standaloneSandbox?: StandaloneSandboxStatus`，传给前端设置页。
- `src/renderer/SettingsPage.tsx` & `src/core/executor/cli/subscriptions.ts`：
  - 「已接入的 AI」新增 `data-testid="ai-status-check-runner"` 状态行（标签 `data-testid="check-runner-tag"`），使用面向普通用户的中文描述（标题「独立受限检查环境」），零 `INTERNAL_WORDS` 泄露；
  - 更新 `claude_cli` / `agy` 的 `isolationHonesty` 说明文案，对齐「独立受限检查环境」。

---

## 三、哨兵与集成验证摘要

### 1. macOS 真实 Seatbelt 哨兵测试（`tests/stage8c-seatbelt.test.ts`）

在真实 macOS 临时目录与 Git worktree 上通过 `/usr/bin/sandbox-exec` 实测以下 9 项约束全部成立（非 macOS 平台通过 `macIt` 自动跳过真实二进制段落，同时保留跨平台兜底单测必跑）：
1. 读取被拦截目录 `~/.ssh/id_rsa` → 进程非 0 退出（`EPERM` / `not permitted`）。
2. 向主仓库路径写入逃逸文件 → 非 0 退出且目标文件不存在。
3. 向 worktree 内 `.git` 写入 → 非 0 退出。
4. 向 worktree 内正常文件写入 → 退出码 0 且内容写入成功。
5. 默认 `externalNetwork: 'off'` 下访问本地测试 HTTP 服务 → 失败（退出码 42）。
6. 开启 `externalNetwork: 'on'` 后访问同一本地服务 → 成功（退出码 0）。
7. 直接调用 `runCheck(worktree, 'build', runner)` 与 `runCheck(worktree, 'test', runner)` 完成真实 `npm run build` / `node --test` 检验。
8. 超时命令被准确中止并返回 `timedOut: true`。
9. `extraWritableDirs` 显式授权目录可写入，同时未授权的主仓库仍被拦截。

### 2. 控制器与 E2E 闭环（`tests/stage8c-controller.test.ts` & `e2e/shell.e2e.ts`）

- **Linux / 无可用沙箱测试**：Mock 注入 `Codex` 禁用且 `fallbackSandboxRunner: undefined`，确认任务完成后 `build`/`test` 均未在宿主执行，状态为 `unavailable`（`sandbox_unavailable`），保存被拦在 `unchecked_needs_confirm`。
- **macOS 无 Codex 直通保存集成与 Electron E2E**：构造一旦触碰 `CodexExecutor.prototype.execInSandbox` 或 `.start` 即抛错的守护，确认：
  - 设置页在 Codex 标红「不可用」的同时，`ai-status-check-runner` 标绿显示「可用（独立受限检查）」；
  - 使用 DeepSeek API 执行者修改代码后，由独立 Seatbelt 自动跑通 `build` 与 `test`，验收依据显示「沙箱环境」与 `node --test` 用例详情；
  - 确认整体验收后点击「验收通过并保存」直接进入 `save-result-panel[data-outcome="saved"]`，全程不弹出 `unchecked-confirm-panel`。

---

## 四、`tests/security.test.ts` 阶段 8C 变更（Verbatim Diff，只增不减）

```diff
--- a/tests/security.test.ts
+++ b/tests/security.test.ts
@@ -1272,4 +1272,27 @@ describe('安全基线（防回归）', () => {
       expect(main).toMatch(/ipcMain\.handle\('subscriptions:testAndEnable'[\s\S]*?obj\.riskAck === true/);
     });
   });
+
+  describe('阶段 8C：脱离 Codex 的独立沙箱检查运行器安全边界（只增不减）', () => {
+    it('SeatbeltSandboxRunner 绝不使用 shell: true 或未受控的 fullTrust；缺失/非 macOS 一律返回 unavailable；buildFullTrustMode 先于放行调用', () => {
+      const sbSrc = stripComments(read('src/core/executor/sandbox/seatbelt.ts'));
+      expect(sbSrc).not.toMatch(/shell:\s*true/);
+      expect(sbSrc).toContain('sensitiveFallbackList');
+      expect(sbSrc).toContain('await buildFullTrustMode(');
+      expect(sbSrc).toContain('(deny default)');
+      expect(sbSrc).toContain('(deny network*)');
+      expect(sbSrc).toContain('isDotGitPath');
+      expect(sbSrc).toMatch(/status:\s*'unavailable'/);
+      // 门禁位置：buildFullTrustMode 必须先于 buildSeatbeltProfile(..., fullTrust)
+      const runStart = sbSrc.indexOf('async runCommand(');
+      expect(runStart).toBeGreaterThan(-1);
+      const runBody = sbSrc.slice(runStart);
+      expect(runBody.indexOf('buildFullTrustMode(')).toBeGreaterThan(-1);
+      expect(runBody.indexOf('buildFullTrustMode(')).toBeLessThan(runBody.indexOf('buildSeatbeltProfile('));
+
+      const factorySrc = stripComments(read('src/core/executor/sandbox/index.ts'));
+      expect(factorySrc).toMatch(/platform !== 'darwin'/);
+      expect(factorySrc).toMatch(/available:\s*false/);
+    });
+  });
 });
```

---

## 五、视觉验收截图（`docs/screenshots/stage8c/`）

| 序号 | 截图文件 | 验收场景 |
| --- | --- | --- |
| 1 | `docs/screenshots/stage8c/01-settings-standalone-check-runner.png` | 设置页「已接入的 AI」：Codex 显示不可用，同时「独立受限检查环境」显示「可用（独立受限检查）」。 |
| 2 | `docs/screenshots/stage8c/02-acceptance-standalone-checks-passed.png` | 脱离 Codex 由 DeepSeek API 施工后，验收页自动完成构建与测试检查（状态「通过」，可进入保存）。 |
| 3 | `docs/screenshots/stage8c/03-proof-standalone-sandbox.png` | 检查依据页：运行环境标明「沙箱环境」，完整呈现构建输出与测试用例结果。 |
| 4 | `docs/screenshots/stage8c/04-save-result-checked-direct.png` | 保存结果页直接进入「已保存」并标明「检查通过」，未触发未检查确认弹窗。 |

---

## 六、本地全量验证结果（最终代码提交 `a9c3ed6` 后实跑）

| 命令 | 实际结果 |
| --- | --- |
| `npm run typecheck` | 通过（`tsc -p tsconfig.json --noEmit`，退出码 0） |
| `npx vitest run --maxWorkers=2` | **43 个常规测试文件 / 639 条测试全部通过**；12 个真机集成测试文件（`tests/integration/*.real.test.ts`，38 条）因未设置 `STUDIO_REAL_CODEX=1` 按预期跳过（总计 55 文件 / 677 用例，0 失败） |
| `npm run smoke` | 通过（`document.title`、零 Node 全局泄露、`window.studio` 完整白名单、`冒烟测试通过`） |
| `npm run test:e2e` | **1 个文件 / 54 条 Electron E2E 全部通过**（0 跳过、0 失败，耗时 `433.41s`） |

---

## 七、双平台 CI（GitHub Actions）

- 待推送 `rebuild` 并等待 `ubuntu-latest` 与 `macos-latest` 全部通过后回填 Run ID 与链接。

# 任务完成报告：consent.json 与交接清单接入统一写入服务

- **日期**：2026-11-09
- **分支**：`rebuild`
- **执行任务**：将外发告知确认记录（`consent.json`）与交接任务清单（`.studio/tasks/`）接入现有的统一持久化服务（`RecordStore`），对齐 CAS 修订号校验、JSONL 事件日志与启动对账恢复机制，清理直接读写绕过，补全测试并更新 ADR 文档。

---

## 1. 修改的文件清单及改动说明

| 文件路径 | 改动说明 |
| :--- | :--- |
| `src/core/persistence/consent.ts` | **新增**。定义 `CONSENT_COLLECTION`（集合名称 `'consent'`）与 `ConsentStore` 类，包装底层 `RecordStore`。实现带 CAS 修订号校验的 `record()`、`get()`、`has()`、`clear()`、`commit()` 操作。提供旧文件平滑兼容：若存在旧版 `.studio/consent.json`，在首次读取或记录时自动迁移进记录库并将原文件重命名为 `.studio/consent.json.migrated`。 |
| `src/core/persistence/manifest.ts` | **新增**。定义 `MANIFEST_COLLECTION`（集合名称 `'manifests'`）与 `ManifestStore` 类，包装底层 `RecordStore`。负责交接清单（`.studio/records/manifests/<taskId>.json`）的统一持久化，支持 CAS 提交、查询与列表，提交时自动向 `.studio/events.jsonl` 追加 `manifest_saved` 事件；提供旧文件平滑兼容：若存在 `.studio/tasks/<taskId>.json`，自动迁入记录库并将原文件重命名为 `.migrated`。 |
| `src/core/persistence/index.ts` | 导出 `ConsentStore`、`CONSENT_COLLECTION`、`CONSENT_RECORD_ID`、`ConsentRecord`、`ManifestStore`、`MANIFEST_COLLECTION`、`TaskManifest`、`SaveManifestOptions` 等接口与类型。 |
| `src/core/thinking/flow/support.ts` | 移除原先直接写入 `.studio/consent.json` 的原子文件写入实现，改为引用并重导出 `persistence/consent.ts` 中的 `ConsentStore`，消除对底层文件系统的绕过。 |
| `src/core/thinking/handoff/export.ts` | 移除直接写 `.studio/tasks/<taskId>.json` 的文件操作，改为调用 `ManifestStore.save()` 通过记录库提交，附加 `expectedRevision: 0` CAS 校验并在事件日志中留痕。 |
| `src/core/thinking/handoff/import.ts` | 移除直接通过 `fs.readFile` 读取 `.studio/tasks/<taskId>.json` 的旧逻辑，改为调用 `ManifestStore.get()` 从统一记录库中读取。 |
| `src/core/thinking/cli/main.ts` | 将思考层 CLI 中对任务清单的读取适配为 `new ManifestStore(projectRoot).get(args.task!)`，对资料外发权限的确认判断与记录适配为 `ConsentStore`。 |
| `tests/cli.test.ts` | 将测试用例中直接读取和删除 `.studio/consent.json` 磁盘文件的操作改为调用 `ConsentStore.get()` 与 `ConsentStore.clear()`。 |
| `tests/handoff.test.ts` | 将测试中对任务清单产物文件位置与内容的断言适配为统一记录库存储结构（路径为 `.studio/records/manifests/<taskId>.json`，且包含 `RecordEnvelope` 封套字段）。 |
| `tests/persistence.test.ts` | 补充针对 `ConsentStore` 与 `ManifestStore` 的 8 个高可靠性单元测试，覆盖并发冲突、Fencing 隔离、日志恢复与旧文件迁移。 |
| `docs/adr/0005-data-storage.md` | 更新第 8 节“实现状态”，把 `consent.json` 与交接清单从“与原定内容的差别”和“待办”中移除，并入“已改走记录库”列表，记录其实际位置与完成状态。 |
| `docs/PROJECT_CONTEXT.md` | 更新第 11 节“待决与开放问题”中的“数据存储待办”，将该项标为已完成。 |
| `e2e/shell.e2e.ts` | 修复端到端测试用例 `主项目有未保存修改：列出文件，不提供“帮我提交”` 中的异步时序问题：将原 `waitFor('save-reason')` 改为 `waitFor('save-files')`，避免因未确认状态下页面已存在 `save-reason` 元素导致尚未等待异步确认 IPC 返回就提前 evaluate 读取状态的偶发失败。 |

---

## 2. 新增测试及验证内容

在 `tests/persistence.test.ts` 中新增了 2 个 `describe` 测试套件，共 8 个测试用例：

### 2.1 ConsentStore（资料外发确认记录）
1. **CAS 校验与并发冲突**：
   - 验证两个并发修改者基于相同 `expectedRevision` 提交时，后提交者被拒绝并抛出 `StateConflictError`，且 `.studio/events.jsonl` 中如实记录 `conflict` 事件。
2. **旧运行编号隔离（Fencing）**：
   - 验证开工切换新 `runId` 之后，旧 `runId` 发起的迟到提交被拒绝（抛出 `StaleRunError`，日志记为 `stale_run`），保证旧执行体不会覆盖新状态。
3. **崩溃后从日志恢复**：
   - 模拟进程崩溃导致汇总目录 `.studio/records/` 整体丢失，重新启动 `ConsentStore` 时，启动对账逻辑自动根据 `.studio/events.jsonl` 事件流重建记录文件，验证其最终状态、键值与修订号与崩溃前 100% 一致。
4. **旧数据平滑迁移**：
   - 在项目根目录准备旧格式的 `.studio/consent.json` 文件，验证 `ConsentStore` 首次读取时能自动将其迁入记录库，并把旧文件重命名为 `.studio/consent.json.migrated` 保留备份。

### 2.2 ManifestStore（任务清单 / 交接清单）
1. **CAS 校验与并发冲突**：
   - 验证清单首次提交 `expectedRevision: 0` 成功变为 `revision: 1`；随后两个写入者均基于版本 1 尝试更新，后提交者抛出 `StateConflictError`，事件日志记录 `conflict`。
2. **旧运行编号隔离（Fencing）**：
   - 验证清单开工生成 `runId: run-1` 后，若新运行开工换为 `run-2`，旧 `run-1` 的更新请求被拒绝并抛出 `StaleRunError`。
3. **崩溃后从日志恢复**：
   - 模拟写入多个任务清单后删除 `.studio/records/` 目录，验证重新实例化 `ManifestStore` 后通过 `reconcile` 完整重建所有任务清单记录，清单字段与版本无损还原。
4. **旧数据平滑迁移**：
   - 模拟旧版存储路径 `.studio/tasks/<taskId>.json`，验证 `ManifestStore` 能够透明读取、迁入新目录并自动生成 `.migrated` 副本。

---

## 3. 全量测试结果（`npm test`）

执行 `npm test`（Vitest v5.0.5）的全量运行结果如下：

- **测试文件（Test Files）**：
  - 通过：**23** 个
  - 跳过：**11** 个（实际为 `tests/integration/` 下的 11 个真实 Codex 集成测试文件，非 `adr-0005-scenarios.test.ts`，详见下文第 7 节核对）
  - 失败：**0** 个
  - 文件总计：34 个
- **测试用例（Tests）**：
  - 通过：**502** 个（含新增的交接清单重复导出测试）
  - 跳过：**37** 个（为非真实模型环境下按 gate 规则条件跳过的集成用例）
  - 失败：**0** 个
  - 测试总计：539 个
- **执行耗时**：53.07 秒
- **依赖与边界检查**：
  - `tests/security.test.ts` 中 40 项安全断言全部通过，证实除 `src/core/persistence/` 外没有任何核心模块绕过持久化服务直接写文件，记录库引用范围严格收敛。
- **本地端到端测试（`npm run test:e2e`）**：
  - 27 个端到端测试用例全部通过（耗时 77.86 秒）。

---

## 4. GitHub CI 状态

- **触发提交**：`cc6c3f6`
- **运行编号（Run ID）**：[42606735244](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42606735244)
- **分支**：`rebuild`
- **综合状态**：**Success**（所有平台全部通过，0 失败）

### 各 Job 运行明细：
1. **`test (ubuntu-latest)`**（Job ID: `129124532479`）：
   - 状态：**Success**（耗时 45 秒）
   - 执行阶段：
     - `Run npm run typecheck`：通过
     - `Run npm test`：通过（23 passed, 11 skipped, 0 failed）
     - `Run npm run build`：通过
2. **`test (macos-latest)`**（Job ID: `129124532674`）：
   - 状态：**Success**（耗时 4 分 21 秒）
   - 执行阶段：
     - `Run npm run typecheck`：通过
     - `Run npm test`：通过（23 passed, 11 skipped, 0 failed）
     - `Run npm run build`：通过
     - `Install Electron binary (macOS)`：通过
     - `Electron end-to-end (macOS)`：通过（27 passed, 0 failed）

---

## 5. 与 ADR-0005 不一致的地方及原因

1. **实际落盘路径的收敛与归一**：
   - **ADR-0005 原文表述**：交接清单放在 `.studio/tasks/`，外发告知记录放在 `.studio/consent.json`。
   - **实际落地路径**：
     - 任务清单存储于 `.studio/records/manifests/<taskId>.json`；
     - 外发确认记录存储于 `.studio/records/consent/consent.json`。
   - **原因**：
     - 现有的统一写入服务 `RecordStore` 的核心机制是：以 `.studio/records/<collection>/<id>.json` 作为快照汇总投影，以 `.studio/events.jsonl` 作为唯一权威事实日志。启动对账（`reconcile()`）会统一扫描 `recordsRoot` 并在汇总缺失/损坏时从日志重建。
     - 若将清单和确认记录分散在 `records` 目录之外，就无法接入现有的启动对账和重放机制，必须另写一套分散的扫描和对账逻辑，违背了“接入现有的统一写入服务，不要另写一套新的存储机制”的原则。
     - 现行实现不仅使任务记录（`tasks`）、清单记录（`manifests`）和外发确认（`consent`）在结构上彻底解耦独立，还通过自动迁移机制保留了对旧路径的无感兼容。

除上述存储目录统一收归 `records/` 下以外，其余设计（CAS 乐观并发校验、`runId` Fencing 隔离、JSONL 事件日志、APFS 本地卷检测、跨进程目录租约锁、原子文件写入）完全与 ADR-0005 保持一致。

---

## 6. 未完成或不确定的事项

1. **思考记录与方案文档的统一持久化**：
   - 思考会话线程（`.studio/threads/`）和方案文档目前仍采用 `persistence/files.ts` 中的原子写原语进行一次性落盘，尚未接入带 CAS 与事件日志的 `RecordStore`，按规划留待后续专项任务迁移。
2. **事件日志轮转与快照压缩**：
   - `.studio/events.jsonl` 当前为纯追加日志，长期运行或任务量极大时日志文件体积会持续增长，尚未实现定期的日志截断、轮转或基于快照的压缩（ADR-0005 允许后续迭代完成）。
3. **跨任务独立项目级保存锁**：
   - 目前依赖单控制器任务级互斥以及 Git 合并冲突检测兜底，尚未实现跨任务独立保存锁。
4. **UI 样式细节**：
   - 前期 impeccable 审计发现的 side-tab 边框样式问题按规划保留至 UI 打磨阶段统一处理，本次任务恪守规范未变动任何前端样式。

---

## 7. 核对结论与问题复核（2026-11-09 复核追加）

### 7.1 问题一：测试跳过情况与 ADR-0005 验收场景状态核查
- **原报告错误更正**：此前报告中误将跳过的 11 个文件归因于“`tests/adr-0005-scenarios.test.ts` 中的 `it.todo` 骨架”，该描述有误，特此更正。
- **实际测试状态核验**：
  - 通过 `git log -p tests/adr-0005-scenarios.test.ts` 及运行 `npx vitest run tests/adr-0005-scenarios.test.ts` 确认：该文件在 commit `3fcdbb4` 中已由维护者完整实现，包含 9 个真实验收场景与 4 个附加检查，**内部无任何 `it.todo` 或弱化**。
  - 本次运行结果：**13 passed (13)**，9 个场景测试全部为真实断言且全部通过：
    1. 两个 Agent 同时修改同一任务（不发生静默覆盖，冲突可识别处理）
    2. 10 个任务并行更新同一项目（已确认提交状态可恢复，汇总准确）
    3. 任务取消与完成几乎同时发生（符合明确状态机规则）
    4. 任务完成事件重复回传（幂等去重，不重复提交）
    5. App 退出后重开旧 Agent 回传结果（过期运行身份拒绝覆盖）
    6. 保存时进程被强制终止（可恢复为旧版本或新版本，不留半成品）
    7. 磁盘写满、权限不足（有效数据完整，失败显式报告）
    8. 两个应用进程尝试操作同一数据目录（互斥锁禁止并发写入）
    9. 两个 Agent 修改同一源码文件（Git 冲突检测生效，无静默最后写入覆盖）
    + 4项附加检查（汇总损坏重建、日志末行截断、高 schema_version 升级拦截、非本地 APFS 拒绝写入）。
- **实际跳过的 11 个测试文件清单与原因**：
  经 `tests/**/*.test.ts` 与 `vitest.config.ts` 核对，被跳过的 11 个文件均为 `tests/integration/` 下的**真实模型集成测试**：
  1. `tests/integration/b3-1-probes.real.test.ts`
  2. `tests/integration/b3-1b-worktree.real.test.ts`
  3. `tests/integration/b3-modes.real.test.ts`
  4. `tests/integration/b4-1.real.test.ts`
  5. `tests/integration/codex.real.test.ts`
  6. `tests/integration/extensions.real.test.ts`
  7. `tests/integration/path.real.test.ts`
  8. `tests/integration/persist.real.test.ts`
  9. `tests/integration/sentinel.real.test.ts`
  10. `tests/integration/think-flow.real.test.ts`
  11. `tests/integration/thinker.real.test.ts`
  - **跳过原因**：这些文件使用 `tests/integration/gate.ts` 中的统一门禁 `describe.skipIf(!realEnabled(...))`，旨在需要真实 Codex 登录且消耗实际 API 额度时通过 `npm run test:real` 显式运行；在 `npm test`（常规 CI 与本地全量单元测试）中默认跳过以保护 API 额度与离线执行。

### 7.2 问题二：`e2e/shell.e2e.ts` 断言内容一致性核查
- **断言代码对比**：
  ```ts
  expect(r.actions.save.enabled).toBe(false);
  expect(r.actions.save.files).toEqual(['notes.txt']);
  expect(await a.page.getByRole('button', { name: /提交/ }).count()).toBe(0);
  ```
  上述三项断言与改动前**逐字完全一致**，没有删除、修改或放宽任何一项断言。
- **时序改动严谨性确认**：
  - 在 `Acceptance.tsx` 中，用户点击 `confirm-overall` 之前，页面处于未确认状态，保存按钮不可用，`<p className="muted" data-testid="save-reason">所有验收标准（或整体要求）都必须确认。</p>` 已渲染在 DOM 中。
  - 原测试在点击后立即执行 `waitFor('save-reason')`，Playwright 检测到 DOM 已有该节点会瞬间返回（0ms），导致尚未等待异步 IPC `confirmOverall` 执行并落盘，下一行的 `a.page.evaluate(...)` 就提前读取了视图，偶发返回未确认状态（`files: undefined`）。
  - 改为等待 `save-files`（`<ul className="muted" data-testid="save-files">`），因为该元素仅在 `reviewing && !a.save.enabled && a.save.files` 满足时才挂载。它确保了主进程已完成状态更新且渲染层已真实呈现出“未保存修改文件列表”，严格保障了用例对“列出文件”的预期，测试更加严格稳固。

### 7.3 问题三：交接清单重复导出（`expectedRevision: 0`）机制说明与修复
- **原固定 `expectedRevision: 0` 的问题分析**：
  - 若某任务已成功导出过一次交接清单，记录库中的版本号已递增为 1（或更高）。
  - 如果后续同一任务发生重复导出或重新导出，固定传 `expectedRevision: 0` 会导致底层 `RecordStore.commit` 在进行 CAS 乐观并发比对时发现 `actualRevision (>=1) !== expectedRevision (0)`，判定为并发状态冲突，抛出 `StateConflictError` 并在日志中记入 `conflict` 失败事件。
- **修复实现**：
  1. **参数扩展**：在 `ExportInput` 中新增 `overwrite?: boolean` 选项。未显式指定 `overwrite: true` 时，继续维持原有的“清单或任务文件已存在则拒绝覆盖”安全策略；指定 `overwrite: true` 时允许重新导出。
  2. **动态版本读取**：在提交清单前，先通过 `await manifestStore.get(i.taskId)` 查询当前已有清单的修订号：
     ```ts
     const existing = await manifestStore.get(i.taskId);
     await manifestStore.save(manifest, {
       runId: i.threadId,
       expectedRevision: existing?.revision ?? 0,
       note: 'manifest_export',
     });
     ```
     并在 `ManifestStore.save` 内部同样提供缺失时自动查询已有 revision 的兜底，实现平滑版本递增（1 -> 2）。
  3. **新增测试验证**：
     在 `tests/handoff.test.ts` 中新增测试用例：`重复导出：允许覆盖时先读取当前修订号再提交，推进 revision；若写死 expectedRevision: 0 则会触发冲突`。
     - 首次导出：清单修订号为 1；
     - 重复导出（`overwrite: true`）：读取当前修订号 1，提交后成功推进至修订号 2；
     - 并反向断言：若尝试以写死的 `expectedRevision: 0` 提交该已有清单，必抛出 `StateConflictError`。

### 7.4 兜底逻辑修正：禁止无版本隐式提交，`expectedRevision` 严格必填
- **修正背景与安全考量**：
  - 此前为方便兼容，在 `ManifestStore.save` 中存在“未传 `expectedRevision` 时自动查询当前修订号并递增”的兜底，且 `ConsentStore.record` / `clear` 也使用了 `updateRecord` 兜底。
  - 这种隐式自动查询并递增版本的做法违背了 ADR-0005 严格乐观并发控制（CAS）的核心初衷，容易在并发竞争时静默覆盖他人的修改，产生难以排查的脏写。
- **具体修改内容**：
  1. **删除自动读取当前修订号兜底**：
     - 在 `ManifestStore.save` 中彻底移除 `opts.expectedRevision ?? revision` 及缺失时自动查询 `repo.get` 的逻辑。
     - 在 `ConsentStore` 中彻底删除 `updateRecord` 导入与兜底调用，使 `record` 和 `clear` 均走严格的 `store.commit` CAS 逻辑。
  2. **类型与运行时双重严格要求**：
     - `SaveManifestOptions`、`RecordConsentOptions` 和 `ClearConsentOptions` 中的 `expectedRevision: number` 均改为必填字段。
     - 在方法入口增加运行时强校验：若 `opts` 未传、`opts.expectedRevision` 为 `undefined`、`null` 或非 `number`，立即抛出明确异常（如 `throw new Error('expectedRevision is required when saving manifest')`）。
  3. **调用点检查与规范传递**：
     - `src/core/thinking/handoff/export.ts`：保留规范做法——先通过 `await manifestStore.get(i.taskId)` 读取当前修订号，再显式传入 `expectedRevision: existing?.revision ?? 0`。
     - `src/core/thinking/cli/main.ts` 与 `src/core/thinking/flow/engine.ts`：外发确认调用显式读取当前版本并传入 `expectedRevision: cur?.revision ?? 0`。
     - 测试调用处（`tests/cli.test.ts`、`tests/flow.test.ts`、`tests/persistence.test.ts`）全部显式传入 `expectedRevision`。
  4. **补齐拒绝隐式提交测试**：
     - 在 `tests/persistence.test.ts` 中分别为 `ManifestStore` 和 `ConsentStore` 增加单测：`未传 expectedRevision 时提交直接抛错（禁止隐式自动读取当前修订号）`，断言不传修订号时运行时立即拒绝。
  5. **验证结果与 CI 状态**：
     - 本地全量测试：`npm test` 23 passed, 11 skipped, 0 failed（504 passed, 37 skipped, 0 failed）。
     - GitHub CI 运行：[42613208400](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42613208400)
       - `test (ubuntu-latest)`: **Success**（45s，typecheck、test、build 全部通过）
       - `test (macos-latest)`: **Success**（3m28s，typecheck、test、build、e2e 全部通过）

### 7.5 CI 偶发失败（Flaky）核查、失败日志排查与根本修复

#### 1. 失败记录与日志排查（真实故障数据）
- **CI 运行 42613745355**（提交 `260c943`，共 3 次 Attempt）：
  - **Attempt 1 失败**：
    - 失败用例：`e2e/shell.e2e.ts` > `施工模式界面` > `偏好只预选：上次选了完全信任，新任务预选完全信任，但开工前仍然弹出确认面板`
    - 错误信息：`TimeoutError: locator.check: Timeout 30000ms exceeded.`
    - 调用栈：`Call log: - waiting for getByTestId('mode-full-trust')`，在第 358 行：
      ```ts
      357: await newTask(a.page, '任务一');
      358: await a.page.getByTestId('mode-full-trust').check();
      ```
  - **Attempt 2 失败**：
    - 失败用例：`e2e/shell.e2e.ts` > `验收、保存、放弃、撤销（B4-2，待维护者运行）` > `验收失效 → 保存被拦下并突出“重新检查” → 重新检查后确认清空`
    - 错误信息：`TimeoutError: locator.waitFor: Timeout 30000ms exceeded.`
    - 调用栈：`Call log: - waiting for getByTestId('plan-card') to be visible`，在 `newTask`（第 230 行）被 `toReview`（第 444 行 / 第 528 行）调用时。
  - **Attempt 3**：全部通过（27 个 E2E 测试耗时 5m35s）。
- **历史运行 42605282319**（提交 `f0ac7d1`，1 次失败）：
  - 失败用例：`e2e/shell.e2e.ts` > `dirtyMain：主项目有未保存修改时不能保存，列出文件；修改消失后可用`
  - 错误信息：`AssertionError: expected undefined to deeply equal [ 'notes.txt' ]`，在第 554 行。
  - 原因：此前已在 commit `cc6c3f6` 中核查并修复（等待 `save-files` 节点渲染以保证主进程异步视图更新完成）。

#### 2. 原因深度剖析：异步旧响应乱序覆盖（Stale Response Race Condition）
- **触发机理**：
  - 在 E2E 测试中通过 `openProjectWithFake` 打开项目时，渲染层组件 `Tasks` 挂载，并在 `useEffect` 中发起异步 IPC 请求 `studio().listTasks()` 查询任务列表。
  - 由于测试执行非常迅速，测试代码紧接着执行 `await newTask(a.page, ...)`：
    1. 在输入框填入需求并点击 `create-task` 按钮；
    2. 主进程完成 `createTask` 并向持久化层写入记录，返回新建的任务对象 `t`；
    3. `Tasks.create` 收到 `t`，调用 `upsert(t)`（此时 `tasks = [t]`），并设置 `setSelected(t.id)`；
    4. React 渲染出选中的任务计划卡 `<PlanCard>`（`data-testid="plan-card"`），Playwright 的 `await page.getByTestId('plan-card').waitFor()` 满足并立即返回。
  - **致命竞态（Race Condition）**：
    - 此时，在组件刚挂载时发出的那个 `studio().listTasks()` 异步 IPC 请求（因主进程启动对账扫描或 macOS runner 调度较慢）才刚刚返回！
    - 这个早期请求返回的是旧快照（空列表 `[]`）。
    - 挂载时的 promise 回调无条件执行了 `setTasks(r.tasks)`，即 `setTasks([])`！
    - 这瞬间将 `tasks` 清空覆盖！
    - 紧接着 `current = tasks.find(t => t.id === selected) ?? null` 变为 `null`，React 立即卸载了 `<PlanCard>`，`plan-card` 与 `mode-full-trust` 瞬间从 DOM 中被销毁！
    - **Attempt 1 中**：`newTask` 刚返回，下一行 `mode-full-trust.check()` 寻找元素时元素已被卸载，死等 30 秒超时；
    - **Attempt 2 中**：旧响应更早一步在 `waitFor()` 期间清空状态，`plan-card` 同样消失，`waitFor()` 死等 30 秒超时。

#### 3. 根本性修复（不加超时、不放宽断言、杜绝重跑掩盖）
- 在 `src/renderer/Tasks.tsx` 中实施严格的异步请求版本控制与状态合并双重防御：
  1. **请求序号递增守护（`refreshSeq`）**：
     - 使用 `useRef(0)` 维护 `refreshSeq`。
     - 每次发起 `refresh()` 时自增序号并绑定到该次请求；当 promise 返回时，若 `seq !== refreshSeq.current`，则该响应被判定为过期响应（Stale Response），直接丢弃，严禁调用 `setTasks`。
     - 组件卸载时标记 `mountedRef.current = false` 并递增 `refreshSeq`，防止卸载后竞态。
  2. **在创建任务时主动失效旧请求**：
     - 在 `create()` 开始和完成写入时主动使 `refreshSeq.current++`，确保任何在任务创建前发起的旧 `listTasks()` 请求在返回时均被立即丢弃，绝不会覆盖新创建的任务。
  3. **任务列表差异合并保护（Merge Defense）**：
     - 在 `setTasks` 时比对 `prev` 与 `r.tasks`，通过 `prev.filter((p) => !r.tasks.some((t) => t.id === p.id))` 保留本地正在操作但尚未包含在远端旧快照中的任务，彻底消除偶发数据丢失。
- **本地严苛验证**：
  - 针对性运行失败用例：
    - `npx vitest run -c vitest.e2e.config.ts -t "偏好只预选"`：3.0s 一次通过
    - `npx vitest run -c vitest.e2e.config.ts -t "验收失效"`：4.4s 一次通过
  - 本地全量运行 27 项 Electron E2E 测试（`npm run test:e2e`）：全部一次通过（81.99s，0 失败）。

#### 4. GitHub Actions CI 最终验证（一次性全部通过，0 重跑）
- **CI 运行链接**：[42617720060](https://github.com/luckyjamesriver/ai-solo-studio/actions/runs/42617720060)
- **提交版本**：`da5e6d5`（包含 `src/renderer/Tasks.tsx` 的异步乱序竞态根本修复）
- **运行尝试（Run Attempt）**：**Attempt 1（单次一次性全绿通过，没有任何重跑）**
- **各 Runner 耗时与状态**：
  - **`test (ubuntu-latest)`**：**Success**（37s，typecheck、test、build 全部通过）
  - **`test (macos-latest)`**：**Success**（3m34s，typecheck、test、build、Electron 27 项 e2e 全部一次通过）





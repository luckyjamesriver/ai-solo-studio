# AI Solo Studio — 代码索引试点与定位效能对比报告 (INDEX_PILOT_EVALUATION) v1.2

**任务标识：** `AISS-CODEMAP-CONTEXT-PILOT-R2`  
**基线分支：** `origin/rebuild` (`443773c` / PR #2 Merged)  
**测试工作树：** `/Users/jamesho/ai-solo-studio-codemap`  
**测试工具：** `code-review-graph 2.4.0` 与 `graphify 0.9.113`  
**状态声明：** `AISS_CODEMAP_CONTEXT_READY_FOR_INDEPENDENT_REVIEW`

---

## 一、 索引基础设施盘点与真实状态核查

### 1. 历史索引与工作树索引身份核查
- **历史索引现状**：原开发工作区 `.code-review-graph/graph.db`（14 MiB）生成于 2026-11-08（Commit `320f836`），由于当前主干为 `443773c`，Git HEAD 严重脱节。依令**明确标记为 `INDEX_STALE`，严禁直接用于当前审查**。
- **试点索引身份（实测）**：
  - 在隔离工作树 `/Users/jamesho/ai-solo-studio-codemap` 中构建；
  - 实际解析文件数：**214 个文件**（TypeScript, TSX, JavaScript, JSON, YAML, HTML）；
  - 实际拓扑规模：**2,989 个节点，47,146 条边**；
  - 实际磁盘占用：**52 MiB**（严格处于 256 MiB 资源红线内，仅占 20.3%）；
  - 全量构建耗时：**16.20 秒**；增量更新耗时：**< 1 秒**；
  - Git 忽略规则：已在 `.gitignore` 中加入 `.code-review-graph/` 与 `.graphify/`，保证索引绝对不落盘入库。

### 2. 索引身份与 INDEX_STALE 状态流转机制（实测验证）

在试点工作树中，我们完整追踪并验证了索引状态的动态流转：

```
[初次全量构建] -> built_at_commit: 2c70c62 | current_sha: 2c70c62  ==> 【INDEX_VALID】
       │
       ▼ (产生新的代码或文档 Commit: 561799e)
[工作树 HEAD 推进] -> built_at_commit: 2c70c62 | current_sha: 561799e  ==> 【INDEX_STALE (已过期)】
       │ (在此状态下，核心接口与风险判定强制降级为 git grep 源码分析)
       ▼
[运行 code-review-graph update] (< 1秒增量刷新)
       │
       ▼
[索引对齐主干] -> built_at_commit: 561799e | current_sha: 561799e  ==> 【INDEX_VALID (恢复有效)】
```

- **`INDEX_STALE` 判定三要素**：
  1. `built_at_commit !== current_sha`（Commit 不匹配）；
  2. 工作树存在批量未提交的源码变动（Dirty Worktree）；
  3. 目标调用链涉及 TypeScript 命名空间对象调用（如 `import * as G; G.fn()`），CRG 无法静态提取直接 `CALLS` 边。
- **强制处置规则**：一旦命中任一 Stale 条件，**系统必须自动降级为原生源码检索（git grep / ripgrep）**，严禁以过期或不完整的索引输出作为架构与验收结论。

---

## 二、 7 组典型场景评测核实与证据记录

本轮核实彻底剔除了不存在于主干的文件（如未提交的 `chatgpt-devkit.ts`），修正了真实函数名（`assess` 而非 `evaluateRisk`、`store.ts` 而非 `record-store.ts`），并**去除了未经完整人工验证的“100% 准确 / 零漏报”等绝对化断言**。

### 7 组场景实测对比与局限性分析

| # | 评估场景与真实查询目标 | 方法 A: 原生检索 (`git grep`) | 方法 B: 代码地图 (`CODE_MAP.md`) | 方法 C: CRG 图索引 (`code-review-graph`) | 真实性核实与工程结论 |
|---|---|---|---|---|---|
| **1** | **函数级影响分析**<br>`src/core/git/git.ts`<br>`createWorktree` | 耗时 0.2s；命中 16 行；精准识别 `runner.ts` 2 处调用和 11 个测试，但需人工过滤注释。 | 耗时 <0.1s；直接指出由 `TaskRunner` 在任务开工时调度，测试在 `tests/git.test.ts`。 | `search` 0.4s 获签名；但 `callers_of` 返回 0；而 `importers_of` 0.5s 返回全部 36 个引用文件。 | **发现静态分析局限**：TS 命名空间导入（`G.createWorktree`）无法被 CRG 识别为直接 `CALLS` 边；必须配合 `git grep` 兜底。 |
| **2** | **UI与IPC跨层映射**<br>前端点击“保存任务” (`saveTask`) | 耗时 0.3s；命中 28 处；分散在 UI、Preload、IPC 与控制器中，缺乏调用链路感。 | 耗时 <0.1s；直接查阅“保存合并流”：Renderer -> Preload -> Main -> TaskController.saveTask -> TaskRunner.save -> GitClient。 | `search saveTask` 0.5s 返回 6 个分层节点；可通过 `path_to` 辅助连线。 | **代码地图完全胜出**：宏观架构流一目了然，无需在海量文本或图中摸索。 |
| **3** | **状态机迁移影响**<br>状态流转至 `reviewing` | 耗时 0.3s；命中 45 行；包含大量 UI 渲染条件，无法直观确认状态机核心。 | 耗时 <0.1s；锁定 `task/state.ts`、`runner.ts`、`task-controller.ts` 与 `tests/state.test.ts`。 | `search reviewing` 0.4s 返回相关枚举与类型定义。 | **代码地图定主干 + git grep 查边缘**。 |
| **4** | **修改持久化需跑测试**<br>`src/core/persistence/store.ts`<br>（注：无 `record-store.ts`） | 耗时 0.4s；命中 50+ 处；需人工从海量导入中逐一挑出测试文件。 | 耗时 <0.1s；直接指出 `tests/adr-0005-scenarios.test.ts`、`persistence.test.ts`、`security.test.ts`。 | `tests_for` 0.8s 返回 35 个具体测试用例节点及行号（覆盖 ADR 0005 场景 1、2、4、5、6、7、8 等）。 | **CRG 表现突出，但不能假定零漏报**：黑盒端到端测试若未直接 import `store.ts` 则可能漏召，仍需按代码地图补充运行安全测试。 |
| **5** | **主进程安全边界审计**<br>修改 `src/main/index.ts` | 耗时 0.2s；仅能看到当前文件；无法获知系统全局架构边界。 | 耗时 <0.1s；查阅第四节“核心安全防线”，立即定位 `tests/security.test.ts`（CSP、沙箱、ADR 0006）。 | `query importers_of` 0.5s 分析模块引用关系。 | **代码地图显著胜出**：安全架构与 ADR 边界必须依赖固化记忆，非纯代码索引能推导。 |
| **6** | **权限与风险拦截调用**<br>`src/core/policy/risk.ts`<br>`assess`（注：无 `evaluateRisk`） | 耗时 0.2s；命中 26 处；分散在各适配器与测试用例中。 | 耗时 <0.1s；明确其在执行体权限拦截时被调用。 | `callers_of` 0.4s **提取 22 个真实调用点（跨 16 个节点）**，覆盖 `acp.ts`, `codex.ts`, `runner.ts` 及各测试。 | **CRG 表现优异**：标准直接函数调用定位极其精准，能大幅节省追踪行号的时间。 |
| **7** | **外部思考模型协议修改**<br>`src/core/thinking/claude-api.ts`<br>（注：主干无 `chatgpt-devkit`） | 耗时 0.2s；命中 12 处；需逐个打开文件核对上下文。 | 耗时 <0.1s；指引至 `src/core/thinking/` 与讨论服务。 | `importers_of` 0.4s 精准识别 `ai-settings.ts`、`task-controller.ts` 与 `discussion-service.ts`。 | **CRG 模块级拓扑与代码地图结合最佳**。 |

---

## 三、 资源占用与失效降级机制

1. **资源与安全控制**：
   - 严禁全仓批量重建，严禁在 CI 构建中常驻运行索引；
   - 严禁安装常驻文件系统监视守护进程（No Watch Daemon）；
   - 单个索引体积严格控制在 256 MiB 以内（当前 52 MiB，处于极安全水位）；
   - 索引数据库 `.code-review-graph/` 与 `.graphify/` 永久由 `.gitignore` 排除，绝不提交至 Git。
2. **失效降级三原则**：
   - **原则 1（HEAD 不符降级）**：若 `built_at_commit !== current_sha`，标记为 `INDEX_STALE`，自动降级为原生源码检索；
   - **原则 2（命名空间导入降级）**：若涉及 `import * as X` 模块调用，因 AST 限制无法保证 `callers_of` 完整性，强制以 `git grep` 交叉核验；
   - **原则 3（最终事实以源码为准）**：索引输出的所有行号、调用关系与测试清单，必须回读真实文件，严禁直接以索引推断作为 PR 审查或发布证据。

---

## 四、 关于 Graphify 的评估结论

- 本机安装有 `graphify 0.9.113`；
- 评测表明：CRG 2.4.0 在 TypeScript AST 解析、FTS5 检索、`callers_of` 与 `tests_for` 自动化发掘上已经完全满足当前需求，且磁盘占用（52 MiB）可控；
- Graphify 在复杂多语言网络中具备可视化优势，但在前端 Electron/TypeScript 深度符号调用解析上并未表现出不可替代的增量价值，反而会带来双重数据库维护与磁盘开销；
- **明确结论**：**Graphify 暂作为可选补充，不纳入日常强制工作流**。

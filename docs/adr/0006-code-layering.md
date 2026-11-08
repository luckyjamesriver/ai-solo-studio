# ADR 0006：代码分层与边界（含存储边界）

- 状态：已修订（2026-11-08），随 ADR 0005 生效（0005 已批准）；存储边界检查在 0005 实现任务里落地。
- 相关：ADR 0005（数据存储）、ADR 0007（测试分层）、ADR 0008（依赖，草稿）。

## 背景
src/core（纯 Node）/ main / preload / renderer 的分层事实上已形成，部分有断言（渲染层对 core 只有类型引用、不得出现 AcceptanceCard / evidence 等），但“core 不依赖 electron”没有断言；存储尚无统一入口，各模块各自写文件。

## 决定
1. **core**：纯 Node，不 import electron；只在宿主传入的路径内读写；所有子进程经 proc；所有 git 经 git.ts。
2. **main**：只做 IPC、窗口、系统对话框，把路径交给 core；不含业务规则。**主进程持有持久化服务（ADR 0005），它是项目内 `.studio/` 与 userData 的唯一写入者。**
3. **preload**：白名单 API，参数只有编号、条目编号、验收版本、布尔。
4. **renderer**：只消费视图模型；不拼接失败文案（文案来自 core 的 messages/texts）。
5. **存储边界**：存储层是 Repository 接口（ADR 0005 第 5 节）。只有持久化服务里的 `File*Repository` 实现可以使用 `node:fs` 写入 `.studio/` 与 userData；**UI（renderer）和 Agent（executor 适配器、思考者）只能依赖 Repository 接口，不得 import 文件实现或直接写这些位置。**
6. **新增断言（只收紧）**：
   - src/core 不得 import electron；
   - **依赖边界检查**：对 import 图做静态检查（先用测试里的 import 图扫描实现，与现有 security 断言同一做法；若改用 dependency-cruiser 等工具，须先按 ADR-0008 审查）。规则：renderer 不得 import core 的运行时代码（保持现状）；executor、thinking、renderer 不得 import 文件版 Repository 或持久化服务；除持久化服务目录外，不得对 `.studio/` 或 userData 路径调用 `writeFile`/`appendFile`/`rename`/`rm`；
   - 断言自身有效性：每条规则配一个“应当命中”的反例样本。
7. 现有直接写文件的位置（任务存储、偏好、最近项目、外发告知、线程、交接、诊断日志、`.git/info/exclude`）在迁移前登记为豁免清单，清单只许减少、不许增加。

**实现状态（2026-11-09）**：持久化依赖边界检查已落地（tests/security.test.ts “ADR 0006：持久化依赖边界”）：src 里只有 `src/core/persistence/` 可以直接写文件，唯一豁免是模拟执行体写任务副本（`executor/adapters/fake.ts`）；记录库（`persistence/index|store|…`）只能被 `task/store.ts`、`task/runner.ts`、`app/{app-store,recent,disclosure,prefs,task-controller}.ts`、`main/index.ts` 引用；文件原语（`persistence/files`）只能被 `git.ts`、`checks/scripts.ts`、`thinking/{codex,claude-cli,flow/store}.ts` 引用——这两份清单只许减少。检查用 import 图扫描实现，没有引入新工具。“src/core 不得 import electron”的断言仍未添加。

## 后果
所有界面文案、状态判定、存储规则都在 core 里可单测；e2e 只验证接线；绕过存储层的写法会在测试里直接失败。

# AISS-A1-TRUSTED-EVIDENCE-001：统一宿主证据模型与可信测试证据

- **基线**：`origin/rebuild` = `e69ca8511a17acfc4427954af13ef6d364ffb553`
- **性质**：正式产品修复（独立 PR），不是审计原型移植；审计实验代码不进入本分支。
- **目标**：AI 可以报告任务成功，但不能决定任务是否通过验收；验收结论必须由真实、有效且与当前任务版本绑定的宿主证据决定。

## 1. 已确认缺陷与修复

| 编号 | 缺陷（基线实测） | 修复 |
| :-- | :-- | :-- |
| P0-1 | `runCheck()` 用进程退出码 0 判定测试通过：`echo`、零测试、全部跳过、外层脚本吞掉失败、伪造 stdout 摘要都会显示“测试通过” | 自动测试改为**结构化证据**判定：宿主注入 Vitest JSON 报告器，只有“有测试真实执行且全部通过、报告完整、范围未削弱”才是 `passed`；其余为 `failed` / `unverified` / `not_available` |
| P0-2 | `parseTestCases()` 解析不出数量时按检查状态兜底生成 1 项通过；历史验收卡兼容路径直接显示“1 项通过” | 数量只有两个可信来源：结构化报告 > stdout 的**显式数字摘要**；都没有则 `counts = null`，界面显示“测试数量未知（未取得有效测试证据）”，绝不补造 |
| P0-3 | `card.ts` 直接按检查状态生成验收结论，把“命令结束”“测试执行”“测试通过”“未执行”“无证据”混为一谈 | `ItemStatus` 增加 `unverified`（缺乏有效证据）与 `invalidated`（证据失效）；`passed` 仍须可信证据；人工确认只产生 `user_confirmed`，绝不转成自动通过 |

## 2. 统一证据模型

新增 `src/core/evidence/`（复用现有 `TaskRunner.buildEvidence`、`runCheck`/`runProjectChecks`、`StoredCheckProof`、`acceptedTree`、`acceptanceRev`、`checkAuth`、历史轮次与 PersistenceService / RecordStore，不新建任务状态机或第二套持久化）：

| 文件 | 职责 |
| :-- | :-- |
| `evidence/model.ts` | `HostCheckEvidence`：身份、运行身份、配置指纹、结构化报告、范围评估、有效性与失效原因；`CheckVerdict`/`CheckUnknownReason`/`EvidenceTrust` |
| `evidence/inventory.ts` | 测试范围清单（逐文件测试块/断言/skip/only/测试名）与配置/运行器/锁文件指纹；从**任务基线提交**计算基线，执行体不可篡改 |
| `evidence/vitest.ts` | Vitest JSON 报告采集与严格校验：随机路径、运行前清空、mtime/startTime 窗口、计数内部一致性、`success` 与失败数一致性、stdout 摘要交叉核对 |
| `evidence/validate.ts` | 证据身份复核（任务/轮次/验收版本/被测内容）、可信通过判定、配置漂移检测 |

`StoredCheckProof` 扩展为 `status: 'passed' | 'failed' | 'not_available' | 'unverified'` 并携带 `evidence`；无新证据的旧记录读取时标记 `legacyUnverified`，**不补造、不改写历史记录**。

### 2.1 证据字段（绑定关系）

- **身份**：`{ projectRootHash, taskId, round, acceptanceRev, testedTree, worktreePathHash, evidenceId }`
- **运行身份**：`{ runId, startedAt, finishedAt, env, sandboxKind, argv, exitKind, exitCode, durationMs, stdout/stderr 摘要 }`
- **配置指纹**：`scriptsDigest`（批准摘要同算法）、`packageLockDigest`、`runnerPackage{name,version,packageJsonSha256}`、`testConfigFiles[]`、`testInventoryDigest`、测试文件/测试块/断言/skip/only 计数、报告器模式、采集器版本
- **结构化报告**：格式、sha256、字节数、是否本次产生、运行时间窗口、真实计数（执行/通过/失败/跳过/todo）、失败用例名、完整性结果、与 stdout 交叉核对
- **范围评估**：相对**任务基线提交**的 `assessed_unchanged / assessed_stronger / assessed_weakened / not_assessed` 及理由
- **有效性**：`valid` + `invalidReason`（`evidence_invalidated` / `test_scope_weakened` / `source_changed_during_check` 等）

### 2.2 信任边界（如实声明）

宿主采集退出码和结构化报告**不等于绝对不可伪造的证据**。执行体能够修改测试文件、配置，完全信任模式下甚至能修改运行器。因此本阶段：

1. 报告由宿主注入的 CLI 报告器写入宿主生成的**随机路径**，运行前清空，运行后校验“本次运行窗口内新产生”（拒绝复用/预置/符号链接/硬链接/空文件）；
2. 报告内部计数必须自洽，`success` 必须与失败数一致，并与进程 stdout 摘要交叉核对（不一致即 `unverified`）；
3. 检查脚本、锁文件、测试配置、运行器包、测试清单全部纳入指纹；批准后变化 → 授权失效 / 证据失效；
4. 运行前后各算一次被测内容 tree，运行期间内容变化 → 证据作废（`source_changed_during_check`）；
5. 相对任务基线提交评估测试范围：删除测试文件/测试用例、减少测试块或断言、增加 skip/only/todo、修改配置/运行器/锁文件 → `test_scope_weakened`，**自动通过被阻断**，需用户显式重新确认；
6. 标准模式下运行器位于主项目 `node_modules`，沙箱禁止执行体写入其中；完全信任模式在计划和风险确认中已如实告知这一边界。

## 3. 可信测试证据采集（第一阶段：Vitest）

- 仅当 `package.json` 的 `test` 脚本是**可安全追加参数的真实 Vitest 调用**（无 `&&`/`||`/`;`/管道/重定向）时建立结构化通道：
  `npm run test --silent -- --reporter=default --reporter=json --outputFile.json=<worktree>/.studio/evidence/<nonce>/vitest-report.json`
- 判定顺序（报告是权威事实）：真实失败 > 报告完整性 > 零测试 > 全部跳过 > 非 0 退出 > 范围削弱 > 通过。因此“测试失败但外层脚本吞掉退出码”仍为 `failed`，“伪造成功摘要”不产生证据。
- 其他测试框架（`node --test`、脚本型命令等）只记录命令结果：退出 0 → `unverified`（绝不冒充测试用例证据），退出非 0 → `failed`。本阶段不为未验证的框架批量堆适配器。
- `node_modules/` 与 `.studio/` 永不进入验收内容 tree 或改动清单（测试器会写 `node_modules/.vite` 等缓存），避免把工具缓存误判成“检查改动了文件”。

## 4. 防止验收规则被执行者操纵

| 场景 | 处理 |
| :-- | :-- |
| 删除已有测试 / 减少测试块 / 减少断言 / 删除测试名 | 相对基线判 `assessed_weakened` → `unverified` + `scopeChange`，阻断自动通过 |
| 增加 `skip`/`todo`/`.only` | 同上（`.only` 会让其余测试不执行） |
| 修改测试/构建脚本 | `scriptsDigest` 与批准摘要不一致 → 授权失效，未检查 |
| 替换测试运行器 / 修改测试配置 / 修改锁文件 | 配置指纹变化 → `test_scope_weakened`，需重新确认 |
| 伪造/复用旧报告 | 随机路径 + 运行前清空 + mtime/startTime 窗口 + 完整性校验 → `report_missing`/`report_reused`/`report_invalid` |
| 吞掉失败退出码 | 结构化报告仍显示真实失败 → `failed` |
| 检查期间修改被测源码 | 运行前后 tree 不一致 → 证据作废 |
| 修改已经批准的验收标准 | 计划编辑清除 `checkAuth` 并要求重新批准（既有机制），新证据绑定当前验收版本 |

**合法新增与修订测试不会被阻断**：相对基线更多文件/测试块/断言、减少 skip → `assessed_stronger`，照常通过。削弱覆盖时提供明确的“重新确认当前测试范围”流程：确认绑定 `acceptanceVersion` 与范围指纹，验收版本或范围变化后自动失效；该动作只能由用户主动触发，自动反馈闭环不得调用。

## 5. 全链路接入（7 条路径）

1. **任务结束后的 `buildEvidence()`**：生成身份化证据、冻结 `acceptedTree`、写入 `currentChecks`/`checks`、生成验收卡与 `scopeChange`。
2. **用户重新检查 `recheck()`**：清空全部确认，`acceptanceRev + 1`，重新采集证据；旧版本证据与旧“未检查确认”一律失效。
3. **保存前试合并 `runProjectChecks()`**：在试合并 worktree 用同一枚举与同一证据语义运行；检查前后 tree 比对；试检查结果与原验收证据不一致 → `acceptance_inconsistent` 阻断保存。
4. **验收卡与证据详情页**：`ItemStatus`/`ViewItemStatus` 区分通过、失败、未执行、缺乏证据、证据失效、用户确认；证据详情页显示数量来源、报告完整性、范围核对、运行器身份等可核对事实；无数量时显示“测试数量未知”。
5. **历史任务与历史轮次**：旧记录无新证据字段 → 读取为历史未核实（`unverified`，数量未知）；历史轮次按“当时有效”展示；不补造、不改写。
6. **ChatGPT 反馈包宿主事实**：`buildTaskView` 的 facts 使用与验收卡一致的状态语义；缺乏证据时明确“不可视为已通过”，宿主事实与 AI 自述分区展示。
7. **异常重启后的证据恢复**：启动核对增加证据复核——身份不一致（任务/轮次/验收版本/冻结内容）或检查脚本/配置/运行器/锁文件在验收后被改动 → 记录 `evidenceInvalid`，界面显示“证据失效”并阻断保存。

人工接受未检查风险机制保留：真实失败永远不能通过确认绕过；未执行/缺乏证据可以走既有确认流程，但保存记录为 `checked=false, uncheckedKind=none|unavailable|unverified`，卡片绝不显示通过；确认记录真实时间，验收版本变化后失效；自动流程不得自行确认。

## 6. 反向测试矩阵

`tests/a1-trusted-evidence.test.ts`（真实进程 + 真实 Vitest，20 项）与 `tests/a1-evidence-chain.test.ts`（7 条全链路，14 项）覆盖第 9 节表格全部场景；关键场景使用真实测试框架与真实进程，不以 Mock 替代。既有测试中依赖“退出码 0 = 测试通过”旧语义的夹具，已迁移为真实 Vitest 或改为断言新语义（没有删除测试、没有降低断言）。

## 7. 已知限制与未做的事项（如实登记）

1. 第一阶段只完整支持 Vitest 结构化证据；其他框架只记录命令结果，显示“未核实”，不冒充通过。
2. 执行体在完全信任模式下可以修改运行器；此时证据的“可信”以配置指纹与前后 tree 比对为准，不构成密码学级别的不可能伪造保证（见 §2.2）。
3. 历史记录缺少证据字段时无法追溯当时的真实测试数量，只能标记“历史未核实”。
4. A2–A6（自主反馈闭环、并发防护、多执行体协同等）不在本阶段实现，也未预登记。

---

## 8. R1 独立复核修订（AISS-A1-TRUSTED-EVIDENCE-R1-001）

针对 ChatGPT 独立复核（旧候选 `6918ea5`，`CHANGES_REQUIRED`）的逐项修订：

1. **数据完整性**：内容 tree 与改动清单改为「只剔除未跟踪的内部目录缓存」，已跟踪文件的修改/删除完整保留；改动清单改用同一内容 tree 的 `git diff-tree`，不触碰工作树索引；保存后核对任务改动路径与冻结内容逐字节一致，否则恢复并 `failed_restored`。
2. **失败优先**：真实非零退出/超时/异常终止一律 `failed`，先于报告缺失/损坏/复用/零测试/全跳过判定，不能降级为可人工放行的 `unverified`。
3. **保守范围复核**：逐文件断言/测试块下降不可被其它文件新增抵消；已存在测试文件内容变化、辅助文件变化、配置/运行器/锁文件变化、实际执行范围缺失 → `assessed_needs_review`；`assessed_unchanged` 仅在所有输入未变且执行范围完整时出现；如实声明静态分析不能证明语义未削弱。
4. **统一裁决入口** `src/core/evidence/adjudicate.ts`：验收卡、证据页、保存门禁、历史轮次、反馈包共用；身份校验加入项目根/任务副本/证据类型（统一 realpath 哈希）；保存核心门禁主动调用。
5. **范围重新确认闭环**：确认绑定内容指纹+范围指纹+验收版本；确认前内容/范围变化拒绝旧确认；确认后清空旧验收决定；保存与试合并消费确认（试合并不一致 → 硬阻断，未确认时仍对原始基线校验）。
6. **证据恢复与完整性**：build 证据不比较测试运行器；配置变化对称检测；运行器入口/依赖纳入指纹；报告校验逐项如实记录（含交叉核对是否实际发生、ANSI 处理、路径逃逸/符号链接）；旧记录/历史证据不得重新变成可信 PASS（保存记录带 `evidenceIds`，无证据显示“历史记录未核实”）。
7. **标准模式完整项目**：不扩大沙箱权限的前提下，通过 `TMPDIR` 与 `GIT_CEILING_DIRECTORIES` 组合解决项目测试的临时目录/仓库探测兼容性，并允许沙箱进程向自己的子进程发信号；在真实 Seatbelt 沙箱内运行完整项目 build+test 并完成保存/撤销验证，不再用宿主运行器替代产品路径。

详细逐项报告与证据：`docs/reviews/AISS-A1-TRUSTED-EVIDENCE-R1-001.md` 与同名证据目录。

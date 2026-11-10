# ADR 0008：依赖与供应链安全

- 状态：已整理（2026-11-08，由草稿整理并吸收评审意见）；从 ADR 0005 批准起，用于检查 0005 引入的依赖。
- 相关：ADR 0005（引入 write-file-atomic、proper-lockfile、zod）、ADR 0007（CI 检查）。

## 1. 背景
依赖全部是精确版本且有 lockfile；`npm audit` 与 `npm audit --omit=dev` 当前均为 0 漏洞；“发布满两周才升级”“禁止 audit fix --force”此前只是文字约定；仓库里没有许可证检查，也没有 allowScripts 配置；CI 通过跳过 Electron 下载、再手动安装二进制来处理 npm 不运行安装脚本的问题（M3-BASE-1 盘点）。

## 2. 决定
1. 精确版本 + lockfile，维持。
2. **新依赖必须写明用途和引入理由**（为什么需要、为什么不自己写、替代方案），记录在本文第 5 节的依赖登记表和相应任务报告里；运行时依赖（dependencies）尽量零增长。
3. **引入前检查直接依赖和传递依赖**（用精确版本在隔离目录里 `--ignore-scripts` 安装后检查，不动仓库）：
   - **许可证**：逐个读取每个包的 license 字段；只允许 MIT / Apache-2.0 / BSD / ISC 等宽松许可证，其他需人工批准；许可证缺失或不明视为不通过。
   - **安装脚本**：是否有 preinstall / install / postinstall（lockfile 的 `hasInstallScript`）。有则默认不通过，除非任务里说明理由并经批准。
   - **原生模块**：是否有 `binding.gyp` / `gypfile` / `.node`、`.dylib`、`.so` 文件。原生模块需要随 Electron 重新编译，默认不通过。
   - **安全风险**：`npm audit` 结果；是否被弃用（deprecated）；维护状态（最近发布时间）；与项目 `engines` 是否兼容。未做源码审查的，必须如实写明。
4. 升级规则：只选发布满 14 天的版本；不用 `npm audit fix --force`；升级大版本单独任务。
5. 安装脚本：维持“跳过 + 显式安装 Electron 二进制”的做法；本机开发写进 README 的环境准备步骤。
6. **许可证检查进 CI**：第一版用仓库内脚本读取 lockfile 与已安装包的 license 字段（不新增依赖），白名单之外的失败；该脚本是后续任务，尚未实现（本文第 4 节的结果是用同样的口径手工检查得到的）。

## 3. 理由
每次加依赖都有可查的记录；许可证、安装脚本和原生模块问题在合并前暴露，而不是在安装 Electron 失败那样的场合才发现。

## 4. 对 ADR 0005 三个依赖的检查结果（2026-11-08）
检查方法：在隔离目录（不在仓库内）用精确版本 `npm install --ignore-scripts` 安装，读取安装后每个包的 package.json、lockfile 与文件清单，并运行 `npm audit`。**仓库的 package.json 与 lockfile 未改动**，依赖尚未引入。

| 包与版本 | 发布日期（满 14 天？） | 许可证 | 安装脚本 | 原生模块 | 直接依赖 | 结论 |
|---|---|---|---|---|---|---|
| write-file-atomic 8.0.0 | 2026-05-08（是） | ISC | 无 | 无 | signal-exit 4.1.0 | 通过（见下方提示 A） |
| proper-lockfile 4.1.2 | 2022-06-24（是） | MIT | 无 | 无 | graceful-fs 4.2.11、retry 0.12.0、signal-exit 3.0.7 | 通过（见下方提示 B） |
| zod 4.6.7 | 2026-10-12（是，27 天） | MIT | 无 | 无 | 无 | 通过 |

传递依赖（共 4 个，全部检查）：graceful-fs 4.2.11（ISC）、retry 0.12.0（MIT）、signal-exit 3.0.7（ISC，proper-lockfile 使用）、signal-exit 4.1.0（ISC，write-file-atomic 使用）。**全部无安装脚本，无原生模块**（安装目录中没有 `binding.gyp`、`.node`、`.dylib`、`.so` 文件，lockfile 中没有任何 `hasInstallScript`）；全部为宽松许可证（ISC / MIT）。
安全：隔离目录里 7 个包的 `npm audit` 结果为 **0 个漏洞**；没有包被标记为 deprecated。**没有做源码审查**（只检查了元数据、脚本与文件类型）。

提示：
- **A（版本兼容）**：write-file-atomic 8.0.0 声明 `engines.node = ^22.22.2 || ^24.15.0 || >=26.0.0`，而本项目 `engines` 是 `>=22 <23`、.nvmrc 是 `22`：Node 22.0–22.22.1 不满足它。当前机器与 CI 用的 22.x 是更新的补丁版本（本机 22.23.4），满足；引入时需把项目 `engines` 与 .nvmrc 收紧到 `>=22.22.2 <23`，并确认 Electron 45 内置 Node 的版本（未确认）。
- **B（维护状态）**：proper-lockfile 最后一次发布是 2022-06，之后没有更新；它基于 mkdir 的锁语义，依赖本地文件系统行为（与 ADR 0005“仅支持本地 APFS”一致）；它带来两个版本的 signal-exit（3.x 与 4.x）并存。可接受，但引入时需有锁行为的测试（ADR 0005 场景 ⑧），并把“可替换为自写锁”记为退路。

## 5. 依赖登记表（用途与引入理由）
现有依赖（用途；各自的许可证与传递依赖尚未按本文口径逐个核对，属后续任务）：
- react 19.3.1、react-dom 19.3.1：渲染层界面（ADR 0004）。
- electron 45.0.0：桌面外壳（ADR 0004）。
- vite 6.4.5、@vitejs/plugin-react 4.7.0：构建渲染层。
- typescript 5.9.3、@types/node 22.20.5、@types/react 19.3.0、@types/react-dom 19.3.0：类型检查与构建。
- vitest 5.0.5：单测与 e2e 运行器。
- playwright-core 1.64.1：驱动 Electron 真窗口的 e2e。

待引入（ADR 0005，已检查通过，由存储层实现任务引入）：
- write-file-atomic 8.0.0：**用途**：所有持久化文件的原子写（临时文件、落盘、rename）。**理由**：这是数据正确性的核心环节，自写容易漏掉 fsync 与失败清理；该包只有 1 个传递依赖，无脚本、无原生模块。
- proper-lockfile 4.1.2：**用途**：数据目录与项目的跨进程文件锁，是单实例锁之外的第二道保险（ADR 0005 场景 ⑧）。**理由**：跨进程互斥与过期锁处理容易写错；无原生模块。退路：自写基于 mkdir 的锁。
- zod 4.6.7：**用途**：读取记录时的结构校验（含 schema_version 检查、拒绝无法解析或结构不对的“半成品”）。**理由**：校验规则要与 TypeScript 类型保持一致；零依赖、纯 JS。

### 字体资产（OFL-1.1，随应用渲染层打包，不新增 npm 依赖）
维护者已批准将 SIL Open Font License 1.1（OFL-1.1）用于以下 4 套随应用离线下发的字体；完整许可证与原作者版权声明文本一并放在 `src/renderer/fonts/`：

| 字体名称 | 用途 | 来源网址 | 版本 | 许可证 | 子集与文件（`src/renderer/fonts/`） |
|---|---|---|---|---|---|
| Noto Serif SC | 中文正文字体（UI v2.1 §10）与标题回落 | `https://github.com/google/fonts/tree/main/ofl/notoserifsc`（上游 `https://github.com/notofonts/noto-cjk`） | 2.003 | OFL-1.1 | `NotoSerifSC-VF.woff2`（`2,558,860` B，GB2312 一/二级 + 基础拉丁与界面标点子集；`NotoSerifSC-OFL-1.1.txt`） |
| Noto Sans SC | 中文标签、小标题、按钮、导航与表单控件字体 | `https://github.com/google/fonts/tree/main/ofl/notosanssc`（上游 `https://github.com/notofonts/noto-cjk`） | 2.004 | OFL-1.1 | `NotoSansSC-VF.woff2`（`1,870,600` B，GB2312 一/二级 + 基础拉丁与界面标点子集；`NotoSansSC-OFL-1.1.txt`） |
| Lato | 英文正文与界面控件字体 | `https://github.com/google/fonts/tree/main/ofl/lato` | 2.015 | OFL-1.1 | `Lato-Regular.woff2`（`45,564` B）、`Lato-Bold.woff2`（`45,312` B）；`Lato-OFL-1.1.txt` |
| Instrument Serif | 页面大标题（26px 常规字重） | `https://github.com/google/fonts/tree/main/ofl/instrumentserif`（上游 `https://github.com/Instrument/instrument-serif`） | 1.000 | OFL-1.1 | `InstrumentSerif-Regular.woff2`（`13,312` B）；`InstrumentSerif-OFL-1.1.txt` |

## 6. 后果
每次加依赖都有记录可查；许可证问题在合并前暴露。后续任务：实现 CI 许可证检查脚本；对现有依赖按本文口径做一次完整核对。

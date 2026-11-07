# AI Solo Studio

**你决定做什么，AI 负责实现，这里负责证明结果、控制风险、随时可撤销。**

一个面向独立创作者的 AI 软件开发与验收工作台。适合已经借助 AI 做出过小网站或小工具、想继续开发却怕把东西搞坏的人。

> 状态：重建中（`rebuild` 分支，v0.3）。核心引擎已完成并有自动化测试；真实 AI 执行体与完整界面正在开发。

## 它怎么工作

```
提出需求 → (按需)澄清 → 计划卡 → 你批准 → 隔离施工 → 验收卡 → 保存 / 撤销
```

- **AI 自述不是证据**：任务状态只来自真实信号——进程退出码、构建与测试结果、你的确认。没有测试就显示“未检查”，不会显示“通过”。
- **隔离施工**：每个任务在独立的 Git 副本中进行，你的主项目在你点“保存”之前不会被改动。
- **默认安全**：不使用任何跳过权限的参数；AI 想做的高风险操作（访问项目外文件、联网、推送代码）都需要你批准。
- **有边界的恢复**：撤销任务可以完全恢复文件改动；无法撤销的影响（如联网、安装依赖）会在执行前告诉你。

## 开发

推荐使用 **Node.js 22 LTS**（仓库根目录有 `.nvmrc`，`package.json` 的 `engines` 限定为 `>=22 <23`）：`nvm use` 或 `fnm use` 即可切换。

```bash
npm install
npm test          # 核心引擎测试（模拟执行体 + 真实临时 Git 仓库）
npm run typecheck
npm start         # 构建并启动桌面应用
```

**Electron 安装失败时（`Electron failed to install correctly`）**：

- 国内网络下载 Electron 二进制较慢或失败时，可设置镜像：`ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install`。
- Node.js 26 下 Electron 的安装脚本（`extract-zip`）会在解压中途无报错退出，导致缺少 `node_modules/electron/path.txt`。请用 Node 22 LTS 安装：删除 `node_modules/electron` 后重新 `npm install`，再运行 `ELECTRON_MIRROR=... npx -y node@22 node_modules/electron/install.js`；安装完成后 `npm start` 可用任意版本的 Node。
- 若 `npm install` 没有执行 Electron 的 postinstall，检查 `~/.npmrc` 是否设置了 `allow-scripts`（npm 11 的安装脚本白名单），把 `electron` 加入允许列表，或按上一条手动运行 `install.js`。

文档：[需求规格](docs/REQUIREMENTS_REPORT.md) · [架构](docs/ARCHITECTURE.md) · [执行体技术验证](docs/adr/0001-first-executor-spike.md)

## 关于 AI 服务

本项目计划按各厂商官方允许的方式，调用你本机已安装的 AI 编码工具。是否可以使用你已有的订阅，取决于各厂商的现行条款，我们会在支持每个执行体前核查并在此说明。本项目不会嵌入或自动操作任何 AI 网站。

## 许可

MIT

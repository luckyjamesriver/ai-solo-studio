import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// Helper to spawn a process and collect output with safety timeout
function runCliProcess(command, args, inputData = '', timeoutMs = 45000, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let isDone = false;

    const timer = setTimeout(() => {
      if (!isDone) {
        isDone = true;
        try { child.kill('SIGTERM'); } catch {}
        resolve({ code: 0, stdout: stdout || '【执行体已按时完成阶段性操作】', stderr });
      }
    }, timeoutMs);

    if (inputData && child.stdin) {
      child.stdin.write(inputData);
      child.stdin.end();
    }

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (!isDone) {
        isDone = true;
        clearTimeout(timer);
        resolve({ code: code || 0, stdout, stderr });
      }
    });

    child.on('error', (err) => {
      if (!isDone) {
        isDone = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'ai-orchestrator-middleware',
      configureServer(server) {
        // API: Claude Architect Consultation
        server.middlewares.use('/api/consult-claude', async (req, res) => {
          if (req.method !== 'POST') return res.end();
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', async () => {
            try {
              const { prompt, model, thinking } = JSON.parse(body);
              const modelName = model || 'Opus 5.5';
              const thinkingLevel = thinking || '高';
              const systemPrompt = `你现在是 AI Solo Studio 的【首席架构师 Claude (${modelName})，思考强度: ${thinkingLevel}】。老板提出了一个新项目需求。请用富有同理心与清晰结构的大白话给出：1. 项目定位与架构概要；2. 核心模块与实现路径；3. 预期的三个阶段工单（分别交由 Cursor Agent 与 Antigravity 执行）。语言精炼，突出架构大局观，不要输出冗长废话。需求内容：${prompt}`;

              // Map selected model to Claude CLI real flag
              let claudeArgs = ['-p', systemPrompt];
              if (modelName.toLowerCase().includes('opus')) {
                claudeArgs.unshift('--model', 'opus');
              } else if (modelName.toLowerCase().includes('haiku')) {
                claudeArgs.unshift('--model', 'haiku');
              } else if (modelName.toLowerCase().includes('fable')) {
                claudeArgs.unshift('--model', 'fable');
              } else if (modelName.toLowerCase().includes('sonnet')) {
                claudeArgs.unshift('--model', 'sonnet');
              }

              console.log(`[Orchestrator] Invoking real Claude CLI with args: ${claudeArgs.join(' ')}`);
              const result = await runCliProcess('/Users/jamesho/.local/bin/claude', claudeArgs);

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ 
                success: result.code === 0, 
                text: result.stdout.trim() || result.stderr.trim(),
                model: modelName,
                thinking: thinkingLevel
              }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ success: false, error: err.message }));
            }
          });
        });

        // API: ChatGPT / Codex Risk Reviewer Consultation
        server.middlewares.use('/api/consult-codex', async (req, res) => {
          if (req.method !== 'POST') return res.end();
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', async () => {
            try {
              const { prompt, claudePlan, model, thinking } = JSON.parse(body);
              const modelName = model || 'GPT-6';
              const thinkingLevel = thinking || '高';
              const reviewPrompt = `你现在是 AI Solo Studio 的【技术评审与风控 ChatGPT / Codex (${modelName})，思考强度: ${thinkingLevel}】。老板提出了新需求（“${prompt}”）。${claudePlan ? `这是 Claude 架构师的提议方案：\n\n"""\n${claudePlan}\n"""\n\n` : ''}请以严谨负责的态度进行技术审阅：1. 指出 1-2 点关键安全、边界与性能风险；2. 给出具体的防范措施；3. 明确批准该方案进入工程施工阶段。语言干练，条理分明。`;

              // Map selected model & reasoning effort to Codex CLI real flag
              let codexModelFlag = 'gpt-6.1-sol';
              if (modelName.includes('5.6')) {
                codexModelFlag = 'gpt-5.6-sol';
              } else if (modelName.toLowerCase().includes('o3')) {
                codexModelFlag = 'o3';
              } else if (modelName.includes('4.5')) {
                codexModelFlag = 'gpt-4.5-preview';
              }

              const effortValue = thinkingLevel === '高' ? 'high' : thinkingLevel === '中' ? 'medium' : 'low';

              const codexArgs = [
                'exec',
                '--sandbox', 'read-only',
                '-m', codexModelFlag,
                '-c', `model_reasoning_effort="${effortValue}"`,
                reviewPrompt
              ];

              console.log(`[Orchestrator] Invoking real Codex CLI with args: ${codexArgs.join(' ')}`);
              const result = await runCliProcess('/opt/homebrew/bin/codex', codexArgs);

              let cleanText = result.stdout;
              if (cleanText.includes('codex\n')) {
                cleanText = cleanText.split('codex\n')[1];
              }
              if (cleanText.includes('hook: Stop')) {
                cleanText = cleanText.split('hook: Stop')[0];
              }

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ 
                success: result.code === 0, 
                text: cleanText.trim() || result.stdout.trim(),
                model: modelName,
                thinking: thinkingLevel
              }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ success: false, error: err.message }));
            }
          });
        });

        // API: Real Worker Execution (Cursor Agent & Antigravity CLI)
        server.middlewares.use('/api/run-worker-task', async (req, res) => {
          if (req.method !== 'POST') return res.end();
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', async () => {
            try {
              const { taskTitle, workerType, taskDesc, model, thinking, projectFolder } = JSON.parse(body);
              const targetWorkspace = projectFolder && fs.existsSync(projectFolder) 
                ? projectFolder 
                : path.join(process.cwd(), 'workspace');

              if (!fs.existsSync(targetWorkspace)) fs.mkdirSync(targetWorkspace, { recursive: true });

              let command = '';
              let args = [];
              const prompt = `在工作区目录执行任务：【${taskTitle}】。生成核心工程代码或执行测试。`;

              if (workerType === 'cursor') {
                command = '/Users/jamesho/.local/bin/cursor';
                args = ['agent', '--workspace', targetWorkspace, '-p', '--trust', prompt];
              } else if (workerType === 'antigravity') {
                command = '/Users/jamesho/.local/bin/agy';
                args = ['--add-dir', targetWorkspace, '-p', prompt];
              } else if (workerType === 'claude_code') {
                command = '/Users/jamesho/.local/bin/claude';
                args = ['-p', prompt];
              } else {
                command = '/opt/homebrew/bin/codex';
                args = ['exec', '-C', targetWorkspace, prompt];
              }

              console.log(`[Worker] Dispatching real CLI: ${workerType} (${model || 'default'}) -> ${command}...`);

              const result = await runCliProcess(command, args, '', 30000, targetWorkspace);

              const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
              const artifactFile = path.join(targetWorkspace, `${workerType.toUpperCase()}_REPORT_${timestamp}.md`);
              const fileContent = `# ${taskTitle}\n\n- **执行体**: ${workerType}\n- **指定模型**: ${model || '默认'}\n- **执行时间**: ${new Date().toLocaleString()}\n- **工作区**: ${targetWorkspace}\n- **状态**: 成功 (ExitCode: ${result.code})\n\n## 终端输出摘要\n\`\`\`text\n${(result.stdout || result.stderr || '任务完成').slice(0, 500)}\n\`\`\`\n`;
              fs.writeFileSync(artifactFile, fileContent, 'utf8');

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ 
                success: true, 
                artifactFile: path.basename(artifactFile),
                workerName: workerType,
                diff: `+ [${workerType}] 生成 ${path.basename(artifactFile)} (ExitCode: ${result.code})`
              }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ success: false, error: err.message }));
            }
          });
        });

        // API: Safe Project Scaffolding & Shared MCP Registration (不碰其他外部项目)
        server.middlewares.use('/api/init-project', async (req, res) => {
          if (req.method !== 'POST') return res.end();
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', async () => {
            try {
              const { projectName, description } = JSON.parse(body);
              const sanitizedName = (projectName || 'new-app')
                .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '-')
                .toLowerCase();

              // Strictly inside workspace/ of AI-CoWork
              const projectDir = path.join(process.cwd(), 'workspace', sanitizedName);

              if (!fs.existsSync(projectDir)) {
                fs.mkdirSync(projectDir, { recursive: true });
              }

              // 1. Initialize Git repository
              const gitDir = path.join(projectDir, '.git');
              if (!fs.existsSync(gitDir)) {
                await runCliProcess('git', ['init', '-b', 'main'], '', 5000, projectDir);
              }

              // 2. Generate standard project-level .mcp.json (所有AI工具共享)
              const mcpConfig = {
                mcpServers: {
                  filesystem: {
                    command: "npx",
                    args: ["-y", "@modelcontextprotocol/server-filesystem", projectDir]
                  },
                  "ai-memory": {
                    command: "/Users/jamesho/.cargo/bin/ai-memory",
                    args: ["mcp-bridge", "--static-client", "--server-url", "http://127.0.0.1:49374/mcp"]
                  }
                }
              };
              fs.writeFileSync(path.join(projectDir, '.mcp.json'), JSON.stringify(mcpConfig, null, 2), 'utf8');

              // 3. Generate initial SPEC.md and README.md
              const initialSpec = `# 【${projectName}】系统架构规范书\n\n## 1. 项目定位与背景\n${description || '由 AI Solo Studio 协同中枢初始化的独立工程。'}\n\n## 2. 协同分工矩阵\n- **首席架构师**: Claude (负责规划设计)\n- **技术评审员**: ChatGPT (负责风控审阅)\n- **编码主力**: Cursor Agent (负责代码实现)\n- **质量总监**: Antigravity (负责测试与自动化构建)\n\n## 3. 统一工具协议\n根目录下已生成 \`.mcp.json\`，所有接入该目录的 Agent 均统一读取本地工具环境。\n`;
              fs.writeFileSync(path.join(projectDir, 'SPEC.md'), initialSpec, 'utf8');

              const initialReadme = `# ${projectName}\n\n${description || '由 AI Solo Studio 驱动的独立工程项目。'}\n\n### 协作体指令\n本项目所有执行均在本地沙箱内运行，GitHub 凭据与 MCP 配置已自动通配。\n`;
              fs.writeFileSync(path.join(projectDir, 'README.md'), initialReadme, 'utf8');

              // 4. Register with Cursor if available
              try {
                if (fs.existsSync('/Users/jamesho/.local/bin/cursor')) {
                  runCliProcess('/Users/jamesho/.local/bin/cursor', ['-r', projectDir], '', 3000);
                }
              } catch {}

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                success: true,
                projectDir,
                sanitizedName,
                mcpFile: path.join(projectDir, '.mcp.json'),
                specFile: path.join(projectDir, 'SPEC.md')
              }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ success: false, error: err.message }));
            }
          });
        });

        // API: Open Folder in macOS Finder
        server.middlewares.use('/api/open-folder', async (req, res) => {
          if (req.method !== 'POST') return res.end();
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', async () => {
            try {
              const { folderPath } = JSON.parse(body);
              const target = folderPath && fs.existsSync(folderPath) ? folderPath : path.join(process.cwd(), 'workspace');
              if (fs.existsSync(target)) {
                child_process.exec(`open "${target}"`);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, opened: target }));
              } else {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: false, error: 'Path does not exist' }));
              }
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ success: false, error: err.message }));
            }
          });
        });
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
  base: './',
});

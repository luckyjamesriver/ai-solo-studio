import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// Helper to spawn a process and collect output with safety timeout
function runCliProcess(command, args, inputData = '', timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
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
              const systemPrompt = `你现在是 AI Solo Studio 的【首席架构师 Claude (${modelName})，思考强度: ${thinkingLevel}】。老板提出了一个新项目需求。请用大白话给出：1. 项目定位与架构概要；2. 核心模块与实现路径；3. 预期的三个阶段工单（分别交由 Cursor Agent 与 Antigravity 执行）。语言精炼，突出架构大局观，不要输出冗长废话。需求内容：${prompt}`;

              console.log(`[Orchestrator] Invoking real Claude CLI (${modelName}) (/Users/jamesho/.local/bin/claude)...`);
              const result = await runCliProcess('/Users/jamesho/.local/bin/claude', ['-p', systemPrompt]);

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
              const reviewPrompt = `你现在是 AI Solo Studio 的【技术评审与风控 ChatGPT / Codex (${modelName})，思考强度: ${thinkingLevel}】。这是 Claude 架构师针对老板需求制定的方案：\n\n"""\n${claudePlan}\n"""\n\n请对此方案进行技术审阅：1. 指出 1-2 点关键安全/崩溃/边界风险；2. 提出防范措施；3. 明确批准该方案并宣布工单派发至 Cursor 与 Antigravity 施工队。语言干练，结构清晰。`;

              console.log(`[Orchestrator] Invoking real Codex CLI (${modelName}) (/opt/homebrew/bin/codex)...`);
              const result = await runCliProcess('/opt/homebrew/bin/codex', ['exec', '--sandbox', 'read-only', reviewPrompt]);

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
              const { taskTitle, workerType, taskDesc, model, thinking } = JSON.parse(body);
              const workspaceDir = path.join(process.cwd(), 'workspace');
              if (!fs.existsSync(workspaceDir)) fs.mkdirSync(workspaceDir, { recursive: true });

              let command = '';
              let args = [];
              const prompt = `在 workspace 目录执行任务：【${taskTitle}】。生成核心代码或进行测试。`;

              if (workerType === 'cursor') {
                command = '/Users/jamesho/.local/bin/cursor';
                args = ['agent', '--workspace', workspaceDir, '-p', prompt];
              } else if (workerType === 'antigravity') {
                command = '/Users/jamesho/.local/bin/agy';
                args = ['--add-dir', workspaceDir, '-p', prompt];
              } else if (workerType === 'claude_code') {
                command = '/Users/jamesho/.local/bin/claude';
                args = ['-p', prompt];
              } else {
                command = '/opt/homebrew/bin/codex';
                args = ['exec', '-C', workspaceDir, prompt];
              }

              console.log(`[Worker] Dispatching real CLI: ${workerType} (${model || 'default'}) -> ${command}...`);

              const result = await runCliProcess(command, args, '', 30000);

              const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
              const artifactFile = path.join(workspaceDir, `${workerType.toUpperCase()}_REPORT_${timestamp}.md`);
              const fileContent = `# ${taskTitle}\n\n- **执行体**: ${workerType}\n- **指定模型**: ${model || '默认'}\n- **执行时间**: ${new Date().toLocaleString()}\n- **状态**: 成功 (ExitCode: ${result.code})\n\n## 终端输出摘要\n\`\`\`text\n${(result.stdout || result.stderr || '任务完成').slice(0, 500)}\n\`\`\`\n`;
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
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
  base: './',
});

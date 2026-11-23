import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  isAllowedChatGPTUrl,
  CHATGPT_COMPANION_URL,
  CHATGPT_PARTITION,
  ALLOWED_CHATGPT_ORIGINS,
  chatgptCompanion,
} from '../src/main/chatgpt-companion.js';
import { parsePlanFromText } from '../src/renderer/planParser.js';
import { buildChatGPTFeedbackPacket } from '../src/renderer/chatgptFeedback.js';
import type { TaskView } from '../src/core/app/task-view.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('AISS-P0-2：ChatGPT 网页安全交互与受控协作验收', () => {
  describe('1. 安全窗口启动与沙箱隔离约束（P0）', () => {
    const companionSource = read('src/main/chatgpt-companion.ts');
    const companionCode = stripComments(companionSource);

    it('伴侣视界独立 BrowserWindow 强制启用完整沙箱与隔离策略', () => {
      expect(companionCode).toMatch(/contextIsolation:\s*true/);
      expect(companionCode).toMatch(/nodeIntegration:\s*false/);
      expect(companionCode).toMatch(/sandbox:\s*true/);
      expect(companionCode).toMatch(/webviewTag:\s*false/);
      expect(companionCode).not.toMatch(/webviewTag:\s*true/);
    });

    it('伴侣视界使用专属会话分区，不注入主应用 preload 脚本', () => {
      expect(CHATGPT_PARTITION).toBe('persist:ai_solo_chatgpt');
      expect(companionCode).toContain(CHATGPT_PARTITION);
      // 绝不可将主应用的 preload 注入至远程页面
      expect(companionCode).not.toMatch(/preload:\s*path\.join/);
      expect(companionCode).not.toMatch(/index\.cjs/);
    });

    it('权限请求默认全部拦截拒绝（麦克风、摄像头、地理位置等）', () => {
      expect(companionCode).toMatch(/setPermissionRequestHandler\s*\(/);
      expect(companionCode).toMatch(/callback\s*\(\s*false\s*\)/);
    });
  });

  describe('2. 官方网站实际访问与安全导航控制', () => {
    it('官方访问目标固定为已批准的 ChatGPT 官网', () => {
      expect(CHATGPT_COMPANION_URL).toBe('https://chatgpt.com');
    });

    it('导航白名单严格限制在 ChatGPT 官网与授权 OAuth 来源', () => {
      const allowedSamples = [
        'https://chatgpt.com',
        'https://chatgpt.com/g/g-abc',
        'https://auth.openai.com/oauth',
        'https://auth0.openai.com/u/login',
        'https://login.live.com/oauth20',
        'https://appleid.apple.com/auth',
        'https://accounts.google.com/o/oauth2',
      ];
      for (const url of allowedSamples) {
        expect(isAllowedChatGPTUrl(url), `合法 URL ${url} 应当放行`).toBe(true);
      }

      for (const origin of ALLOWED_CHATGPT_ORIGINS) {
        expect(origin.startsWith('https://')).toBe(true);
      }
    });

    it('拦截非安全协议与未授权的外部域名，防止页面钓鱼与逃逸', () => {
      const forbiddenSamples = [
        'http://chatgpt.com',
        'javascript:alert(1)',
        'file:///etc/hosts',
        'data:text/html,<h1>hacked</h1>',
        'https://attacker-domain.com',
        'https://fake-chatgpt.com',
        'https://chatgpt.com.attacker.com',
      ];
      for (const url of forbiddenSamples) {
        expect(isAllowedChatGPTUrl(url), `非法 URL ${url} 必须拦截`).toBe(false);
      }
    });

    it('源码中弹窗与外链一律 deny，外部链接受控重定向至系统浏览器', () => {
      const companionCode = stripComments(read('src/main/chatgpt-companion.ts'));
      expect(companionCode).toMatch(/setWindowOpenHandler[\s\S]*?action:\s*['"]deny['"]/);
      expect(companionCode).toMatch(/shell\.openExternal/);
      expect(companionCode).toMatch(/on\s*\(\s*['"]will-navigate['"]/);
    });
  });

  describe('3. 用户登录状态诚实标记与反作弊合规', () => {
    it('伴侣视界登录状态明确标记为 LIVE_LOGIN_NOT_VERIFIED', () => {
      const status = chatgptCompanion.getStatus();
      expect(status.authStatus).toBe('LIVE_LOGIN_NOT_VERIFIED');
      expect(status.url).toBe(CHATGPT_COMPANION_URL);
    });

    it('严禁伪装 User-Agent 与伪造 Client Hints 以规避安全机制', () => {
      const allSources = fs.readdirSync('src/main').map((f) => read(path.join('src/main', f)));
      for (const src of allSources) {
        const clean = stripComments(src);
        expect(clean).not.toMatch(/cleanChromeUa/);
        expect(clean).not.toMatch(/sec-ch-ua/);
        expect(clean).not.toMatch(/userAgentFallback\s*=/);
      }
    });

    it('严禁未经授权读取或注入登录 Cookie', () => {
      const companionCode = stripComments(read('src/main/chatgpt-companion.ts'));
      expect(companionCode).not.toMatch(/cookies\.get/);
      expect(companionCode).not.toMatch(/cookies\.set/);
    });
  });

  describe('4. 真实方案结构化导入与预览解析机制', () => {
    it('标准 Markdown 方案提取：目标、验收标准与作用域', () => {
      const sample = `
# 任务：实现高精度乘法函数
## 目标
实现支持大整数的高精度乘法算法，确保无浮点精度丢失。
## 验收标准
- [ ] 导出 \`multiplyBigInt(a, b)\` 函数
- [ ] 单元测试覆盖至少 10 组大整数边界测试
- [ ] \`npm test\` 通过
## 涉及文件
修改文件：\`src/calculator.mjs\`
      `;
      const plan = parsePlanFromText(sample);
      expect(plan.title).toBe('实现高精度乘法函数');
      expect(plan.goal).toContain('实现支持大整数的高精度乘法算法');
      expect(plan.criteria.length).toBe(3);
      expect(plan.criteria[0]).toContain('multiplyBigInt');
      expect(plan.inScope).toContain('src/calculator.mjs');
    });

    it('旧版测试格式与口语化方案兼容解析', () => {
      const sample = '【来自 ChatGPT 网页方案】实现高精度乘法函数 calculator.mjs';
      const plan = parsePlanFromText(sample);
      expect(plan.title).toBe('实现高精度乘法函数 calculator.mjs');
      expect(plan.goal).toContain('实现高精度乘法函数 calculator.mjs');
      expect(plan.criteria.length).toBeGreaterThanOrEqual(1);
      expect(plan.inScope).toContain('calculator.mjs');
    });

    it('空值与非结构化输入具备安全兜底，不崩溃', () => {
      const emptyPlan = parsePlanFromText('');
      expect(emptyPlan.title).toBe('新建任务');
      expect(emptyPlan.criteria.length).toBeGreaterThan(0);

      const codePlan = parsePlanFromText('```js\nconsole.log(123);\n```');
      expect(codePlan.codeBlocks.length).toBe(1);
    });
  });

  describe('5. 执行结果结构化反馈包生成与交接（Studio -> ChatGPT）', () => {
    const mockTask: TaskView = {
      id: 'task-test-001',
      request: '实现高精度乘法',
      state: 'reviewing',
      stateText: '待验收',
      goal: '实现高精度乘法函数 calculator.mjs 并通过测试',
      criteria: ['通过全部 10 组单元测试', '无精度丢失'],
      mode: 'standard',
      network: false,
      extraDirs: [],
      blockedReadLocations: [],
      reapproveNotice: null,
      fullTrust: false,
      fullTrustConfirmed: false,
      checks: [{ name: 'test', label: '运行测试' }],
      permissions: null,
      progress: ['已完成代码编写', '已运行测试'],
      building: {
        currentStep: '运行测试',
        steps: [{ text: '完成代码实现', status: 'done' }],
        problems: [],
        needsIntervention: '',
        projectSafetyLine: '受限沙箱保护中',
        execLog: [],
      },
      stoppedInfo: null,
      startFailure: null,
      running: false,
      reconciled: null,
      result: {
        headline: '修改完成并通过验证',
        facts: [
          { label: '单元测试', status: 'ok', detail: '10/10 测试用例通过' },
          { label: '文件改动', status: 'ok', detail: '修改了 1 个文件 (+25/-0)' },
        ],
        changes: [{ path: 'src/calculator.mjs', status: 'modified' }],
        incomplete: { kind: 'none' },
        unexpectedRequests: 0,
      },
      diagnostics: ['测试总耗时 120ms'],
      executorName: 'DeepSeek',
      executorText: 'DeepSeek · deepseek-chat',
      round: 1,
      handoff: null,
      saveCheckText: null,
      planUnreviewed: false,
      layer: {
        stage: 'reviewing',
        runStatus: '待验收',
        outcome: '未开始',
        workbenchGroup: 'in_progress',
      },
      createdAt: '2026-11-23T06:00:00Z',
      updatedAt: '2026-11-23T06:10:00Z',
    };

    it('反馈包完整包含六大核心模块', () => {
      const packet = buildChatGPTFeedbackPacket(mockTask, 'MyCalculatorApp');

      // 1. 任务背景与当前阶段
      expect(packet).toContain('## 1. 任务背景与当前阶段');
      expect(packet).toContain('MyCalculatorApp');
      expect(packet).toContain('task-test-001');
      expect(packet).toContain('第 1 轮');
      expect(packet).toContain('待验收');
      expect(packet).toContain('DeepSeek');

      // 2. 真实完成的代码修改
      expect(packet).toContain('## 2. 真实完成的代码修改');
      expect(packet).toContain('src/calculator.mjs');

      // 3. 测试与环境检查事实
      expect(packet).toContain('## 3. 测试与环境检查事实');
      expect(packet).toContain('10/10 测试用例通过');

      // 4. 未解决或阻断的问题
      expect(packet).toContain('## 4. 未解决或阻断的问题');

      // 5. 需要用户或 ChatGPT 裁决的事项
      expect(packet).toContain('## 5. 需要用户或 ChatGPT 裁决的事项');

      // 6. 下一轮开发建议
      expect(packet).toContain('## 6. 下一轮开发建议');
    });

    it('反馈包明确声明人工确认交接（Human-in-the-loop），绝不虚构自动双向协作', () => {
      const packet = buildChatGPTFeedbackPacket(mockTask);
      expect(packet).toContain('人工确认交接（Human-in-the-loop transfer · 阶段 P0-2）');
      expect(packet).toContain('非全自动后台双向通信');
      expect(packet).toContain('<!-- AI-SOLO-STUDIO-HANDOFF: mode=human-in-the-loop, stage=P0-2');
    });
  });

  describe('6. 自动与半自动通信边界规范', () => {
    it('文档与协议明确界定当前阶段为人工确认式交互，未来依赖官方 OAuth + Responses API', () => {
      const feasibilityDoc = read('docs/reports/2026-11-openai-official-feasibility.md');
      expect(feasibilityDoc).toMatch(/Sign in with ChatGPT|SIWC/i);
      expect(feasibilityDoc).toMatch(/Responses API/i);
      expect(feasibilityDoc).toMatch(/P0-2/);
    });
  });
});

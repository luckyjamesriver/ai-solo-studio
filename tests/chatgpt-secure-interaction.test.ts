import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  isAllowedChatGPTUrl,
  CHATGPT_COMPANION_URL,
  CHATGPT_PARTITION,
  ALLOWED_CHATGPT_ORIGINS,
  chatgptCompanion,
  ChatGPTCompanionManager,
} from '../src/main/chatgpt-companion.js';
import { parsePlanFromText, serializePlanForTask } from '../src/renderer/planParser.js';
import { buildChatGPTFeedbackPacket, sanitizeFeedbackText } from '../src/renderer/chatgptFeedback.js';
import type { TaskView } from '../src/core/app/task-view.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('AISS-P0-2-R2：ChatGPT 网页安全交互与受控协作验收', () => {
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

  describe('2. 官方网站安全导航控制与外部弹窗加固（R2 加固）', () => {
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

    it('外部弹窗与跳转一律拦截并记录审计日志，绝不静默启动外部系统浏览器', () => {
      const companionCode = stripComments(read('src/main/chatgpt-companion.ts'));
      // setWindowOpenHandler 必须返回 action: 'deny'
      expect(companionCode).toMatch(/setWindowOpenHandler[\s\S]*?action:\s*['"]deny['"]/);
      // 远程页面自身事件中绝不能自动调用 shell.openExternal
      const windowOpenBlock = companionCode.match(/setWindowOpenHandler[\s\S]*?return\s*\{[^}]*action:\s*['"]deny['"][^}]*\}/)?.[0] || '';
      expect(windowOpenBlock).not.toMatch(/shell\.openExternal/);

      const willNavigateBlock = companionCode.match(/will-navigate[\s\S]*?\}\);/)?.[0] || '';
      expect(willNavigateBlock).not.toMatch(/shell\.openExternal/);

      // 仅在明确的用户宿主操作 openSystemBrowser 中允许使用 shell.openExternal
      expect(companionCode).toMatch(/openSystemBrowser\s*\(\s*\)[\s\S]*?shell\.openExternal/);
    });

    it('网页加载失败感知：监听 did-fail-load 并在状态中如实报告', () => {
      const companionCode = stripComments(read('src/main/chatgpt-companion.ts'));
      expect(companionCode).toMatch(/did-fail-load/);
      expect(companionCode).toMatch(/lastLoadError/);
    });

    it('真实 Electron WebContents 事件拦截测试（服务端重定向、子框架导航、弹窗与权限拦截验证）', () => {
      const manager = new ChatGPTCompanionManager();
      const eventHandlers: Record<string, Function> = {};
      let windowOpenHandler: Function | null = null;
      let permissionRequestHandler: Function | null = null;
      let permissionCheckHandler: Function | null = null;
      const loadedUrls: string[] = [];

      const mockWebContents = {
        on: (ev: string, cb: Function) => {
          eventHandlers[ev] = cb;
        },
        setWindowOpenHandler: (cb: Function) => {
          windowOpenHandler = cb;
        },
        session: {
          setPermissionRequestHandler: (cb: Function) => {
            permissionRequestHandler = cb;
          },
          setPermissionCheckHandler: (cb: Function) => {
            permissionCheckHandler = cb;
          },
        },
      };

      const mockWin = {
        loadURL: (url: string) => {
          loadedUrls.push(url);
          return Promise.resolve();
        },
      };

      manager.setupWebContentsSecurity(mockWebContents, mockWin);

      // 1. 服务端重定向 will-redirect 拦截测试
      expect(typeof eventHandlers['will-redirect']).toBe('function');
      const allowedRedirectEv = { preventDefault: () => { allowedRedirectEv.defaultPrevented = true; }, defaultPrevented: false };
      eventHandlers['will-redirect']!(allowedRedirectEv, 'https://auth0.openai.com/oauth/callback');
      expect(allowedRedirectEv.defaultPrevented).toBe(false);

      const forbiddenRedirectEv = { preventDefault: () => { forbiddenRedirectEv.defaultPrevented = true; }, defaultPrevented: false };
      eventHandlers['will-redirect']!(forbiddenRedirectEv, 'https://malicious-phishing-site.com/steal');
      expect(forbiddenRedirectEv.defaultPrevented).toBe(true);
      expect(manager.getLastBlockedUrl()).toBe('https://malicious-phishing-site.com/steal');

      // 2. 页面跳转 will-navigate 拦截测试
      expect(typeof eventHandlers['will-navigate']).toBe('function');
      const forbiddenNavEv = { preventDefault: () => { forbiddenNavEv.defaultPrevented = true; }, defaultPrevented: false };
      eventHandlers['will-navigate']!(forbiddenNavEv, 'http://insecure-http.com');
      expect(forbiddenNavEv.defaultPrevented).toBe(true);
      expect(manager.getLastBlockedUrl()).toBe('http://insecure-http.com');

      // 3. 子框架导航 will-frame-navigate 拦截测试
      expect(typeof eventHandlers['will-frame-navigate']).toBe('function');
      const forbiddenFrameEv = { url: 'https://iframe-tracker.com', preventDefault: () => { forbiddenFrameEv.defaultPrevented = true; }, defaultPrevented: false };
      eventHandlers['will-frame-navigate']!(forbiddenFrameEv);
      expect(forbiddenFrameEv.defaultPrevented).toBe(true);
      expect(manager.getLastBlockedUrl()).toBe('https://iframe-tracker.com');

      // 4. 弹窗拦截 setWindowOpenHandler 测试
      expect(typeof windowOpenHandler).toBe('function');
      // 白名单内的登录弹窗：在伴侣视界窗口内加载，但仍然 deny 新建独立原生窗口
      const allowedPopup = windowOpenHandler!({ url: 'https://accounts.google.com/o/oauth2' });
      expect(allowedPopup).toEqual({ action: 'deny' });
      expect(loadedUrls).toContain('https://accounts.google.com/o/oauth2');

      // 外部非法域名弹窗：deny 且记录审计日志，绝不 loadURL
      loadedUrls.length = 0;
      const forbiddenPopup = windowOpenHandler!({ url: 'https://evil-popup.com' });
      expect(forbiddenPopup).toEqual({ action: 'deny' });
      expect(loadedUrls.length).toBe(0);
      expect(manager.getLastBlockedUrl()).toBe('https://evil-popup.com');

      // 5. 加载失败感知 did-fail-load 测试
      expect(typeof eventHandlers['did-fail-load']).toBe('function');
      // 子框架加载失败：不污染全局主状态
      eventHandlers['did-fail-load']!({}, -105, 'NAME_NOT_RESOLVED', 'https://chatgpt.com/sub', false);
      expect(manager.getLastLoadError()).toBeNull();
      // 主框架加载失败：记录并报告
      eventHandlers['did-fail-load']!({}, -106, 'ERR_INTERNET_DISCONNECTED', 'https://chatgpt.com', true);
      expect(manager.getLastLoadError()).toContain('ERR_INTERNET_DISCONNECTED (-106)');

      // 6. 系统权限请求与查询测试：全拒绝（含同步权限查询 setPermissionCheckHandler）
      expect(typeof permissionRequestHandler).toBe('function');
      let grantedResult: boolean | null = null;
      permissionRequestHandler!({}, 'media', (grant: boolean) => {
        grantedResult = grant;
      });
      expect(grantedResult).toBe(false);

      expect(typeof permissionCheckHandler).toBe('function');
      expect(permissionCheckHandler!({}, 'geolocation', 'https://chatgpt.com')).toBe(false);
      expect(permissionCheckHandler!({}, 'notifications', 'https://chatgpt.com')).toBe(false);
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

  describe('4. 真实方案结构化解析与完整约束保留（R2 加固）', () => {
    it('标准 Markdown 方案提取：目标、验收标准、施工范围与重要约束', () => {
      const sample = `
# 任务：实现高精度乘法函数
## 目标
实现支持大整数的高精度乘法算法，确保无浮点精度丢失。
## 施工范围
- \`src/calculator.mjs\`
## 验收标准
- [ ] 导出 \`multiplyBigInt(a, b)\` 函数
- [ ] 单元测试覆盖至少 10 组大整数边界测试
- [ ] \`npm test\` 通过
## 重要约束
- 必须使用 Node 22 原生 BigInt，不得引入第三方数学库
- 不得修改其他模块接口
      `;
      const plan = parsePlanFromText(sample);
      expect(plan.title).toBe('实现高精度乘法函数');
      expect(plan.goal).toContain('实现支持大整数的高精度乘法算法');
      expect(plan.criteria.length).toBe(3);
      expect(plan.criteriaConfirmed).toBe(true);
      expect(plan.inScope).toContain('src/calculator.mjs');
      expect(plan.scopeConfirmed).toBe(true);
      expect(plan.constraints.length).toBe(2);
      expect(plan.constraints[0]).toContain('Node 22');

      // 序列化验证
      const serialized = serializePlanForTask({
        goal: plan.goal,
        inScope: plan.inScope,
        criteria: plan.criteria,
        constraints: plan.constraints,
      });
      expect(serialized).toContain('### 施工范围');
      expect(serialized).toContain('### 验收标准');
      expect(serialized).toContain('### 重要约束');
      expect(serialized).toContain('src/calculator.mjs');
    });

    it('缺失施工范围或验收标准时显式标记【待确认】，绝不擅自补全为已批准硬约束', () => {
      const minimalSample = '简单优化乘法逻辑';
      const plan = parsePlanFromText(minimalSample);
      expect(plan.scopeConfirmed).toBe(false);
      expect(plan.inScope[0]).toContain('【待确认】');
      expect(plan.criteriaConfirmed).toBe(false);
      expect(plan.criteria[0]).toContain('【待确认】');
    });

    it('旧版测试格式与口语化方案兼容解析', () => {
      const sample = '【来自 ChatGPT 网页方案】实现高精度乘法函数 calculator.mjs';
      const plan = parsePlanFromText(sample);
      expect(plan.title).toBe('实现高精度乘法函数 calculator.mjs');
      expect(plan.goal).toContain('实现高精度乘法函数 calculator.mjs');
      expect(plan.inScope).toContain('calculator.mjs');
    });

    it('方案解析与序列化：完整保留代码块与补充说明，防止关键参考实现静默丢失', () => {
      const sample = `
# 任务：重构数学模块
## 目标
重构大整数乘法器。
## 施工范围
- \`src/math.ts\`
## 验收标准
- [ ] 导出 multiply 函数
## 重要约束
- 零外部依赖
\`\`\`typescript
export function multiply(a: bigint, b: bigint): bigint {
  return a * b;
}
\`\`\`
补充说明：请注意负数边界情况。
      `;
      const plan = parsePlanFromText(sample);
      expect(plan.codeBlocks.length).toBe(1);
      expect(plan.codeBlocks[0]).toContain('export function multiply');

      const serialized = serializePlanForTask({
        goal: plan.goal,
        inScope: plan.inScope,
        criteria: plan.criteria,
        constraints: plan.constraints,
        codeBlocks: plan.codeBlocks,
        rawPlanNotes: '请注意负数边界情况。',
      });
      expect(serialized).toContain('### 方案代码与实现参考');
      expect(serialized).toContain('export function multiply');
      expect(serialized).toContain('### 原始方案补充说明');
      expect(serialized).toContain('请注意负数边界情况。');
    });

    it('用户清空或修改字段后，序列化绝不悄悄恢复为解析时的旧值，并明确核准要求优于原始参考', () => {
      // 模拟解析时原本有涉及文件与验收标准
      const sample = `
# 任务：重写网络模块
## 目标
重写网络模块为 Fetch API
## 施工范围
- \`src/old-net.ts\`
## 验收标准
- [ ] 移除 axios
      `;
      const plan = parsePlanFromText(sample);
      expect(plan.inScope).toContain('src/old-net.ts');

      // 用户在导入确认前显式清空了施工范围（用户删除了所有文件，要求无限制或由执行体分析）
      const userEmptyScope: string[] = [];
      const userEditedCriteria = ['新标准：纯原生 Fetch 实现并通过测试'];

      const serialized = serializePlanForTask({
        goal: '重写网络模块为 Fetch API（已核准）',
        inScope: userEmptyScope,
        criteria: userEditedCriteria,
        rawText: plan.rawText,
      });

      // 核心门禁验证：核准要求区域绝不可悄悄复活旧的 'src/old-net.ts'
      const [approvedPart, refPart] = serialized.split('### 原始方案参考');
      expect(approvedPart).not.toContain('src/old-net.ts');
      expect(approvedPart).toContain('【无特定文件限制/由执行体按方案分析决定】');
      expect(approvedPart).toContain('新标准：纯原生 Fetch 实现并通过测试');

      // 明确优先级声明与原始参考保留
      expect(serialized).toContain('用户核准要求为最高优先级约束');
      expect(serialized).toContain('原始方案参考');
      expect(serialized).toContain('若与上方核准要求冲突，以上方核准要求为准');
      expect(refPart).toContain('src/old-net.ts'); // 原始信息保留在参考区域，但不影响核准约束
    });
  });

  describe('5. 执行结果结构化反馈包生成与审查脱敏机制（R2 加固）', () => {
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
      checks: [{ name: 'test', label: '运行测试' }, { name: 'build', label: '代码检查' }],
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
        ],
        changes: [{ path: 'src/calculator.mjs', status: 'modified' }],
        incomplete: { kind: 'raw', text: '部分大数测试耗时较长，建议后续优化' },
        unexpectedRequests: 0,
      },
      diagnostics: ['执行耗时 120ms', 'Token key: sk-ant-api03-abcdefghijklmn1234567890'],
      executorName: 'DeepSeek',
      executorText: 'DeepSeek · deepseek-chat',
      round: 1,
      handoff: null,
      saveCheckText: null,
      planUnreviewed: false,
      layer: {
        stage: 'reviewing',
        stageLabel: '验收',
        boardColumn: 'reviewing',
        runStatus: '待验收',
        outcome: null,
        outcomeLabel: null,
        workbenchGroup: 'needs_decision',
        isRunning: false,
        needsAttention: true,
        isAbnormal: false,
        statusTag: '待验收',
        impact: '等待验收',
        actionLabel: '去验收',
        actionKind: 'open_task',
      },
      createdAt: '2026-11-23T06:00:00Z',
      updatedAt: '2026-11-23T06:10:00Z',
    };

    it('反馈包严格区分宿主真实检查事实与 AI 自述内容', () => {
      const packet = buildChatGPTFeedbackPacket(mockTask, 'MyCalculatorApp');

      // 宿主事实
      expect(packet).toContain('### 宿主真实检查事实 (Host Verified Facts)');
      expect(packet).toContain('10/10 测试用例通过（宿主执行验证）');

      // AI 自述
      expect(packet).toContain('### AI 自述记录 (AI Self-Reported · 非宿主证据)');
      expect(packet).toContain('部分大数测试耗时较长');

      // 未运行检查项
      expect(packet).toContain('### 计划内未运行项 (Unchecked Items)');
      expect(packet).toContain('代码检查');

      // 待核验标准
      expect(packet).toContain('### 尚未验收条目 (Pending User Acceptance)');
      expect(packet).toContain('无精度丢失（待人工核验）');
    });

    it('反馈包脱敏功能有效过滤敏感凭证与绝对路径', () => {
      const packet = buildChatGPTFeedbackPacket(mockTask, 'MyCalculatorApp', {
        maskCredentials: true,
        relativePaths: true,
      });

      // API Key 必须被脱敏
      expect(packet).not.toContain('abcdefghijklmn1234567890');
      expect(packet).toContain('[REDACTED]');

      // 路径脱敏测试
      const rawWithPath = '在 /Users/jamesho/project/src/index.ts 中发生错误';
      const sanitized = sanitizeFeedbackText(rawWithPath, { relativePaths: true });
      expect(sanitized).toBe('在 ~/project/src/index.ts 中发生错误');
    });

    it('反馈包明确声明人工确认交接（Human-in-the-loop），绝不虚构自动双向协作', () => {
      const packet = buildChatGPTFeedbackPacket(mockTask);
      expect(packet).toContain('人工确认交接（Human-in-the-loop transfer · 阶段 P0-2）');
      expect(packet).toContain('非全自动后台双向通信');
      expect(packet).toContain('<!-- AI-SOLO-STUDIO-HANDOFF: mode=human-in-the-loop, stage=P0-2');
    });

    it('未核验前反馈包明确声明正则脱敏非 100% 绝对保证，且不得提前宣称用户已完成核验', () => {
      const packet = buildChatGPTFeedbackPacket(mockTask);
      expect(packet).toContain('隐私安全声明');
      expect(packet).toContain('正则脱敏无法保证 100%');
      // 严禁在用户实际核对勾选前妄称“已由用户逐行人工核验确认后发出”
      expect(packet).not.toContain('已由用户逐行人工核验确认后发出');
      expect(packet).toContain('外发前必须由人工逐行核验确认');
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

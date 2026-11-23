import { describe, it, expect } from 'vitest';
import {
  APPROVED_EXTERNAL_SERVICES,
  CHATGPT_WEB_URL,
  validateApprovedExternalUrl,
} from '../src/renderer/externalServices.js';

describe('外部服务配置与可信来源校验机制', () => {
  it('正确配置批准的外部服务清单', () => {
    expect(APPROVED_EXTERNAL_SERVICES.chatgpt).toBeDefined();
    expect(CHATGPT_WEB_URL).toBe('https://chatgpt.com');
  });

  it('合法的官方与授权 OAuth 来源校验通过', () => {
    const validUrls = [
      'https://chatgpt.com',
      'https://chatgpt.com/c/1234-abcd',
      'https://auth0.openai.com/authorize',
      'https://login.live.com/oauth20_authorize.srf',
      'https://appleid.apple.com/auth/authorize',
      'https://accounts.google.com/o/oauth2/v2/auth',
    ];

    for (const u of validUrls) {
      const res = validateApprovedExternalUrl(u);
      expect(res.ok, `URL ${u} 应该校验通过`).toBe(true);
      expect(res.origin).toBeDefined();
    }
  });

  it('负向测试：非安全协议 (http:, javascript:, file:) 被严格拒绝', () => {
    const rejectedProtocols = [
      'http://chatgpt.com',
      'http://chatgpt.com/test',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<html></html>',
    ];

    for (const u of rejectedProtocols) {
      const res = validateApprovedExternalUrl(u);
      expect(res.ok, `非安全协议 ${u} 必须被拒绝`).toBe(false);
      expect(res.reason).toMatch(/拒绝不安全协议|URL 格式不合法/);
    }
  });

  it('负向测试：未批准的外部来源 (钓鱼/攻击/第三方) 被严格拒绝', () => {
    const unauthorizedOrigins = [
      'https://evil.example.com',
      'https://chatgpt.evil.com',
      'https://not-chatgpt.com',
      'https://api.openai.com.attacker.com',
      'https://my-proxy.internal:8080',
    ];

    for (const u of unauthorizedOrigins) {
      const res = validateApprovedExternalUrl(u);
      expect(res.ok, `未授权来源 ${u} 必须被拒绝`).toBe(false);
      expect(res.reason).toMatch(/未授权的外部来源/);
    }
  });

  it('异常输入：空值、非字符串、非法格式优雅处理', () => {
    // @ts-ignore
    expect(validateApprovedExternalUrl(null).ok).toBe(false);
    // @ts-ignore
    expect(validateApprovedExternalUrl(undefined).ok).toBe(false);
    expect(validateApprovedExternalUrl('').ok).toBe(false);
    expect(validateApprovedExternalUrl('not-a-valid-url').ok).toBe(false);
  });
});

/**
 * 经批准的外部服务配置与可信来源校验机制
 * 
 * 架构规范：
 * 1. 渲染层严禁随意硬编码未经审核的网络 URL。
 * 2. 外部服务必须在此统一定义，并明确限定协议 (https:) 与允许的来源 (allowedOrigins)。
 * 3. 任何外部网络交互必须通过可信来源校验函数进行安全边界检查。
 */

export interface ExternalServiceConfig {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly allowedOrigins: readonly string[];
}

export const APPROVED_EXTERNAL_SERVICES = {
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT Official Web',
    url: 'https://chatgpt.com',
    allowedOrigins: [
      'https://chatgpt.com',
      'https://auth0.openai.com',
      'https://login.live.com',
      'https://appleid.apple.com',
      'https://accounts.google.com',
    ],
  },
} as const;

export const CHATGPT_WEB_URL = APPROVED_EXTERNAL_SERVICES.chatgpt.url;

export interface UrlValidationResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly origin?: string;
}

/**
 * 校验指定 URL 是否符合已批准外部服务的协议、域名与安全来源范围。
 * 拒绝非 https 协议（如 http:、javascript:、file:）以及未批准的外域。
 */
export function validateApprovedExternalUrl(rawUrl: string): UrlValidationResult {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, reason: 'URL 不能为空且必须为字符串' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'URL 格式不合法' };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: `拒绝不安全协议「${parsed.protocol}」，仅允许 https:`,
      origin: parsed.origin,
    };
  }

  const origin = parsed.origin.toLowerCase();
  const matchedService = Object.values(APPROVED_EXTERNAL_SERVICES).find((svc) => {
    return svc.allowedOrigins.some((allowed) => allowed.toLowerCase() === origin) || svc.url.toLowerCase() === origin;
  });

  if (!matchedService) {
    return {
      ok: false,
      reason: `未授权的外部来源「${origin}」，不在批准服务白名单中`,
      origin,
    };
  }

  return { ok: true, origin };
}

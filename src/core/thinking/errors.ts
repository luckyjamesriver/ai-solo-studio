import type { ThinkStatus } from './types.js';

/** 把服务返回的错误文本归类。顺序很重要：认证 → 额度用尽 → 频率限制。无法归类返回 undefined。 */
export function classifyServiceError(text: string): Exclude<ThinkStatus, 'complete' | 'incomplete' | 'timeout' | 'failed'> | undefined {
  if (/not logged in|please run \/login|invalid api key|authentication_failed|oauth_org_not_allowed|unauthorized|\b401\b|sign in to|log in to/i.test(text)) return 'auth_error';
  if (/hit your (?:\w+ )?limit|usage limit|credit balance is too low|billing_error|account_on_hold|quota|insufficient[_ ]funds|exceeded your current/i.test(text)) return 'quota_exhausted';
  if (/rate[_ -]?limit|\b429\b|too many requests|temporarily limiting|overloaded|try again in/i.test(text)) return 'rate_limited';
  return undefined;
}

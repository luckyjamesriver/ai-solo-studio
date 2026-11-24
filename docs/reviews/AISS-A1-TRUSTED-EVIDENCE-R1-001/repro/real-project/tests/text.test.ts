import { describe, it, expect } from 'vitest';
import { normalize, initials, truncate } from '../src/text.js';
describe('text', () => {
  it('normalizes spacing and case', () => { expect(normalize('  Hello   World ')).toBe('hello world'); });
  it('builds initials', () => { expect(initials('ada lovelace')).toBe('AL'); });
  it('keeps short text', () => { expect(truncate('abc', 5)).toBe('abc'); });
  it('truncates long text', () => { expect(truncate('abcdef', 4)).toBe('abc…'); });
  it('handles empty text', () => { expect(normalize('   ')).toBe(''); });
});

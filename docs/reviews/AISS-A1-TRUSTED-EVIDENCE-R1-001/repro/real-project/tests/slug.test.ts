import { describe, it, expect } from 'vitest';
import { slugify } from '../src/slug.js';
describe('slug', () => {
  it('lowercases', () => { expect(slugify('Hello World')).toBe('hello-world'); });
  it('strips punctuation', () => { expect(slugify('a, b! c?')).toBe('a-b-c'); });
  it('keeps chinese', () => { expect(slugify('你好 世界')).toBe('你好-世界'); });
  it('trims dashes', () => { expect(slugify('--x--')).toBe('x'); });
  it('empty', () => { expect(slugify('   ')).toBe(''); });
});

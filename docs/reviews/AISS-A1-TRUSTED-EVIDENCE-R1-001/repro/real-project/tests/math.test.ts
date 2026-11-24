import { describe, it, expect } from 'vitest';
import { add, mul, clamp } from '../src/math.js';
describe('math', () => {
  it('adds', () => { expect(add(1, 2)).toBe(3); expect(add(-1, 1)).toBe(0); });
  it('multiplies', () => { expect(mul(3, 4)).toBe(12); expect(mul(0, 9)).toBe(0); });
  it('clamps low', () => { expect(clamp(-5, 0, 10)).toBe(0); });
  it('clamps high', () => { expect(clamp(50, 0, 10)).toBe(10); });
  it('clamps inside', () => { expect(clamp(7, 0, 10)).toBe(7); });
});

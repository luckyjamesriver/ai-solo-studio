import { describe, it, expect } from 'vitest';
import { daysBetween, isWeekend } from '../src/dates.js';
describe('dates', () => {
  it('counts days', () => { expect(daysBetween(new Date('2026-01-01'), new Date('2026-01-11'))).toBe(10); });
  it('absolute order', () => { expect(daysBetween(new Date('2026-01-11'), new Date('2026-01-01'))).toBe(10); });
  it('detects weekend', () => { expect(isWeekend(new Date('2026-11-21'))).toBe(true); });
  it('detects weekday', () => { expect(isWeekend(new Date('2026-11-20'))).toBe(false); });
  it('same day', () => { const d = new Date('2026-05-05'); expect(daysBetween(d, d)).toBe(0); });
});

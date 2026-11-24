import { describe, it, expect } from 'vitest';
import { Store } from '../src/store.js';
describe('store', () => {
  it('sets and gets copies', () => { const s = new Store(); s.set({ id: 'a', value: 1 }); const got = s.get('a'); got!.value = 99; expect(s.get('a')!.value).toBe(1); });
  it('removes', () => { const s = new Store(); s.set({ id: 'a', value: 1 }); expect(s.remove('a')).toBe(true); expect(s.get('a')).toBeUndefined(); });
  it('counts size', () => { const s = new Store(); s.set({ id: 'a', value: 1 }); s.set({ id: 'b', value: 2 }); expect(s.size).toBe(2); });
  it('sums values', () => { const s = new Store(); s.set({ id: 'a', value: 1 }); s.set({ id: 'b', value: 2 }); expect(s.sum()).toBe(3); });
  it('missing remove', () => { const s = new Store(); expect(s.remove('nope')).toBe(false); });
});

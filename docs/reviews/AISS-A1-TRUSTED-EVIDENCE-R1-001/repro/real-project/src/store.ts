export interface Item { id: string; value: number }
export class Store {
  private items = new Map<string, Item>();
  set(item: Item): void { this.items.set(item.id, { ...item }); }
  get(id: string): Item | undefined { const i = this.items.get(id); return i ? { ...i } : undefined; }
  remove(id: string): boolean { return this.items.delete(id); }
  get size(): number { return this.items.size; }
  sum(): number { let s = 0; for (const i of this.items.values()) s += i.value; return s; }
}

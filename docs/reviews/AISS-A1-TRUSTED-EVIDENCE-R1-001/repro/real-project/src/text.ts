export function normalize(s: string): string { return s.trim().replace(/\s+/g, " ").toLowerCase(); }
export function initials(name: string): string { return normalize(name).split(" ").filter(Boolean).map((p) => p[0]!.toUpperCase()).join(""); }
export function truncate(s: string, n: number): string { return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`; }

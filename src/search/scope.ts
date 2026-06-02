import type { SearchResult } from "../db/store.ts";

export type ScopeMode = "global" | "boost" | "filter";

export interface ScopeOptions {
  scope?: string;
  scopeMode?: ScopeMode;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function matchesScope(filePath: string, scope: string): boolean {
  const fp = normalize(filePath);
  const s = normalize(scope).replace(/^\.\/+/, "");
  if (!s) return false;
  if (s.startsWith("/")) return fp === s || fp.startsWith(`${s}/`);
  return fp === s || fp.startsWith(`${s}/`) || fp.endsWith(`/${s}`) || fp.includes(`/${s}/`);
}

export function scopeSqlCondition(column: string, scope: string): { sql: string; params: string[] } {
  const s = normalize(scope).replace(/^\.\/+/, "");
  if (!s) return { sql: "1 = 1", params: [] };
  if (s.startsWith("/")) {
    return { sql: `(${column} = ? OR ${column} LIKE ?)`, params: [s, `${s}/%`] };
  }
  return {
    sql: `(${column} = ? OR ${column} LIKE ? OR ${column} LIKE ? OR ${column} LIKE ?)`,
    params: [s, `${s}/%`, `%/${s}`, `%/${s}/%`],
  };
}

export function applyScope(results: SearchResult[], opts: ScopeOptions, limit: number): SearchResult[] {
  const scope = opts.scope?.trim();
  const mode = opts.scopeMode ?? "global";
  if (!scope || mode === "global") return results.slice(0, limit);

  if (mode === "filter") {
    return results.filter(r => matchesScope(r.filePath, scope)).slice(0, limit);
  }

  return results
    .map(r => matchesScope(r.filePath, scope) ? { ...r, score: r.score * 1.25 } : r)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

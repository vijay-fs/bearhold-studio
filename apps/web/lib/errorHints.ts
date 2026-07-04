// Surface "did you mean ...?" hints when a query fails on a missing
// table or column. We extract the offending identifier from the
// engine's error message, then find the closest match in the cached
// schema by Levenshtein distance. Pure frontend, schema is already in
// memory — zero extra round trips.

import type { Schema } from '@dbstudio/erd';

export interface ErrorHint {
  kind: 'table' | 'column';
  /** The identifier the engine couldn't resolve. Used in the hint copy. */
  missing: string;
  /** Closest match(es) from the cached schema. Up to 3 to avoid clutter. */
  suggestions: string[];
}

/** Parse an engine error message looking for a "missing identifier"
 *  pattern. Returns the identifier plus its kind, or null when the
 *  error isn't one we know how to hint on. */
function extractMissing(
  code: string,
  message: string,
): { kind: 'table' | 'column'; name: string } | null {
  // Postgres: `relation "schema.table" does not exist`
  let m = message.match(/relation "([^"]+)" does not exist/i);
  if (m) {
    // Strip schema qualifier — we suggest against bare table names since
    // the user typically typed unqualified.
    const parts = (m[1] ?? '').split('.');
    return { kind: 'table', name: parts[parts.length - 1] ?? '' };
  }
  // Postgres: `column "x" does not exist`
  m = message.match(/column "([^"]+)" does not exist/i);
  if (m) return { kind: 'column', name: m[1] ?? '' };
  // MySQL: `Table 'db.table' doesn't exist`
  m = message.match(/Table ['`]?([^'`]+)['`]? doesn't exist/i);
  if (m) {
    const parts = (m[1] ?? '').split('.');
    return { kind: 'table', name: parts[parts.length - 1] ?? '' };
  }
  // MySQL: `Unknown column 'x' in 'field list'` — also covers HAVING etc.
  m = message.match(/Unknown column ['`]?([^'`]+)['`]? in/i);
  if (m) {
    // Strip table qualifier so we suggest against bare column names.
    const parts = (m[1] ?? '').split('.');
    return { kind: 'column', name: parts[parts.length - 1] ?? '' };
  }
  // SQLite: `no such table: x` / `no such column: x`
  m = message.match(/no such table:\s*([\w$.]+)/i);
  if (m) {
    const parts = (m[1] ?? '').split('.');
    return { kind: 'table', name: parts[parts.length - 1] ?? '' };
  }
  m = message.match(/no such column:\s*([\w$.]+)/i);
  if (m) {
    const parts = (m[1] ?? '').split('.');
    return { kind: 'column', name: parts[parts.length - 1] ?? '' };
  }
  // Engine-agnostic — only hit when the engine-specific patterns missed.
  if (code === 'not_found' && message.toLowerCase().includes('table')) {
    return null; // not enough info to extract a name
  }
  return null;
}

/** Levenshtein distance — classic edit-distance DP. Used to rank
 *  candidate identifier names by closeness to the missing one. Small
 *  inputs (column/table names) so O(N*M) is fine. */
function editDistance(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return 0;
  if (al.length === 0) return bl.length;
  if (bl.length === 0) return al.length;
  const prev = Array.from({ length: bl.length + 1 }, (_, i) => i);
  const cur = new Array(bl.length + 1).fill(0);
  for (let i = 1; i <= al.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= bl.length; j++) {
      const cost = al[i - 1] === bl[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (cur[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= bl.length; j++) prev[j] = cur[j] ?? 0;
  }
  return cur[bl.length] ?? 0;
}

/** Collect every candidate identifier of the given kind from the cached
 *  schema. Tables include every namespace's tables; columns are flat
 *  across all tables (we don't bias by which table the user might have
 *  meant — the hint is purely a typo-fix). */
function candidates(schema: Schema, kind: 'table' | 'column'): string[] {
  const out = new Set<string>();
  for (const ns of schema.schemas) {
    for (const t of ns.tables) {
      if (kind === 'table') {
        out.add(t.name);
      } else {
        for (const c of t.columns) out.add(c.name);
      }
    }
  }
  return Array.from(out);
}

/** Top-level entry. Returns null when there's no actionable hint —
 *  either we couldn't extract a name, the schema has no candidates, or
 *  nothing is close enough to be useful. */
export function suggestHint(
  schema: Schema | null,
  code: string,
  message: string,
): ErrorHint | null {
  if (!schema) return null;
  const target = extractMissing(code, message);
  if (!target || !target.name) return null;

  const pool = candidates(schema, target.kind);
  if (pool.length === 0) return null;

  const scored = pool
    .map((c) => ({ name: c, dist: editDistance(c, target.name) }))
    // Suggestions need to be meaningfully closer than just "any string".
    // The 60% threshold filters out wildly different names — for a
    // 5-char identifier that lets through 3 edits, which feels about
    // right for typos.
    .filter((s) => s.dist <= Math.max(2, Math.floor(target.name.length * 0.6)))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3)
    .map((s) => s.name);

  if (scored.length === 0) return null;
  return { kind: target.kind, missing: target.name, suggestions: scored };
}

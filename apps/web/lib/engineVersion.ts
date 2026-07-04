// Engine + server-version capability model.
//
// Every DDL and data-diff generator that emits SQL for a live server
// takes an `EngineVersion` and dispatches on its capability flags. The
// alternative — "just try modern syntax and let the server error" —
// leaves users on MySQL 5.7 or PG 12 with un-clickable diff rows
// and no path forward.
//
// The frontend gets `major` / `minor` from a new `server_info` command
// the Rust side queries at pool init (SHOW server_version_num for PG,
// SELECT VERSION() for MySQL, SELECT sqlite_version() for SQLite).
// When we don't know the version (Mongo, Redis, or connection just
// added and not yet tested), `capabilities()` falls back to the
// conservative subset that works everywhere in the engine's supported
// range — never emits syntax the oldest supported version rejects.

import type { DatabaseEngine } from './types';

export interface EngineVersion {
  engine: DatabaseEngine;
  /** Parsed major version (12 for PG 12, 5 for MySQL 5.7). Null when
   *  unknown — the capability model falls back to the safe minimum. */
  major: number | null;
  /** Optional minor. Only checked for MySQL 8.0.xx style gates. */
  minor?: number | null;
  /** Raw server_version string as returned by the engine, for display. */
  raw?: string | null;
}

/** Feature flags the SQL generators consult. Everything is a boolean —
 *  the generator picks between two shapes, not a spectrum. Add new
 *  flags here; the compiler forces every capability() to answer. */
export interface Capabilities {
  /** ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...
   *  PG 9.6+; MySQL 8.0.29+; SQLite: no. */
  addColumnIfNotExists: boolean;
  /** ALTER TABLE ... RENAME COLUMN a TO b (not CHANGE COLUMN).
   *  PG all; MySQL 8.0+; SQLite 3.25+. */
  renameColumnSyntax: boolean;
  /** MODIFY COLUMN restates the whole definition and drops omitted
   *  attributes. Only true for MySQL — matters because we have to
   *  thread nullable/default through every emitter. */
  modifyColumnRestates: boolean;
  /** ALTER COLUMN <col> TYPE <new> USING <expr> — PG only. Needed for
   *  cross-family casts (varchar → int). */
  usingClauseOnAlterType: boolean;
  /** CHECK constraints are enforced (not just parsed & ignored).
   *  MySQL 8.0.16+ (5.7 accepts + silently ignores);
   *  PG all; SQLite all. */
  enforcedCheckConstraints: boolean;
  /** INSERT ... ON CONFLICT (cols) DO UPDATE SET ...
   *  PG 9.5+; SQLite 3.24+. */
  onConflictDoUpdate: boolean;
  /** INSERT ... ON DUPLICATE KEY UPDATE ... — MySQL. */
  onDuplicateKeyUpdate: boolean;
  /** RETURNING clause on INSERT/UPDATE/DELETE.
   *  PG all; SQLite 3.35+; MySQL: no. */
  returningClause: boolean;
  /** Instant DDL via ALGORITHM=INSTANT — MySQL 8.0.12+. Doesn't
   *  change emitted SQL, just user-facing warnings. */
  instantAlgorithmHint: boolean;
  /** CREATE INDEX ... IF NOT EXISTS. PG 9.5+; MySQL: no; SQLite all. */
  createIndexIfNotExists: boolean;
  /** Backslash string escapes are the norm on MySQL unless `sql_mode`
   *  contains NO_BACKSLASH_ESCAPES (checked at pool init). */
  backslashStringEscapes: boolean;
}

const SAFE_MINIMUM: Capabilities = {
  addColumnIfNotExists: false,
  renameColumnSyntax: false,
  modifyColumnRestates: false,
  usingClauseOnAlterType: false,
  enforcedCheckConstraints: false,
  onConflictDoUpdate: false,
  onDuplicateKeyUpdate: false,
  returningClause: false,
  instantAlgorithmHint: false,
  createIndexIfNotExists: false,
  backslashStringEscapes: true,
};

export function capabilities(v: EngineVersion): Capabilities {
  const { engine, major, minor } = v;
  switch (engine) {
    case 'postgres': {
      const m = major ?? 12;
      return {
        addColumnIfNotExists: m >= 10,
        renameColumnSyntax: true,
        modifyColumnRestates: false,
        usingClauseOnAlterType: true,
        enforcedCheckConstraints: true,
        onConflictDoUpdate: true,
        onDuplicateKeyUpdate: false,
        returningClause: true,
        instantAlgorithmHint: false,
        createIndexIfNotExists: true,
        backslashStringEscapes: false,
      };
    }
    case 'mysql': {
      const m = major ?? 5;
      const n = minor ?? 7;
      const at = (M: number, N = 0) => m > M || (m === M && n >= N);
      return {
        addColumnIfNotExists: at(8, 0),
        renameColumnSyntax: at(8, 0),
        modifyColumnRestates: true,
        usingClauseOnAlterType: false,
        enforcedCheckConstraints: at(8, 0),
        onConflictDoUpdate: false,
        onDuplicateKeyUpdate: true,
        returningClause: false,
        instantAlgorithmHint: at(8, 0),
        createIndexIfNotExists: false,
        backslashStringEscapes: true,
      };
    }
    case 'sqlite': {
      const m = major ?? 3;
      const n = minor ?? 24;
      return {
        addColumnIfNotExists: false,
        renameColumnSyntax: m > 3 || n >= 25,
        modifyColumnRestates: false,
        usingClauseOnAlterType: false,
        enforcedCheckConstraints: true,
        onConflictDoUpdate: m > 3 || n >= 24,
        onDuplicateKeyUpdate: false,
        returningClause: m > 3 || n >= 35,
        instantAlgorithmHint: false,
        createIndexIfNotExists: true,
        backslashStringEscapes: false,
      };
    }
    default:
      return SAFE_MINIMUM;
  }
}

/** Convenience for callers that only have an engine handy. Emits the
 *  safe-minimum capability set — used at boundaries where the version
 *  hasn't been fetched yet (e.g. an offline diff preview against a
 *  cached schema). */
export function unknownVersion(engine: DatabaseEngine): EngineVersion {
  return { engine, major: null, minor: null, raw: null };
}

/** Parse "8.0.39" / "5.7.44-log" into major+minor. */
export function parseVersionString(engine: DatabaseEngine, raw: string): EngineVersion {
  const trimmed = raw.trim();
  const match = trimmed.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return { engine, major: null, minor: null, raw };
  return {
    engine,
    major: Number(match[1]),
    minor: Number(match[2]),
    raw,
  };
}

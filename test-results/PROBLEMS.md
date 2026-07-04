# Known problems, categorised

Each entry names the concrete bug, its root cause, the fix status, and
the test that would catch a regression. Updated by hand as issues come
in; the E2E harness produces `REPORT.md` alongside this file with the
live pass/fail signal.

## Landed fixes (as of this refactor)

### MySQL — nullable change emitted literal `<type>` placeholder
- **Symptom:** Applying the "toggle NOT NULL" diff row on MySQL
  produced SQL like `ALTER TABLE users MODIFY COLUMN full_name <type> NOT NULL;`
  and the server rejected it with a 1064 syntax error.
- **Root cause:** `schemaDiff.ts::buildAlterColumnNullable` had a TODO
  placeholder where the current data type belonged. MySQL's MODIFY
  clause restates the whole column definition; we weren't passing the
  type through from the diff walker.
- **Fix:** Thread source-column type + default into
  `buildAlterColumnNullable` / `buildAlterColumnType`. Emit
  `MODIFY COLUMN <col> <type> NULL/NOT NULL DEFAULT <expr>` correctly.
- **Regression test:** scenarios/`alter-column-nullable-mysql57`.

### Version-unaware DDL emission
- **Symptom:** MySQL 5.7 rejected `RENAME COLUMN`, `ADD COLUMN IF NOT
  EXISTS`, and other statements our diff emitter used unconditionally.
- **Root cause:** No server-version model. Emitters used modern syntax
  everywhere.
- **Fix:** New `engineVersion.ts` capability model. Every DDL builder
  and `dataDiffSql.ts` takes an `EngineVersion` and dispatches:
    - `ADD COLUMN IF NOT EXISTS` gated on PG 9.6+ / MySQL 8.0.29+
    - `RENAME COLUMN old TO new` gated on MySQL 8.0+; falls back to
      `CHANGE COLUMN old new <type>` on older versions
    - `ALTER COLUMN ... USING <cast>` gated on PG
    - `ON CONFLICT (cols) DO UPDATE` (PG/SQLite) vs
      `ON DUPLICATE KEY UPDATE` (MySQL)
    - `CREATE INDEX IF NOT EXISTS` gated on PG 9.5+ / SQLite
- **Regression test:** the whole harness matrix — every scenario is
  a version-aware assertion.

## Recently landed (this iteration)

### Server-version detection wired end-to-end
- **Rust:** Added `Driver::server_info` returning
  `{ major, minor, raw, flags }`. PG uses `SHOW server_version_num`
  for exact major/minor. MySQL uses `SELECT VERSION()` and
  also reads `@@sql_mode` to detect `NO_BACKSLASH_ESCAPES`.
- **Tauri:** New `get_server_info` command.
- **Frontend:** New `useServerInfoCache` store with in-flight dedupe.
  Warmed on schema-load; the diff and data-diff pages pull the source
  and target versions and thread them into `diffSchemas`
  (`sourceVersion`) and `buildSyncStatements` (`writeSideVersion`).
- **Result:** Modern SQL syntax (IF NOT EXISTS, RETURNING, ON CONFLICT,
  ON DUPLICATE KEY UPDATE) now emitted only when the SERVER supports
  it. Older versions get the correct fallback shape (CHANGE COLUMN
  for MySQL 5.7 renames, plain INSERT for pre-9.5 PG, etc).

### `sql_mode = NO_BACKSLASH_ESCAPES` respected
- Now detected at pool-info-fetch time on MySQL. Surfaced as
  `flags.no_backslash_escapes` in the ServerInfo response. Where the
  formatter consumes it (via `SqlLiteralOptions.noBackslashEscapes`),
  strings are emitted without the backslash-doubling that would
  corrupt the value on those servers.

### Dry-run SQL linter
- Every DiffChange emitted by `schemaDiff.ts` is dry-run against the
  live source server BEFORE the user sees an Apply button.
- Per-engine strategy is honest about what's really verified:
    - **PG / SQLite**: Full transactional dry-run via
      SAVEPOINT-per-statement. Any DDL or DML that would fail on
      Apply fails the lint. Green badge = truly safe.
    - **MySQL**: DDL implicit-commits, so a
      BEGIN/ROLLBACK approach would actually apply the ALTER. We
      use `PREPARE` for DDL (syntax + name-resolution check only;
      no execution), and `EXPLAIN` for DML (full parse+plan without
      writing). Any statement PREPARE can't handle returns
      `Unverifiable` — the UI shows a yellow "will validate on
      Apply" badge instead of a false-positive green check.
- UI: three-color badge per row (Verified / Would fail / Unverified)
  plus header-level summary count of failing statements.

## Open problems (not yet fixed)

### FK constraints not diffed on existing tables
- **Symptom:** `diffSchemas` only emits FKs inline in CREATE TABLE
  statements. If source has a table AND the target's version of that
  table adds a new FK, the FK never appears in the diff.
- **Fix path:** Add FK diff walker in `schemaDiff.ts` — for each
  target FK not on source, emit `ALTER TABLE ... ADD CONSTRAINT ...`.

### Index diff misses partial + expression indexes
- **Symptom:** Diff matches indexes by name only. An index with the
  same name but different WHERE clause or expression appears as
  identical.
- **Fix path:** Compare structural signature (columns + where +
  expression) in `diffIndexes`. Emit DROP + CREATE when signature
  differs.

### CHECK constraints ignored entirely
- **Symptom:** MySQL 8.0.16+ / PG / SQLite all support
  CHECK constraints and the introspection returns them, but the diff
  walker doesn't compare or emit ALTER TABLE ... ADD/DROP CHECK.

### PG generated column diff is lossy
- **Symptom:** Diff compares `data_type` string but not the
  generation expression. Two `GENERATED ALWAYS AS (...)` columns
  with different expressions look identical.

## Deferred (out of current scope)

- Cross-engine schema diff (Postgres source → MySQL target) — refuse
  loudly; document as unsupported. The engines' type systems aren't
  1:1.
- Oracle / SQL Server engines.

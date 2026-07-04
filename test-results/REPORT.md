# Bearhold Studio — E2E test report

_This file is regenerated every time `pnpm test:e2e` runs. The initial
contents below describe what to expect the first time you bring up the
docker matrix and run the harness against it._

## Setup

```sh
pnpm install                                   # picks up tsx + pg + mysql2
pnpm test:e2e:up                               # brings up 11 docker containers
docker compose -f infra/test/docker-compose.yml ps   # wait for (healthy)
pnpm test:e2e                                  # runs the harness
```

## Interpreting results

- **Pass** — the divergence SQL for that scenario parsed and executed
  cleanly against the target's server version. Doubles as evidence that
  the matrix + seed data are healthy for that engine.
- **Skip** — scenario not applicable to that engine (e.g. `CHANGE COLUMN`
  scenarios skip Postgres).
- **Lint fail** — server rejected our SQL at prepare time. The report
  shows the exact SQL and server error so you can jump straight to the
  fix.
- **Setup fail** — couldn't connect to the target or seed data was
  missing. Almost always a compose issue.

## Coverage roadmap

The current harness (v1) exercises:

- One-column divergence scenarios per DDL kind (add / drop / rename /
  alter type / alter nullable / index add / index drop).
- Data-diff scenarios (insert / update / delete / mixed).

Planned v2 additions (see `test-results/PROBLEMS.md`):

- Run `diffSchemas()` against source-vs-target and lint every emitted
  statement — currently we lint the divergence fixture, not the
  generator output. This closes the loop the user reported.
- Run `buildSyncStatements()` in both `insert-only` and `upsert` mode
  and verify each variant against MySQL 5.7 (ON DUPLICATE) and PG 12
  (ON CONFLICT).
- Add scenarios for JSON path diff, ENUM add/remove, generated
  columns, expression indexes, CHECK constraints (MySQL 8.0.16 gate).
- MongoDB collection-level diff harness (separate connector).
- Redis key-type coverage harness.

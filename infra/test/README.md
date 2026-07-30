# Test matrix stack

Every supported engine, every supported major version, seeded with the
same reference "shop" schema (adjusted for each dialect). Used by the
E2E harness under `scripts/test-e2e/` and by hand when triaging
version-specific bugs.

## Bring up

```sh
docker compose -f infra/test/docker-compose.yml up -d
```

First start takes a couple of minutes (image pulls + seed). Wait for
every container to report `(healthy)`:

```sh
docker compose -f infra/test/docker-compose.yml ps
```

## Tear down + wipe

```sh
docker compose -f infra/test/docker-compose.yml down -v
```

## Ports

| Engine      | Version | Port  | User        | Password       | Database |
|-------------|---------|-------|-------------|----------------|----------|
| Postgres    | 12      | 5412  | `dbstudio`  | `dbstudio_test`| `shop`   |
| Postgres    | 14      | 5414  | `dbstudio`  | `dbstudio_test`| `shop`   |
| Postgres    | 16      | 5416  | `dbstudio`  | `dbstudio_test`| `shop`   |
| Postgres    | 17      | 5417  | `dbstudio`  | `dbstudio_test`| `shop`   |
| MySQL       | 5.7     | 3357  | `dbstudio`  | `dbstudio_test`| `shop`   |
| MySQL       | 8.0     | 3380  | `dbstudio`  | `dbstudio_test`| `shop`   |
| MySQL       | 8.4     | 3384  | `dbstudio`  | `dbstudio_test`| `shop`   |
| MongoDB     | 7       | 27017 | -           | -              | `shop`   |
| Redis       | 7       | 6379  | -           | -              | -        |

The port map is also machine-readable in `targets.json` (the harness
reads that file to build its iteration axis).

## Seed data

- `seed/pg.sql` — Postgres reference schema + rows.
- `seed/mysql-5.7.sql` — MySQL 5.7-safe subset (no CHECK, no functional index).
- `seed/mysql-8.sql` — MySQL 8 with CHECK constraints, functional index, generated column.
- `seed/mongo.js` — MongoDB documents.
- `seed/redis-seed.sh` — Redis keys of every type we render.

## Disk footprint

Full stack occupies ~7 GB of Docker volumes when idle. If you're
tight on disk, bring up a subset by naming services explicitly:

```sh
docker compose -f infra/test/docker-compose.yml up -d pg16 mysql80
```

# Compare-demo stack

Two databases per engine — **prod** and **staging** — pre-seeded with
1 000 users, 500 products, 5 000 orders, and intentional schema and
data divergences designed to exercise every branch of the `/compare`
workspace.

## What's inside

| Engine   | Ports        | Prod DB               | Staging DB              |
|----------|--------------|-----------------------|-------------------------|
| Postgres | 5450 / 5451  | `shop` @ 5450         | `shop` @ 5451           |
| MySQL    | 3350 / 3351  | `shop` @ 3350         | `shop` @ 3351           |
| SQLite   | file-based   | `sqlite/prod.db`      | `sqlite/staging.db`     |

Credentials for Postgres + MySQL:

```
user      dbstudio
password  dbstudio_demo
```

## Bring up

```sh
docker compose -f infra/compare-demo/docker-compose.yml up -d
```

Wait until the four DB containers report `(healthy)`:

```sh
docker compose -f infra/compare-demo/docker-compose.yml ps
```

The `sqlite-builder` container will exit after ~5 seconds; that's
expected — it writes `sqlite/prod.db` and `sqlite/staging.db` and
stops.

## Tear down

```sh
docker compose -f infra/compare-demo/docker-compose.yml down -v
```

The `-v` wipes volumes so the next `up` re-seeds cleanly.

## Add the connections to Bearhold

Two options:

**Option A — import all four SQL connections at once.**
On the Connections page, use the "Import from TablePlus JSON" flow
and select `infra/compare-demo/connections.json`. Bearhold will
add four profiles; after the import, edit each and set the password
to `dbstudio_demo`.

**Option B — add them by hand.** In the New Connection form, use
the credentials above and the ports from the table.

For SQLite, add two connections manually — pick the SQLite engine
and point at `infra/compare-demo/sqlite/prod.db` and
`.../staging.db`. No password.

## Divergence catalogue

Every staging DB differs from its prod sibling along the same axes,
so the same demo works consistently across engines.

**Schema divergences (visible in the Schema tab):**

| Divergence                                | Postgres | MySQL | SQLite\* |
|-------------------------------------------|:--------:|:-----:|:--------:|
| `+` table `audit_log`                     |    ✓     |   ✓   |    ✓     |
| `+` column `products.discount_pct`        |    ✓     |   ✓   |    ✓     |
| `+` column `users.last_ip`                |    ✓     |   ✓   |    ✓     |
| `+` index `orders_placed_at_idx`          |    ✓     |   ✓   |    ✓     |
| `-` column `users.legacy_id`              |    ✓     |   ✓   |    ✓     |
| `~` widen `users.email` VARCHAR width     |    ✓     |   ✓   |    —     |
| `~` widen `products.price` DECIMAL width  |    ✓     |   ✓   |    —     |

\*SQLite uses type affinity, so declared VARCHAR / DECIMAL sizes
aren't observable through introspection — those columns land in
the diff as no-ops.

**Data divergences (visible in the Tables tab):**

| Table    | Only-in-source | Only-in-target | Mismatched cells       |
|----------|:--------------:|:--------------:|:-----------------------|
| users    |       20       |       5        | ~30 renamed, ~40 tier  |
| products |       5        |      10        | ~50 price bumps        |
| orders   |       0        |       0        | ~200 status flips      |

## Suggested demo flow

1. Open `/compare`.
2. Pick **compare-demo · pg-prod** as source, **pg-staging** as target.
3. Schema tab: 7 changes appear, safe ones pre-selected. Click **Apply**.
4. Switch to Tables tab. Pick `users`. Stats card shows the 5 / 20 /
   ~70 breakdown; click **Apply all** to sync.
5. Repeat with `products` and `orders`.
6. Switch to the MySQL pair and repeat — same divergences, same
   flow, different engine.

The compare workspace never asks you to re-pick connections between
tabs, so the whole demo runs in ~5 clicks per engine.

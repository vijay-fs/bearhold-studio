# dev — local databases for testing

Spin up MongoDB + Redis with sample data for testing dbstudio's NoSQL surfaces.

```sh
cd dev
docker compose up -d
```

Both services bind localhost-only with no auth.

| Engine  | Port  | Add to dbstudio as |
|---------|-------|--------------------|
| MongoDB | 27017 | `mongodb` engine, host `localhost`, port `27017`, no auth |
| Redis   | 6379  | `redis` engine, host `localhost`, port `6379`, no auth   |

Tear down with `docker compose down -v` (the `-v` wipes the data volumes
so the seeders re-run on the next `up`).

## What's seeded

- **Mongo:** `shop` database with `users`, `products`, `orders`. Includes
  ObjectIds, nested objects, arrays, and dates — covers every viewer
  branch.
- **Redis:** keys of every common type:
  - Strings: `user:1001:name`, `user:1002:name`, `feature:dark_mode`,
    `session:abc123` (with TTL).
  - Hashes: `user:1001:profile`, `user:1002:profile`.
  - Lists: `queue:emails`.
  - Sets: `tags:popular`.
  - Sorted sets: `leaderboard:weekly`.

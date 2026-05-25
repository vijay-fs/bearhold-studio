#!/bin/sh
# Seed Redis with one key of every common type so the keyspace browser
# has something interesting to render. Runs once at compose-up time
# and exits. Re-run by removing the redis-data volume and bringing
# the stack up again.

set -e
HOST=redis
PORT=6379

echo "Seeding Redis at $HOST:$PORT ..."

# Quick: only seed if our marker key isn't there yet (in case the
# volume already has data from a previous run).
if [ "$(redis-cli -h "$HOST" -p "$PORT" EXISTS dbstudio:seed)" = "1" ]; then
  echo "Redis already seeded — skipping."
  exit 0
fi

# --- Strings ----------------------------------------------------------
redis-cli -h "$HOST" -p "$PORT" SET 'user:1001:name' 'Alice Carter'
redis-cli -h "$HOST" -p "$PORT" SET 'user:1002:name' 'Bob Lin'
redis-cli -h "$HOST" -p "$PORT" SET 'feature:dark_mode' 'enabled'
# A string with a TTL so the TTL column has something non-trivial.
redis-cli -h "$HOST" -p "$PORT" SET 'session:abc123' 'token-payload-here' EX 3600

# --- Hashes -----------------------------------------------------------
redis-cli -h "$HOST" -p "$PORT" HSET 'user:1001:profile' \
  email 'alice@example.com' country 'US' tier 'gold'
redis-cli -h "$HOST" -p "$PORT" HSET 'user:1002:profile' \
  email 'bob@example.com' country 'SG' tier 'silver'

# --- Lists ------------------------------------------------------------
redis-cli -h "$HOST" -p "$PORT" RPUSH 'queue:emails' \
  'welcome:alice' 'promo:summer' 'receipt:order-A-1001'

# --- Sets -------------------------------------------------------------
redis-cli -h "$HOST" -p "$PORT" SADD 'tags:popular' 'vip' 'beta' 'returning'

# --- Sorted sets ------------------------------------------------------
redis-cli -h "$HOST" -p "$PORT" ZADD 'leaderboard:weekly' \
  1280 'alice' 950 'bob' 620 'carol'

# Marker so the script is idempotent.
redis-cli -h "$HOST" -p "$PORT" SET 'dbstudio:seed' "$(date +%s)"

echo "Redis seeded."

#!/bin/sh
# Wait briefly for the server socket, then load representative keys
# covering every Redis type we render in the key browser.
set -e

until redis-cli -h redis7 -p 6379 ping > /dev/null 2>&1; do sleep 0.5; done

redis-cli -h redis7 -p 6379 <<'RESP'
SET   user:alice   "Alice Anderson"
SET   user:bob     "Bob Baker"
HSET  order:1      user 1 status paid    total 1899.99
HSET  order:2      user 1 status pending total 45.00
HSET  order:3      user 2 status shipped total 1344.00
RPUSH cart:1       LAPTOP-001
RPUSH cart:2       BOOK-001 BOOK-002
SADD  tags:tech    LAPTOP-001 BOOK-001 BOOK-002
ZADD  leaderboard  1899.99 alice 1344.00 bob 80.00 carol
XADD  events *     kind login user alice
XADD  events *     kind purchase user bob sku LAPTOP-002
RESP

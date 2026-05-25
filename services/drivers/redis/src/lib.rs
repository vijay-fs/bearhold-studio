//! Redis driver. Lives outside the SQL `Driver` trait — Redis is a
//! key/value store with five primary value types (string, list, set,
//! hash, sorted set) and none of those map onto rows or columns. The
//! driver exposes a typed read/write surface that the Redis workspace
//! consumes directly through `redis_*` Tauri commands.

use std::collections::BTreeMap;
use std::sync::Arc;

use dashmap::DashMap;
use dbstudio_core::{
    secrets::{self, Slot},
    AuthMethod, ConnectionProfile, DbError, Result, TlsMode,
};
use redis::aio::ConnectionManager;
use redis::Client;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Cached per-profile connection managers. `ConnectionManager` keeps a
/// single Redis connection alive and transparently reconnects on
/// disconnects, which fits the "interactive workspace" pattern well.
pub struct RedisDriver {
    connections: Arc<DashMap<Uuid, ConnectionManager>>,
}

impl RedisDriver {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(DashMap::new()),
        }
    }

    async fn conn_for(&self, profile: &ConnectionProfile) -> Result<ConnectionManager> {
        if let Some(c) = self.connections.get(&profile.id) {
            return Ok(c.clone());
        }
        let url = build_url(profile).await?;
        let client = Client::open(url).map_err(map_redis_err)?;
        let manager = ConnectionManager::new(client).await.map_err(map_redis_err)?;
        self.connections.insert(profile.id, manager.clone());
        Ok(manager)
    }

    pub async fn ping(&self, profile: &ConnectionProfile) -> Result<()> {
        let mut conn = self.conn_for(profile).await?;
        let pong: String = redis::cmd("PING")
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        if pong != "PONG" {
            return Err(DbError::Internal(format!("unexpected PING reply: {pong}")));
        }
        Ok(())
    }

    pub async fn disconnect(&self, profile: &ConnectionProfile) -> Result<()> {
        self.connections.remove(&profile.id);
        Ok(())
    }

    /// Walk the keyspace using SCAN. The standard Redis pagination
    /// pattern — pass cursor=0 for the first call, then keep passing
    /// the cursor the server returned until it comes back as 0 again.
    /// `match_pattern` defaults to `*` when omitted.
    pub async fn scan(
        &self,
        profile: &ConnectionProfile,
        req: ScanRequest,
    ) -> Result<ScanResponse> {
        let mut conn = self.conn_for(profile).await?;

        let pattern = req.match_pattern.unwrap_or_else(|| "*".to_string());
        // Redis SCAN `COUNT` is a hint to the server about how many
        // keys to look at per round-trip — not a strict ceiling. We
        // cap at 1000 so a runaway "scan everything matching *" can't
        // monopolise the renderer.
        let count = req.count.unwrap_or(200).min(1000);
        let cursor_in = req.cursor.unwrap_or(0);

        // SCAN <cursor> MATCH <pattern> COUNT <count>
        let (next_cursor, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor_in)
            .arg("MATCH")
            .arg(&pattern)
            .arg("COUNT")
            .arg(count)
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;

        // For each key we surface its type + TTL so the keyspace pane
        // can show the type badge and any expiry without a second
        // round-trip per-key. We pipeline these to keep latency in
        // check on large pages.
        let mut entries: Vec<RedisKeyEntry> = Vec::with_capacity(keys.len());
        if !keys.is_empty() {
            let mut pipe = redis::pipe();
            for k in &keys {
                pipe.cmd("TYPE").arg(k);
                pipe.cmd("TTL").arg(k);
            }
            let pairs: Vec<redis::Value> =
                pipe.query_async(&mut conn).await.map_err(map_redis_err)?;
            for (i, k) in keys.iter().enumerate() {
                let type_v = pairs.get(i * 2);
                let ttl_v = pairs.get(i * 2 + 1);
                let type_name = type_v.and_then(value_to_string).unwrap_or_else(|| "none".into());
                let ttl_seconds = ttl_v.and_then(value_to_int);
                entries.push(RedisKeyEntry {
                    key: k.clone(),
                    type_name,
                    ttl_seconds,
                });
            }
        }

        entries.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(ScanResponse {
            keys: entries,
            next_cursor,
        })
    }

    /// Fetch the value for a key with type-appropriate decoding. The
    /// caller doesn't need to know the type in advance — we `TYPE`
    /// first and then run the right read command. Returns `None`
    /// inside `value` when the key doesn't exist.
    pub async fn key_details(
        &self,
        profile: &ConnectionProfile,
        key: &str,
    ) -> Result<RedisKeyDetails> {
        let mut conn = self.conn_for(profile).await?;
        // Use raw `query_async::<redis::Value>` + manual decoding for
        // everything. The high-level `AsyncCommands` shortcuts return
        // strongly-typed values via `FromRedisValue` impls that have
        // surprising edge cases (binary hash values, RESP3 ZRANGE
        // shape) which surfaced in the field as cryptic "failed to
        // load key" errors with no detail. Decoding by hand gives us
        // full control over edge cases and lossy-but-readable string
        // conversion for binary fields.
        let type_raw: redis::Value = redis::cmd("TYPE")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        let type_name = value_to_string(&type_raw).unwrap_or_else(|| "none".into());

        let ttl_raw: redis::Value = redis::cmd("TTL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        let ttl_seconds = value_to_int(&ttl_raw);

        let value = match type_name.as_str() {
            "string" => {
                let v: redis::Value = redis::cmd("GET")
                    .arg(key)
                    .query_async(&mut conn)
                    .await
                    .map_err(map_redis_err)?;
                match value_to_string(&v) {
                    Some(s) => RedisValue::String(s),
                    None => RedisValue::None,
                }
            }
            "list" => {
                let len_raw: redis::Value = redis::cmd("LLEN")
                    .arg(key)
                    .query_async(&mut conn)
                    .await
                    .map_err(map_redis_err)?;
                let total = value_to_int(&len_raw).unwrap_or(0).max(0) as u64;
                // Cap reads at 500 entries — anything longer belongs
                // to a stream-style workload this MVP browser doesn't
                // target.
                let raw: redis::Value = redis::cmd("LRANGE")
                    .arg(key)
                    .arg(0)
                    .arg(499)
                    .query_async(&mut conn)
                    .await
                    .map_err(map_redis_err)?;
                let items = array_to_strings(&raw);
                RedisValue::List { items, total }
            }
            "set" => {
                let card_raw: redis::Value = redis::cmd("SCARD")
                    .arg(key)
                    .query_async(&mut conn)
                    .await
                    .map_err(map_redis_err)?;
                let total = value_to_int(&card_raw).unwrap_or(0).max(0) as u64;
                let raw: redis::Value = redis::cmd("SMEMBERS")
                    .arg(key)
                    .query_async(&mut conn)
                    .await
                    .map_err(map_redis_err)?;
                let members = array_to_strings(&raw);
                RedisValue::Set { members, total }
            }
            "hash" => {
                let raw: redis::Value = redis::cmd("HGETALL")
                    .arg(key)
                    .query_async(&mut conn)
                    .await
                    .map_err(map_redis_err)?;
                let flat = array_to_strings(&raw);
                // HGETALL replies are flat [field, value, field, value...].
                // Pair them into a BTreeMap; odd-length payloads (shouldn't
                // happen against a real Redis but defensive anyway) drop
                // the orphan.
                let mut fields = BTreeMap::new();
                let mut iter = flat.into_iter();
                while let (Some(k), Some(v)) = (iter.next(), iter.next()) {
                    fields.insert(k, v);
                }
                let total = fields.len() as u64;
                RedisValue::Hash { fields, total }
            }
            "zset" => {
                let card_raw: redis::Value = redis::cmd("ZCARD")
                    .arg(key)
                    .query_async(&mut conn)
                    .await
                    .map_err(map_redis_err)?;
                let total = value_to_int(&card_raw).unwrap_or(0).max(0) as u64;
                let raw: redis::Value = redis::cmd("ZRANGE")
                    .arg(key)
                    .arg(0)
                    .arg(499)
                    .arg("WITHSCORES")
                    .query_async(&mut conn)
                    .await
                    .map_err(map_redis_err)?;
                let flat = array_to_strings(&raw);
                // ZRANGE WITHSCORES is [member, score, member, score...].
                // Scores are returned as strings even though they're
                // floats — parse manually.
                let mut items: Vec<(String, f64)> = Vec::new();
                let mut iter = flat.into_iter();
                while let (Some(m), Some(s)) = (iter.next(), iter.next()) {
                    let score = s.parse::<f64>().unwrap_or(0.0);
                    items.push((m, score));
                }
                RedisValue::SortedSet { items, total }
            }
            "stream" => RedisValue::Stream,
            "none" => RedisValue::None,
            other => RedisValue::Unknown {
                type_name: other.to_string(),
            },
        };

        Ok(RedisKeyDetails {
            key: key.to_string(),
            type_name,
            ttl_seconds,
            value,
        })
    }

    pub async fn delete(&self, profile: &ConnectionProfile, key: &str) -> Result<u64> {
        let mut conn = self.conn_for(profile).await?;
        let deleted_raw: redis::Value = redis::cmd("DEL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        let deleted = value_to_int(&deleted_raw).unwrap_or(0);
        Ok(deleted.max(0) as u64)
    }
}

impl Default for RedisDriver {
    fn default() -> Self {
        Self::new()
    }
}

// ---- wire types --------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct ScanRequest {
    /// SCAN cursor — pass 0 for the first call, then the value the
    /// server returned on the previous response.
    #[serde(default)]
    pub cursor: Option<u64>,
    /// MATCH pattern (glob — `*` matches anything, `prefix:*` is the
    /// common case). Defaults to `*`.
    #[serde(default)]
    pub match_pattern: Option<String>,
    /// Server-side COUNT hint. We cap at 1000 so a wide scan can't
    /// produce an unrenderable page.
    #[serde(default)]
    pub count: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanResponse {
    pub keys: Vec<RedisKeyEntry>,
    /// Pass back as `cursor` on the next call. 0 = scan complete.
    pub next_cursor: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RedisKeyEntry {
    pub key: String,
    /// Redis's own type name: "string" | "list" | "set" | "hash" |
    /// "zset" | "stream" | "none" (missing key).
    pub type_name: String,
    /// Seconds until expiry. `-1` = no expiry, `-2` = key doesn't
    /// exist, `null` = TTL command failed (rare).
    pub ttl_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RedisKeyDetails {
    pub key: String,
    pub type_name: String,
    pub ttl_seconds: Option<i64>,
    pub value: RedisValue,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RedisValue {
    /// Key doesn't exist.
    None,
    String(String),
    List {
        items: Vec<String>,
        /// LLEN — full list length even when we trimmed `items` for display.
        total: u64,
    },
    Set {
        members: Vec<String>,
        /// SCARD — full set cardinality.
        total: u64,
    },
    Hash {
        fields: BTreeMap<String, String>,
        total: u64,
    },
    SortedSet {
        items: Vec<(String, f64)>,
        /// ZCARD.
        total: u64,
    },
    /// Stream values are out of scope for the MVP — too much surface
    /// for one viewer pass. The UI renders a placeholder.
    Stream,
    Unknown {
        type_name: String,
    },
}

// ---- helpers -----------------------------------------------------------

async fn build_url(profile: &ConnectionProfile) -> Result<String> {
    let mut user = String::new();
    let mut pass = String::new();
    if let AuthMethod::Password {
        username,
        password_ref,
    } = &profile.auth
    {
        user = username.clone();
        let _ = password_ref;
        if let Ok(Some(p)) = secrets::get(profile.id, Slot::Password).await {
            pass = p;
        }
    }

    let host = if profile.host.is_empty() {
        "localhost".to_string()
    } else {
        profile.host.clone()
    };
    let port = if profile.port == 0 { 6379 } else { profile.port };
    let scheme = if matches!(
        profile.tls,
        TlsMode::Require | TlsMode::VerifyCa | TlsMode::VerifyFull
    ) {
        "rediss"
    } else {
        "redis"
    };

    // The optional `database` slot on the profile is used as the
    // Redis db index when it parses to a non-negative integer.
    // Otherwise the URL omits the segment and Redis defaults to db 0.
    let db_segment = match profile.database.trim().parse::<u8>() {
        Ok(idx) => format!("/{}", idx),
        Err(_) => "".to_string(),
    };

    let creds = if user.is_empty() && pass.is_empty() {
        String::new()
    } else {
        // Redis 6+ supports user:pass; older releases ignore the user
        // half. Empty user is fine in the URL.
        format!(
            "{}:{}@",
            percent_encode(&user),
            percent_encode(&pass),
        )
    };

    Ok(format!("{scheme}://{creds}{host}:{port}{db_segment}"))
}

/// Same minimal percent-encoder as the Mongo driver — pulled in here
/// rather than shared to avoid a circular dep just for five chars.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn map_redis_err(e: redis::RedisError) -> DbError {
    use redis::ErrorKind;
    match e.kind() {
        ErrorKind::AuthenticationFailed => DbError::AuthFailed(e.to_string()),
        ErrorKind::IoError | ErrorKind::ClientError => DbError::Connection(e.to_string()),
        ErrorKind::TypeError => DbError::InvalidInput(e.to_string()),
        _ => DbError::Internal(e.to_string()),
    }
}

/// Decode a `redis::Value::Data` (bytes) or `Value::SimpleString` into
/// a String. We use this only for TYPE / TTL replies which we know
/// are short and UTF-8 — anything else falls through to the lossy
/// display path.
fn value_to_string(v: &redis::Value) -> Option<String> {
    match v {
        redis::Value::BulkString(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        redis::Value::SimpleString(s) => Some(s.clone()),
        redis::Value::VerbatimString { text, .. } => Some(text.clone()),
        _ => None,
    }
}

fn value_to_int(v: &redis::Value) -> Option<i64> {
    match v {
        redis::Value::Int(i) => Some(*i),
        // Some clients return integers as bulk strings (e.g. ZCARD via
        // certain proxies). Try to parse just in case so we don't lose
        // metadata on those paths.
        redis::Value::BulkString(bytes) => std::str::from_utf8(bytes)
            .ok()
            .and_then(|s| s.parse::<i64>().ok()),
        _ => None,
    }
}

/// Decode any Redis array-shaped reply into a Vec of UTF-8-lossy
/// strings. Used by LRANGE / SMEMBERS / HGETALL / ZRANGE — they all
/// come back as `Value::Array` with mostly-BulkString members. Mixed
/// arrays (Int + BulkString) are flattened to their string form so a
/// hash with numeric-looking values still renders. Lossy UTF-8 is the
/// right choice for a browser surface: it never panics and a `?`
/// placeholder is more useful than failing the whole key load.
fn array_to_strings(v: &redis::Value) -> Vec<String> {
    match v {
        redis::Value::Array(items) => items
            .iter()
            .map(|item| match item {
                redis::Value::BulkString(bytes) => {
                    String::from_utf8_lossy(bytes).into_owned()
                }
                redis::Value::SimpleString(s) => s.clone(),
                redis::Value::VerbatimString { text, .. } => text.clone(),
                redis::Value::Int(i) => i.to_string(),
                redis::Value::Double(d) => d.to_string(),
                redis::Value::Boolean(b) => b.to_string(),
                redis::Value::Nil => String::new(),
                other => format!("{:?}", other),
            })
            .collect(),
        // A single bulk reply when an array was expected is rare but
        // possible; treat it as a single-element array.
        redis::Value::BulkString(bytes) => {
            vec![String::from_utf8_lossy(bytes).into_owned()]
        }
        _ => Vec::new(),
    }
}

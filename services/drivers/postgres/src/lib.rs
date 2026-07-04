//! PostgreSQL driver. Uses sqlx with the Tokio runtime and rustls TLS.

mod decode;
mod introspect;
mod map_error;
mod split;

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use dbstudio_core::{
    secrets::{self, Slot},
    server_info::{ServerFlags, ServerInfo},
    ssh_tunnel::{self, BastionAuth, SshTunnelConfig, Tunnel},
    AuthMethod, CellUpdate, ConnectionProfile, DbError, Driver, LintOutcome, LintResult,
    QueryRequest, QueryResult, ResultColumn, Result, RowDelete, RowInsert, Schema, SshAuth, Value,
};
use sqlx::{
    postgres::{PgPool, PgPoolOptions, Postgres},
    Column, QueryBuilder, Row, TypeInfo,
};
use tracing::info;
use uuid::Uuid;

use crate::map_error::map_sqlx_error;

const DEFAULT_ROW_LIMIT: u32 = 10_000;

pub struct PostgresDriver {
    pools: Arc<DashMap<Uuid, PgPool>>,
    tunnels: Arc<DashMap<Uuid, Arc<Tunnel>>>,
    /// Map from caller-supplied `query_id` → backend PID of the connection
    /// running it. Populated when `execute` pins a connection at the start
    /// of a statement, drained when the statement finishes. A sibling
    /// `cancel_query` looks up the PID and issues `pg_cancel_backend()` on
    /// a side connection from the same pool.
    query_pids: Arc<DashMap<Uuid, i32>>,
}

impl PostgresDriver {
    pub fn new() -> Self {
        Self {
            pools: Arc::new(DashMap::new()),
            tunnels: Arc::new(DashMap::new()),
            query_pids: Arc::new(DashMap::new()),
        }
    }

    async fn pool_for(&self, profile: &ConnectionProfile) -> Result<PgPool> {
        if let Some(pool) = self.pools.get(&profile.id) {
            return Ok(pool.clone());
        }

        // If the profile has an SSH tunnel, open (or reuse) it first and
        // point the connection URL at the tunnel-local port.
        let (host, port) = if let Some(cfg) = &profile.ssh_tunnel {
            let tunnel = self.ensure_tunnel(profile, cfg).await?;
            ("127.0.0.1".to_string(), tunnel.local_port())
        } else {
            (profile.host.clone(), profile.port)
        };

        let url = build_connection_url(profile, &host, port).await?;
        let pool = PgPoolOptions::new()
            // Keep the pool tight. Single-user desktop app talking
            // to PG servers that may share their connection budget
            // with other clients (web apps, BI tools, replication).
            // Two is the realistic working set — one for the active
            // query, one for the sibling `pg_cancel_backend` route
            // — and leaves headroom for anyone else on the server.
            .max_connections(2)
            // Start empty; sqlx defaults this to 0 already but
            // pinning it explicitly guards against a future default
            // change quietly pre-warming connections.
            .min_connections(0)
            .acquire_timeout(std::time::Duration::from_secs(10))
            // Validate the connection before handing it out. Catches the
            // common case where an SSH tunnel died or the server killed an
            // idle session — sqlx drops the dead handle and opens a fresh
            // one instead of surfacing `io error: ... got 0 bytes at EOF`.
            .test_before_acquire(true)
            // Recycle connections that have been idle long enough that the
            // bastion is likely to have closed the channel. Keeps the pool
            // warm but bounded — combined with `test_before_acquire` this
            // covers both "stale on read" and "killed mid-idle".
            .idle_timeout(Some(std::time::Duration::from_secs(300)))
            .connect(&url)
            .await
            .map_err(map_sqlx_error)?;

        self.pools.insert(profile.id, pool.clone());
        Ok(pool)
    }

    async fn ensure_tunnel(
        &self,
        profile: &ConnectionProfile,
        cfg: &dbstudio_core::SshTunnel,
    ) -> Result<Arc<Tunnel>> {
        if let Some(t) = self.tunnels.get(&profile.id) {
            return Ok(t.clone());
        }
        let auth = resolve_bastion_auth(profile.id, &cfg.auth).await?;
        let tunnel = ssh_tunnel::open(SshTunnelConfig {
            bastion_host: cfg.host.clone(),
            bastion_port: cfg.port,
            username: cfg.username.clone(),
            auth,
            target_host: profile.host.clone(),
            target_port: profile.port,
            expected_fingerprint: cfg.host_key_fingerprint.clone(),
        })
        .await?;
        let tunnel = Arc::new(tunnel);
        self.tunnels.insert(profile.id, tunnel.clone());
        Ok(tunnel)
    }
}

async fn resolve_bastion_auth(profile_id: Uuid, auth: &SshAuth) -> Result<BastionAuth> {
    match auth {
        SshAuth::Password { password_ref } => {
            // Prefer keychain; fall back to inline password_ref (legacy).
            let pw = if password_ref.is_empty() {
                secrets::get(profile_id, Slot::SshTunnelPassword).await?
            } else {
                Some(password_ref.clone())
            };
            let pw = pw.ok_or_else(|| {
                DbError::AuthFailed("ssh tunnel password not in keychain".into())
            })?;
            Ok(BastionAuth::Password(pw))
        }
        SshAuth::Key { key_ref, passphrase_ref } => {
            // `key_ref` carries the absolute path to the private key file.
            // Passphrase (if any) is keychain-backed.
            let passphrase = match passphrase_ref {
                Some(p) if !p.is_empty() => Some(p.clone()),
                _ => secrets::get(profile_id, Slot::SshTunnelPassphrase).await?,
            };
            Ok(BastionAuth::Key {
                path: PathBuf::from(key_ref),
                passphrase,
            })
        }
    }
}

impl Default for PostgresDriver {
    fn default() -> Self {
        Self::new()
    }
}

async fn run_single(
    pool: &PgPool,
    sql: &str,
    limit: usize,
    query_id: Option<Uuid>,
    query_pids: &Arc<DashMap<Uuid, i32>>,
) -> Result<QueryResult> {
    // Pin a connection from the pool for the lifetime of this statement so
    // (a) the backend PID we look up corresponds to the connection that
    // will actually run the query, and (b) `pg_cancel_backend` from a
    // sibling task hits the right backend. Without pinning, sqlx may
    // acquire+release a different connection per call.
    let mut conn = pool.acquire().await.map_err(map_sqlx_error)?;

    // Register the backend PID against the caller's query_id so a
    // sibling cancel_query can find it. The drop guard below removes the
    // entry on every exit path — success, error, or panic — so we don't
    // leak entries that could later cancel an unrelated connection that
    // happens to reuse the same PID after the pool reclaims it.
    if let Some(qid) = query_id {
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *conn)
            .await
            .map_err(map_sqlx_error)?;
        query_pids.insert(qid, pid);
    }
    let _guard = QueryIdGuard {
        registry: query_pids,
        qid: query_id,
    };

    if !is_query_statement(sql) {
        let result = sqlx::query(sql)
            .execute(&mut *conn)
            .await
            .map_err(map_sqlx_error)?;
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: Some(result.rows_affected()),
            elapsed_ms: 0,
            truncated: false,
        });
    }

    let pg_rows = sqlx::query(sql)
        .fetch_all(&mut *conn)
        .await
        .map_err(map_sqlx_error)?;

    let columns: Vec<ResultColumn> = pg_rows
        .first()
        .map(|r| {
            r.columns()
                .iter()
                .map(|c| ResultColumn {
                    name: c.name().to_string(),
                    data_type: c.type_info().name().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    let truncated = pg_rows.len() > limit;
    let mut rows = Vec::with_capacity(pg_rows.len().min(limit));
    for row in pg_rows.iter().take(limit) {
        let mut cells = Vec::with_capacity(row.columns().len());
        for (i, col) in row.columns().iter().enumerate() {
            cells.push(decode::decode_cell(row, i, col.type_info().name()));
        }
        rows.push(cells);
    }

    Ok(QueryResult {
        columns,
        rows,
        rows_affected: None,
        elapsed_ms: 0,
        truncated,
    })
}

/// Removes the (query_id, pid) registration when the statement exits,
/// regardless of how — success, error, or future being dropped. Keeping
/// the registry tight prevents a stale PID from accidentally cancelling
/// an unrelated query that later runs on a recycled connection.
struct QueryIdGuard<'a> {
    registry: &'a Arc<DashMap<Uuid, i32>>,
    qid: Option<Uuid>,
}

impl Drop for QueryIdGuard<'_> {
    fn drop(&mut self) {
        if let Some(qid) = self.qid {
            self.registry.remove(&qid);
        }
    }
}

async fn build_connection_url(
    profile: &ConnectionProfile,
    host: &str,
    port: u16,
) -> Result<String> {
    // Password is sourced from the OS keychain (see core::secrets). The
    // `password_ref` field on AuthMethod::Password is retained for legacy
    // saved profiles; if present and non-empty we prefer it, otherwise we
    // fall back to the keychain.
    let (username, password) = match &profile.auth {
        AuthMethod::Password { username, password_ref } => {
            let pw = if password_ref.is_empty() {
                secrets::get(profile.id, Slot::Password).await?
            } else {
                Some(password_ref.clone())
            };
            (username.clone(), pw)
        }
        AuthMethod::SshKey { username, .. } => (username.clone(), None),
        AuthMethod::IamAws { username, .. } => (username.clone(), None),
        _ => {
            return Err(DbError::InvalidInput(
                "postgres requires a username".to_string(),
            ))
        }
    };

    let mut url = url::Url::parse("postgres://placeholder/")
        .map_err(|e| DbError::Internal(e.to_string()))?;
    url.set_host(Some(host))
        .map_err(|e| DbError::Internal(format!("invalid host: {e:?}")))?;
    url.set_port(Some(port))
        .map_err(|_| DbError::Internal("invalid port".to_string()))?;
    url.set_path(&profile.database);
    url.set_username(&username)
        .map_err(|_| DbError::Internal("invalid username".to_string()))?;
    if let Some(p) = password {
        if !p.is_empty() {
            url.set_password(Some(&p))
                .map_err(|_| DbError::Internal("invalid password".to_string()))?;
        }
    }
    Ok(url.into())
}

/// Quote a Postgres identifier. Doubles any embedded `"` and wraps the
/// whole thing — handles names with spaces, reserved words, mixed case.
fn pg_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Push a JSON value as a bound parameter to the query builder. Null becomes
/// a literal `NULL` (sqlx can't bind a typeless null); everything else is
/// bound by its native Rust type so Postgres handles coercion to the column
/// type from a typed value (Integer → INT, String → TEXT/VARCHAR, etc).
fn push_pg_value(q: &mut QueryBuilder<'_, Postgres>, v: &Value) {
    match v {
        Value::Null => {
            q.push("NULL");
        }
        Value::Bool(b) => {
            q.push_bind(*b);
        }
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                q.push_bind(i);
            } else if let Some(f) = n.as_f64() {
                q.push_bind(f);
            } else {
                // Out-of-range numerics: send the textual form. Postgres
                // accepts text for NUMERIC and will reject for int columns,
                // which is the right behaviour — surface a coercion error
                // to the user rather than silently truncating.
                q.push_bind(n.to_string());
            }
        }
        Value::String(s) => {
            q.push_bind(s.clone());
        }
        Value::Array(_) | Value::Object(_) => {
            // JSON/JSONB columns: bind the value's serialized form. Postgres
            // accepts a JSON string and the column type drives the parse.
            q.push_bind(v.to_string());
        }
    }
}

/// Cheap heuristic: does this SQL produce a result set?
///
/// Skips leading whitespace and SQL comments (`-- line` and `/* block */`)
/// before reading the first keyword. Without this, a query that starts with
/// a comment (very common — Monaco templates one in) gets misclassified as a
/// write, takes the `execute()` path, and discards its rows.
fn is_query_statement(sql: &str) -> bool {
    matches!(
        leading_keyword(sql).to_ascii_uppercase().as_str(),
        "SELECT" | "WITH" | "SHOW" | "EXPLAIN" | "VALUES" | "TABLE"
    )
}

fn leading_keyword(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
        } else if b == b'-' && bytes.get(i + 1) == Some(&b'-') {
            // Line comment: skip to end of line.
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if b == b'/' && bytes.get(i + 1) == Some(&b'*') {
            // Block comment: skip to closing */.
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
        } else {
            break;
        }
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        i += 1;
    }
    std::str::from_utf8(&bytes[start..i]).unwrap_or("").to_string()
}

#[cfg(test)]
mod heuristic_tests {
    use super::is_query_statement;

    #[test]
    fn plain_select_is_query() {
        assert!(is_query_statement("SELECT 1"));
    }

    #[test]
    fn select_after_line_comment_is_query() {
        assert!(is_query_statement("-- header\nSELECT 1"));
    }

    #[test]
    fn select_after_block_comment_is_query() {
        assert!(is_query_statement("/* preamble */ SELECT 1"));
    }

    #[test]
    fn update_is_not_query() {
        assert!(!is_query_statement("-- a comment\nUPDATE x SET y = 1"));
    }
}

#[async_trait]
impl Driver for PostgresDriver {
    async fn connect(&self, profile: &ConnectionProfile) -> Result<()> {
        info!(profile_id = %profile.id, "opening postgres pool");
        let _pool = self.pool_for(profile).await?;
        Ok(())
    }

    async fn ping(&self, profile: &ConnectionProfile) -> Result<()> {
        let pool = self.pool_for(profile).await?;
        sqlx::query("SELECT 1")
            .execute(&pool)
            .await
            .map_err(map_sqlx_error)?;
        Ok(())
    }

    async fn server_info(&self, profile: &ConnectionProfile) -> Result<ServerInfo> {
        let pool = self.pool_for(profile).await?;
        // `SHOW server_version` returns the human-readable version
        // (`16.4 (Debian ...)`). `server_version_num` gives us the
        // numeric form (`160004`) which is simpler to gate on, but we
        // fetch both — the raw string goes to the UI, the numeric
        // gives us robust major/minor without parsing vendor decoration.
        let raw: String = sqlx::query_scalar("SHOW server_version")
            .fetch_one(&pool)
            .await
            .map_err(map_sqlx_error)?;
        let num: String = sqlx::query_scalar("SHOW server_version_num")
            .fetch_one(&pool)
            .await
            .map_err(map_sqlx_error)?;
        // server_version_num is `MMmmpp` up to PG9, then `MMmmss` from
        // PG10+ (single-digit minor, patch fills the last two digits).
        // For our capability gates only major matters.
        let numeric: u32 = num.parse().unwrap_or(0);
        let major = if numeric >= 100000 {
            Some(numeric / 10000)
        } else {
            Some(numeric / 10000)
        };
        let minor = Some((numeric / 100) % 100);
        Ok(ServerInfo {
            major,
            minor,
            raw,
            flags: ServerFlags::default(),
        })
    }

    async fn execute(
        &self,
        profile: &ConnectionProfile,
        req: QueryRequest,
    ) -> Result<QueryResult> {
        let pool = self.pool_for(profile).await?;
        let started = std::time::Instant::now();
        let limit = req.limit.unwrap_or(DEFAULT_ROW_LIMIT) as usize;

        // Scripts with multiple statements are run sequentially. The last
        // statement's result is what the UI shows. Earlier write statements
        // still execute (their effects persist); we just don't surface their
        // row counts.
        let statements = split::split_statements(&req.sql);
        if statements.is_empty() {
            return Err(DbError::InvalidInput(
                "no SQL statement to execute".to_string(),
            ));
        }

        let mut last: Option<QueryResult> = None;
        for stmt in &statements {
            last = Some(run_single(&pool, stmt, limit, req.query_id, &self.query_pids).await?);
        }

        let mut out = last.expect("at least one statement");
        out.elapsed_ms = started.elapsed().as_millis() as u64;
        Ok(out)
    }

    async fn cancel_query(&self, profile: &ConnectionProfile, query_id: Uuid) -> Result<()> {
        // Look up the backend PID we registered when the query started.
        // Unknown id is a no-op — the most common case is the query
        // already finished before the cancel arrived.
        let pid = match self.query_pids.get(&query_id) {
            Some(entry) => *entry.value(),
            None => return Ok(()),
        };
        // Open a side connection from the same pool to send the cancel
        // signal. The pool's max_connections (5) is enough — even when
        // the user's query has one slot pinned, four remain free.
        let pool = self.pool_for(profile).await?;
        sqlx::query("SELECT pg_cancel_backend($1)")
            .bind(pid)
            .execute(&pool)
            .await
            .map_err(map_sqlx_error)?;
        Ok(())
    }

    async fn schema(&self, profile: &ConnectionProfile) -> Result<Schema> {
        let pool = self.pool_for(profile).await?;
        introspect::load_schema(&pool).await
    }

    async fn update_cell(
        &self,
        profile: &ConnectionProfile,
        update: CellUpdate,
    ) -> Result<u64> {
        if update.pk.is_empty() {
            return Err(DbError::InvalidInput(
                "update_cell requires at least one pk column".into(),
            ));
        }
        let pool = self.pool_for(profile).await?;

        let mut q: QueryBuilder<Postgres> = QueryBuilder::new("UPDATE ");
        q.push(pg_ident(&update.schema));
        q.push(".");
        q.push(pg_ident(&update.table));
        q.push(" SET ");
        q.push(pg_ident(&update.set_column));
        q.push(" = ");
        push_pg_value(&mut q, &update.new_value);

        q.push(" WHERE ");
        for (i, (col, val)) in update.pk.iter().enumerate() {
            if i > 0 {
                q.push(" AND ");
            }
            q.push(pg_ident(col));
            q.push(" = ");
            push_pg_value(&mut q, val);
        }

        let result = q.build().execute(&pool).await.map_err(map_sqlx_error)?;
        Ok(result.rows_affected())
    }

    async fn insert_row(
        &self,
        profile: &ConnectionProfile,
        req: RowInsert,
    ) -> Result<u64> {
        if req.values.is_empty() {
            return Err(DbError::InvalidInput(
                "insert_row requires at least one column value".into(),
            ));
        }
        let pool = self.pool_for(profile).await?;

        let mut q: QueryBuilder<Postgres> = QueryBuilder::new("INSERT INTO ");
        q.push(pg_ident(&req.schema));
        q.push(".");
        q.push(pg_ident(&req.table));

        q.push(" (");
        for (i, (col, _)) in req.values.iter().enumerate() {
            if i > 0 {
                q.push(", ");
            }
            q.push(pg_ident(col));
        }
        q.push(") VALUES (");
        for (i, (_, val)) in req.values.iter().enumerate() {
            if i > 0 {
                q.push(", ");
            }
            push_pg_value(&mut q, val);
        }
        q.push(")");

        let result = q.build().execute(&pool).await.map_err(map_sqlx_error)?;
        Ok(result.rows_affected())
    }

    async fn delete_row(
        &self,
        profile: &ConnectionProfile,
        req: RowDelete,
    ) -> Result<u64> {
        if req.pk.is_empty() {
            return Err(DbError::InvalidInput(
                "delete_row requires at least one pk column".into(),
            ));
        }
        let pool = self.pool_for(profile).await?;

        let mut q: QueryBuilder<Postgres> = QueryBuilder::new("DELETE FROM ");
        q.push(pg_ident(&req.schema));
        q.push(".");
        q.push(pg_ident(&req.table));
        q.push(" WHERE ");
        for (i, (col, val)) in req.pk.iter().enumerate() {
            if i > 0 {
                q.push(" AND ");
            }
            q.push(pg_ident(col));
            q.push(" = ");
            push_pg_value(&mut q, val);
        }

        let result = q.build().execute(&pool).await.map_err(map_sqlx_error)?;
        Ok(result.rows_affected())
    }

    async fn disconnect(&self, profile: &ConnectionProfile) -> Result<()> {
        if let Some((_, pool)) = self.pools.remove(&profile.id) {
            pool.close().await;
        }
        // Drop the tunnel last so any in-flight pool teardown can still flow
        // through it.
        self.tunnels.remove(&profile.id);
        Ok(())
    }

    async fn dry_run(
        &self,
        profile: &ConnectionProfile,
        statements: Vec<String>,
    ) -> Result<Vec<LintResult>> {
        let pool = self.pool_for(profile).await?;
        let mut tx = pool.begin().await.map_err(map_sqlx_error)?;
        let mut out = Vec::with_capacity(statements.len());
        for (index, sql) in statements.iter().enumerate() {
            // Savepoint per statement so a rejected one doesn't
            // taint the outer transaction — subsequent lints still
            // run against a clean state.
            let sp = format!("bearhold_lint_{index}");
            sqlx::query(&format!("SAVEPOINT {sp}"))
                .execute(&mut *tx)
                .await
                .map_err(map_sqlx_error)?;
            let outcome = match sqlx::query(sql).execute(&mut *tx).await {
                Ok(_) => {
                    sqlx::query(&format!("ROLLBACK TO SAVEPOINT {sp}"))
                        .execute(&mut *tx)
                        .await
                        .map_err(map_sqlx_error)?;
                    LintOutcome::Ok
                }
                Err(e) => {
                    let _ = sqlx::query(&format!("ROLLBACK TO SAVEPOINT {sp}"))
                        .execute(&mut *tx)
                        .await;
                    LintOutcome::Fail {
                        error: format!("{e}"),
                    }
                }
            };
            out.push(LintResult { index, outcome });
        }
        // Outer rollback: everything is unwound already, but this
        // catches any escaped savepoint state.
        let _ = tx.rollback().await;
        Ok(out)
    }
}

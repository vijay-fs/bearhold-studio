//! MySQL driver. Uses sqlx with the Tokio runtime.

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
    AuthMethod, BatchResult, BatchStatementOutcome, BatchStatementResult, CellUpdate,
    ConnectionProfile, DbError, Driver, LintOutcome, LintResult, QueryRequest, QueryResult, Result,
    ResultColumn, RowDelete, RowInsert, Schema, SshAuth, TlsMode, Value,
};
use sqlx::{
    mysql::{MySql, MySqlPool, MySqlPoolOptions},
    Column, QueryBuilder, Row, TypeInfo,
};
use tracing::info;
use uuid::Uuid;

use crate::map_error::map_sqlx_error;

const DEFAULT_ROW_LIMIT: u32 = 10_000;

pub struct MySqlDriver {
    pools: Arc<DashMap<Uuid, MySqlPool>>,
    tunnels: Arc<DashMap<Uuid, Arc<Tunnel>>>,
    /// Map from caller-supplied `query_id` → server-assigned CONNECTION_ID()
    /// of the connection running it. Drained when the statement finishes.
    /// A sibling `cancel_query` looks up the id and issues `KILL QUERY <id>`
    /// on a side connection from the same pool.
    query_conn_ids: Arc<DashMap<Uuid, u64>>,
}

impl MySqlDriver {
    pub fn new() -> Self {
        Self {
            pools: Arc::new(DashMap::new()),
            tunnels: Arc::new(DashMap::new()),
            query_conn_ids: Arc::new(DashMap::new()),
        }
    }

    async fn pool_for(&self, profile: &ConnectionProfile) -> Result<MySqlPool> {
        if let Some(pool) = self.pools.get(&profile.id) {
            return Ok(pool.clone());
        }

        let (host, port) = if let Some(cfg) = &profile.ssh_tunnel {
            let tunnel = self.ensure_tunnel(profile, cfg).await?;
            ("127.0.0.1".to_string(), tunnel.local_port())
        } else {
            (profile.host.clone(), profile.port)
        };

        let url = build_connection_url(profile, &host, port).await?;
        let pool = MySqlPoolOptions::new()
            // Keep the pool tight. We're a single-user desktop app
            // talking to MySQL servers that often run with strict
            // `max_connections` caps (cheap managed instances cap
            // at 10–30; shared servers even less). Two connections
            // covers the realistic concurrency — one for the active
            // query, one for the sibling `KILL QUERY` route — and
            // leaves headroom for other clients on the same server.
            // Users who want more can hand-edit; the default has to
            // be the smallest workable value.
            .max_connections(2)
            // Start empty. sqlx defaults `min_connections` to 0
            // already but we set it explicitly so a future default
            // change doesn't quietly pre-warm connections.
            .min_connections(0)
            .acquire_timeout(std::time::Duration::from_secs(10))
            // See the matching note in the Postgres driver.
            .test_before_acquire(true)
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
            let pw = if password_ref.is_empty() {
                secrets::get(profile_id, Slot::SshTunnelPassword).await?
            } else {
                Some(password_ref.clone())
            };
            let pw = pw
                .ok_or_else(|| DbError::AuthFailed("ssh tunnel password not in keychain".into()))?;
            Ok(BastionAuth::Password(pw))
        }
        SshAuth::Key {
            key_ref,
            passphrase_ref,
        } => {
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

impl Default for MySqlDriver {
    fn default() -> Self {
        Self::new()
    }
}

async fn build_connection_url(
    profile: &ConnectionProfile,
    host: &str,
    port: u16,
) -> Result<String> {
    let (username, password) = match &profile.auth {
        AuthMethod::Password {
            username,
            password_ref,
        } => {
            let pw = if password_ref.is_empty() {
                secrets::get(profile.id, Slot::Password).await?
            } else {
                Some(password_ref.clone())
            };
            (username.clone(), pw)
        }
        AuthMethod::SshKey { username, .. } => (username.clone(), None),
        _ => {
            return Err(DbError::InvalidInput(
                "mysql requires a username".to_string(),
            ))
        }
    };

    let mut url =
        url::Url::parse("mysql://placeholder/").map_err(|e| DbError::Internal(e.to_string()))?;
    url.set_host(Some(host))
        .map_err(|e| DbError::Internal(format!("invalid host: {e:?}")))?;
    url.set_port(Some(port))
        .map_err(|_| DbError::Internal("invalid port".to_string()))?;
    if !profile.database.is_empty() {
        url.set_path(&profile.database);
    }
    url.set_username(&username)
        .map_err(|_| DbError::Internal("invalid username".to_string()))?;
    if let Some(p) = password {
        if !p.is_empty() {
            url.set_password(Some(&p))
                .map_err(|_| DbError::Internal("invalid password".to_string()))?;
        }
    }
    // Honor the profile's TLS mode. Without an explicit ssl-mode sqlx
    // defaults to PREFERRED, which does no certificate verification
    // and silently falls back to plaintext — so a profile configured
    // as `verify_full` got neither verification nor a guaranteed
    // encrypted channel.
    let ssl_mode = match profile.tls {
        TlsMode::Disable => "DISABLED",
        TlsMode::Prefer => "PREFERRED",
        TlsMode::Require => "REQUIRED",
        TlsMode::VerifyCa => "VERIFY_CA",
        TlsMode::VerifyFull => "VERIFY_IDENTITY",
    };
    url.query_pairs_mut().append_pair("ssl-mode", ssl_mode);
    Ok(url.into())
}

/// Quote a MySQL identifier with backticks. Doubles any embedded backtick.
fn mysql_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// Bind a JSON value as a MySQL parameter.
fn push_mysql_value(q: &mut QueryBuilder<'_, MySql>, v: &Value) {
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
                q.push_bind(n.to_string());
            }
        }
        Value::String(s) => {
            q.push_bind(s.clone());
        }
        Value::Array(_) | Value::Object(_) => {
            q.push_bind(v.to_string());
        }
    }
}

/// Same heuristic as the Postgres driver — see notes in that crate.
fn is_query_statement(sql: &str) -> bool {
    matches!(
        leading_keyword(sql).to_ascii_uppercase().as_str(),
        "SELECT" | "WITH" | "SHOW" | "EXPLAIN" | "DESCRIBE" | "DESC" | "VALUES" | "TABLE"
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
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if b == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
        } else if b == b'#' {
            // MySQL also recognises `#` as a line-comment.
            i += 1;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else {
            break;
        }
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        i += 1;
    }
    std::str::from_utf8(&bytes[start..i])
        .unwrap_or("")
        .to_string()
}

#[async_trait]
impl Driver for MySqlDriver {
    async fn connect(&self, profile: &ConnectionProfile) -> Result<()> {
        info!(profile_id = %profile.id, "opening mysql pool");
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
        // `SELECT VERSION()` returns e.g. `8.0.39`.
        let raw: String = sqlx::query_scalar("SELECT VERSION()")
            .fetch_one(&pool)
            .await
            .map_err(map_sqlx_error)?;
        let (major, minor) = ServerInfo::parse_version(&raw);
        // sql_mode drives whether string literals accept backslash
        // escapes. If NO_BACKSLASH_ESCAPES is set we have to emit
        // doubled-quote escapes instead — the frontend's
        // sqlLiteral.ts uses `flags.no_backslash_escapes` to switch.
        let sql_mode: String = sqlx::query_scalar("SELECT @@sql_mode")
            .fetch_one(&pool)
            .await
            .unwrap_or_default();
        let no_backslash_escapes = sql_mode
            .split(',')
            .any(|m| m.trim().eq_ignore_ascii_case("NO_BACKSLASH_ESCAPES"));
        Ok(ServerInfo {
            major,
            minor,
            raw,
            flags: ServerFlags {
                no_backslash_escapes,
            },
        })
    }

    async fn execute(&self, profile: &ConnectionProfile, req: QueryRequest) -> Result<QueryResult> {
        let pool = self.pool_for(profile).await?;
        let started = std::time::Instant::now();
        let limit = req.limit.unwrap_or(DEFAULT_ROW_LIMIT) as usize;

        let statements = split::split_statements(&req.sql);
        if statements.is_empty() {
            return Err(DbError::InvalidInput(
                "no SQL statement to execute".to_string(),
            ));
        }

        let mut last: Option<QueryResult> = None;
        for stmt in &statements {
            last = Some(run_single(&pool, stmt, limit, req.query_id, &self.query_conn_ids).await?);
        }

        let mut out = last.expect("at least one statement");
        out.elapsed_ms = started.elapsed().as_millis() as u64;
        Ok(out)
    }

    async fn cancel_query(&self, profile: &ConnectionProfile, query_id: Uuid) -> Result<()> {
        let conn_id = match self.query_conn_ids.get(&query_id) {
            Some(entry) => *entry.value(),
            None => return Ok(()),
        };
        let pool = self.pool_for(profile).await?;
        // `KILL QUERY <id>` aborts the in-flight statement but keeps the
        // connection alive. `KILL <id>` (without QUERY) would close the
        // whole connection, which the pool would then have to replace.
        sqlx::query(&format!("KILL QUERY {}", conn_id))
            .execute(&pool)
            .await
            .map_err(map_sqlx_error)?;
        Ok(())
    }

    async fn schema(&self, profile: &ConnectionProfile) -> Result<Schema> {
        let pool = self.pool_for(profile).await?;
        introspect::load_schema(&pool, &profile.database).await
    }

    async fn update_cell(&self, profile: &ConnectionProfile, update: CellUpdate) -> Result<u64> {
        if update.pk.is_empty() {
            return Err(DbError::InvalidInput(
                "update_cell requires at least one pk column".into(),
            ));
        }
        let pool = self.pool_for(profile).await?;

        let mut q: QueryBuilder<MySql> = QueryBuilder::new("UPDATE ");
        // MySQL "schema" == database name. If it matches the connection's
        // active database, we can omit it; otherwise qualify the table.
        if !update.schema.is_empty() && update.schema != profile.database {
            q.push(mysql_ident(&update.schema));
            q.push(".");
        }
        q.push(mysql_ident(&update.table));
        q.push(" SET ");
        q.push(mysql_ident(&update.set_column));
        q.push(" = ");
        push_mysql_value(&mut q, &update.new_value);

        q.push(" WHERE ");
        for (i, (col, val)) in update.pk.iter().enumerate() {
            if i > 0 {
                q.push(" AND ");
            }
            q.push(mysql_ident(col));
            q.push(" = ");
            push_mysql_value(&mut q, val);
        }

        let result = q.build().execute(&pool).await.map_err(map_sqlx_error)?;
        Ok(result.rows_affected())
    }

    async fn insert_row(&self, profile: &ConnectionProfile, req: RowInsert) -> Result<u64> {
        if req.values.is_empty() {
            return Err(DbError::InvalidInput(
                "insert_row requires at least one column value".into(),
            ));
        }
        let pool = self.pool_for(profile).await?;

        let mut q: QueryBuilder<MySql> = QueryBuilder::new("INSERT INTO ");
        if !req.schema.is_empty() && req.schema != profile.database {
            q.push(mysql_ident(&req.schema));
            q.push(".");
        }
        q.push(mysql_ident(&req.table));

        q.push(" (");
        for (i, (col, _)) in req.values.iter().enumerate() {
            if i > 0 {
                q.push(", ");
            }
            q.push(mysql_ident(col));
        }
        q.push(") VALUES (");
        for (i, (_, val)) in req.values.iter().enumerate() {
            if i > 0 {
                q.push(", ");
            }
            push_mysql_value(&mut q, val);
        }
        q.push(")");

        let result = q.build().execute(&pool).await.map_err(map_sqlx_error)?;
        Ok(result.rows_affected())
    }

    async fn delete_row(&self, profile: &ConnectionProfile, req: RowDelete) -> Result<u64> {
        if req.pk.is_empty() {
            return Err(DbError::InvalidInput(
                "delete_row requires at least one pk column".into(),
            ));
        }
        let pool = self.pool_for(profile).await?;

        let mut q: QueryBuilder<MySql> = QueryBuilder::new("DELETE FROM ");
        if !req.schema.is_empty() && req.schema != profile.database {
            q.push(mysql_ident(&req.schema));
            q.push(".");
        }
        q.push(mysql_ident(&req.table));
        q.push(" WHERE ");
        for (i, (col, val)) in req.pk.iter().enumerate() {
            if i > 0 {
                q.push(" AND ");
            }
            q.push(mysql_ident(col));
            q.push(" = ");
            push_mysql_value(&mut q, val);
        }

        let result = q.build().execute(&pool).await.map_err(map_sqlx_error)?;
        Ok(result.rows_affected())
    }

    async fn disconnect(&self, profile: &ConnectionProfile) -> Result<()> {
        if let Some((_, pool)) = self.pools.remove(&profile.id) {
            pool.close().await;
        }
        self.tunnels.remove(&profile.id);
        Ok(())
    }

    async fn dry_run(
        &self,
        profile: &ConnectionProfile,
        statements: Vec<String>,
    ) -> Result<Vec<LintResult>> {
        // MySQL DDL implicit-commits, so BEGIN/ROLLBACK
        // WON'T undo an ALTER. Two strategies by statement kind:
        //   - DDL: PREPARE for syntax check only (no execution). Not
        //     every ALTER shape supports PREPARE — those return
        //     Unverifiable so the UI shows "will validate on Apply".
        //   - DML: EXPLAIN. Fully parses + plans without executing
        //     the write. Real dry-run for INSERT/UPDATE/DELETE.
        let pool = self.pool_for(profile).await?;
        let mut out = Vec::with_capacity(statements.len());
        for (index, sql) in statements.iter().enumerate() {
            let outcome = if is_ddl_statement(sql) {
                let probe = format!(
                    "PREPARE bearhold_lint_probe FROM {}",
                    mysql_string_literal(sql)
                );
                match sqlx::query(&probe).execute(&pool).await {
                    Ok(_) => {
                        let _ = sqlx::query("DEALLOCATE PREPARE bearhold_lint_probe")
                            .execute(&pool)
                            .await;
                        LintOutcome::Ok
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        if looks_like_hard_error(&msg) {
                            LintOutcome::Fail { error: msg }
                        } else {
                            LintOutcome::Unverifiable {
                                reason:
                                    "MySQL cannot fully dry-run this DDL. It will be validated when you click Apply."
                                        .into(),
                            }
                        }
                    }
                }
            } else {
                let probe = format!("EXPLAIN {sql}");
                match sqlx::query(&probe).execute(&pool).await {
                    Ok(_) => LintOutcome::Ok,
                    Err(e) => LintOutcome::Fail {
                        error: e.to_string(),
                    },
                }
            };
            out.push(LintResult { index, outcome });
        }
        Ok(out)
    }

    async fn apply_batch(
        &self,
        profile: &ConnectionProfile,
        statements: Vec<String>,
    ) -> Result<BatchResult> {
        // MySQL's implicit DDL commit means a batch of ALTERs can't
        // be fully rolled back. Strategy:
        //   - Pure DML batch  → run inside BEGIN/COMMIT, atomic
        //   - Any DDL present → run each statement outside a tx;
        //                        on failure, remaining statements
        //                        are skipped and we surface which
        //                        prior ones already committed.
        // The frontend uses these outcomes to build the migration
        // log so users know precisely what happened.
        let pool = self.pool_for(profile).await?;
        let contains_ddl = statements.iter().any(|s| is_ddl_statement(s));
        let mut results: Vec<BatchStatementResult> = Vec::with_capacity(statements.len());
        let mut failed_at: Option<usize> = None;

        if !contains_ddl {
            // DML-only fast path: BEGIN + COMMIT wraps everything.
            let mut tx = pool.begin().await.map_err(map_sqlx_error)?;
            for (index, sql) in statements.iter().enumerate() {
                if failed_at.is_some() {
                    results.push(BatchStatementResult {
                        index,
                        outcome: BatchStatementOutcome::Skipped,
                    });
                    continue;
                }
                match sqlx::query(sql).execute(&mut *tx).await {
                    Ok(res) => results.push(BatchStatementResult {
                        index,
                        outcome: BatchStatementOutcome::Ok {
                            rows_affected: Some(res.rows_affected()),
                        },
                    }),
                    Err(e) => {
                        results.push(BatchStatementResult {
                            index,
                            outcome: BatchStatementOutcome::Fail {
                                error: format!("{e}"),
                            },
                        });
                        failed_at = Some(index);
                    }
                }
            }
            return if failed_at.is_some() {
                let _ = tx.rollback().await;
                Ok(BatchResult {
                    committed: false,
                    statements: results,
                    summary: format!("rolled back: statement #{} failed", failed_at.unwrap() + 1),
                })
            } else {
                tx.commit().await.map_err(map_sqlx_error)?;
                Ok(BatchResult {
                    committed: true,
                    statements: results,
                    summary: format!("committed {} statements", statements.len()),
                })
            };
        }

        // Contains DDL: no rollback safety net. Run one-by-one and
        // stop-on-error. Everything before the failure has already
        // been auto-committed by MySQL.
        for (index, sql) in statements.iter().enumerate() {
            if failed_at.is_some() {
                results.push(BatchStatementResult {
                    index,
                    outcome: BatchStatementOutcome::Skipped,
                });
                continue;
            }
            match sqlx::query(sql).execute(&pool).await {
                Ok(res) => results.push(BatchStatementResult {
                    index,
                    outcome: BatchStatementOutcome::Ok {
                        rows_affected: Some(res.rows_affected()),
                    },
                }),
                Err(e) => {
                    results.push(BatchStatementResult {
                        index,
                        outcome: BatchStatementOutcome::Fail {
                            error: format!("{e}"),
                        },
                    });
                    failed_at = Some(index);
                }
            }
        }
        let ok_count = results
            .iter()
            .filter(|r| matches!(r.outcome, BatchStatementOutcome::Ok { .. }))
            .count();
        Ok(BatchResult {
            committed: failed_at.is_none(),
            statements: results,
            summary: if let Some(idx) = failed_at {
                format!(
                    "partial: {} succeeded before statement #{} failed (MySQL DDL auto-commits)",
                    ok_count,
                    idx + 1
                )
            } else {
                format!("committed {} statements", statements.len())
            },
        })
    }
}

fn is_ddl_statement(sql: &str) -> bool {
    let first = sql
        .trim_start()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    matches!(
        first.as_str(),
        "ALTER" | "CREATE" | "DROP" | "TRUNCATE" | "RENAME" | "COMMENT" | "GRANT" | "REVOKE"
    )
}

fn mysql_string_literal(s: &str) -> String {
    // For the PREPARE probe. Backslash + single-quote escaping — this
    // is our own SQL we control, so we don't need sql_mode-aware
    // NO_BACKSLASH_ESCAPES handling.
    let escaped = s.replace('\\', "\\\\").replace('\'', "\\'");
    format!("'{escaped}'")
}

fn looks_like_hard_error(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("syntax")
        || lower.contains("1064")
        || lower.contains("unknown column")
        || lower.contains("unknown table")
        || lower.contains("doesn't exist")
        || lower.contains("does not exist")
}

async fn run_single(
    pool: &MySqlPool,
    sql: &str,
    limit: usize,
    query_id: Option<Uuid>,
    query_conn_ids: &Arc<DashMap<Uuid, u64>>,
) -> Result<QueryResult> {
    // Pin one pool connection for the lifetime of this statement so the
    // CONNECTION_ID() we look up corresponds to the connection that
    // actually executes the user's query — and so a sibling `KILL QUERY`
    // hits the right thread.
    let mut conn = pool.acquire().await.map_err(map_sqlx_error)?;

    if let Some(qid) = query_id {
        let conn_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
            .fetch_one(&mut *conn)
            .await
            .map_err(map_sqlx_error)?;
        query_conn_ids.insert(qid, conn_id);
    }
    let _guard = MysqlQueryIdGuard {
        registry: query_conn_ids,
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

    let mysql_rows = sqlx::query(sql)
        .fetch_all(&mut *conn)
        .await
        .map_err(map_sqlx_error)?;

    let columns: Vec<ResultColumn> = mysql_rows
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

    let truncated = mysql_rows.len() > limit;
    let mut rows = Vec::with_capacity(mysql_rows.len().min(limit));
    for row in mysql_rows.iter().take(limit) {
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

/// Drop guard mirroring the PG side — removes the (query_id, connection_id)
/// entry on every exit path so a stale id can't accidentally KILL QUERY a
/// connection that's been recycled by the pool.
struct MysqlQueryIdGuard<'a> {
    registry: &'a Arc<DashMap<Uuid, u64>>,
    qid: Option<Uuid>,
}

impl Drop for MysqlQueryIdGuard<'_> {
    fn drop(&mut self) {
        if let Some(qid) = self.qid {
            self.registry.remove(&qid);
        }
    }
}

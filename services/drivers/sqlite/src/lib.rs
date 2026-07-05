//! SQLite driver. Connects to a local file via sqlx. No host/port/auth.

mod decode;
mod introspect;
mod map_error;
mod split;

use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use dbstudio_core::{
    server_info::{ServerFlags, ServerInfo},
    CellUpdate, ConnectionProfile, DbError, Driver, LintOutcome, LintResult, QueryRequest,
    QueryResult, ResultColumn, Result, RowDelete, RowInsert, Schema, Value,
};
use sqlx::{
    sqlite::{Sqlite, SqlitePool, SqlitePoolOptions},
    Column, QueryBuilder, Row, TypeInfo,
};
use tracing::info;
use uuid::Uuid;

use crate::map_error::map_sqlx_error;

const DEFAULT_ROW_LIMIT: u32 = 10_000;

pub struct SqliteDriver {
    pools: Arc<DashMap<Uuid, SqlitePool>>,
}

impl SqliteDriver {
    pub fn new() -> Self {
        Self {
            pools: Arc::new(DashMap::new()),
        }
    }

    async fn pool_for(&self, profile: &ConnectionProfile) -> Result<SqlitePool> {
        if let Some(pool) = self.pools.get(&profile.id) {
            return Ok(pool.clone());
        }

        let url = build_connection_url(profile)?;
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect(&url)
            .await
            .map_err(map_sqlx_error)?;

        self.pools.insert(profile.id, pool.clone());
        Ok(pool)
    }

    /// Flush the WAL into the main database file and truncate it.
    /// Required before the "file copy" export path — modern SQLite
    /// defaults to WAL journalling, which means recent writes live in
    /// a `-wal` sidecar file until the next checkpoint. Copying only
    /// the main `.sqlite` file without a checkpoint would produce an
    /// almost-empty snapshot even for a large database.
    ///
    /// `TRUNCATE` mode does a full checkpoint AND shrinks the WAL to
    /// 0 bytes, so a subsequent `fs::copy` produces a byte-accurate,
    /// self-contained snapshot.
    pub async fn checkpoint_wal(&self, profile: &ConnectionProfile) -> Result<()> {
        let pool = self.pool_for(profile).await?;
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE);")
            .execute(&pool)
            .await
            .map_err(map_sqlx_error)?;
        Ok(())
    }
}

impl Default for SqliteDriver {
    fn default() -> Self {
        Self::new()
    }
}

fn build_connection_url(profile: &ConnectionProfile) -> Result<String> {
    let path = profile
        .file_path
        .as_ref()
        .ok_or_else(|| DbError::InvalidInput("sqlite requires a file path".into()))?;
    // sqlx accepts `sqlite:<path>` and `sqlite:///abs/path`. `sqlite://` with
    // two slashes is invalid in sqlx 0.8 — use the bare form.
    Ok(format!("sqlite:{}", path.display()))
}

fn is_query_statement(sql: &str) -> bool {
    matches!(
        leading_keyword(sql).to_ascii_uppercase().as_str(),
        "SELECT" | "WITH" | "PRAGMA" | "EXPLAIN" | "VALUES"
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

#[async_trait]
impl Driver for SqliteDriver {
    async fn connect(&self, profile: &ConnectionProfile) -> Result<()> {
        info!(profile_id = %profile.id, "opening sqlite pool");
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
        // `sqlite_version()` returns `3.46.1`. Gates like RETURNING
        // (3.35+) and ON CONFLICT (3.24+) depend on minor.
        let raw: String = sqlx::query_scalar("SELECT sqlite_version()")
            .fetch_one(&pool)
            .await
            .map_err(map_sqlx_error)?;
        let (major, minor) = ServerInfo::parse_version(&raw);
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

        let statements = split::split_statements(&req.sql);
        if statements.is_empty() {
            return Err(DbError::InvalidInput(
                "no SQL statement to execute".to_string(),
            ));
        }

        let mut last: Option<QueryResult> = None;
        for stmt in &statements {
            last = Some(run_single(&pool, stmt, limit).await?);
        }

        let mut out = last.expect("at least one statement");
        out.elapsed_ms = started.elapsed().as_millis() as u64;
        Ok(out)
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

        // SQLite ignores the schema parameter — there's only the `main`
        // database (attached databases are out of scope here).
        let mut q: QueryBuilder<Sqlite> = QueryBuilder::new("UPDATE ");
        q.push(sqlite_ident(&update.table));
        q.push(" SET ");
        q.push(sqlite_ident(&update.set_column));
        q.push(" = ");
        push_sqlite_value(&mut q, &update.new_value);

        q.push(" WHERE ");
        for (i, (col, val)) in update.pk.iter().enumerate() {
            if i > 0 {
                q.push(" AND ");
            }
            q.push(sqlite_ident(col));
            q.push(" = ");
            push_sqlite_value(&mut q, val);
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

        let mut q: QueryBuilder<Sqlite> = QueryBuilder::new("INSERT INTO ");
        q.push(sqlite_ident(&req.table));

        q.push(" (");
        for (i, (col, _)) in req.values.iter().enumerate() {
            if i > 0 {
                q.push(", ");
            }
            q.push(sqlite_ident(col));
        }
        q.push(") VALUES (");
        for (i, (_, val)) in req.values.iter().enumerate() {
            if i > 0 {
                q.push(", ");
            }
            push_sqlite_value(&mut q, val);
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

        let mut q: QueryBuilder<Sqlite> = QueryBuilder::new("DELETE FROM ");
        q.push(sqlite_ident(&req.table));
        q.push(" WHERE ");
        for (i, (col, val)) in req.pk.iter().enumerate() {
            if i > 0 {
                q.push(" AND ");
            }
            q.push(sqlite_ident(col));
            q.push(" = ");
            push_sqlite_value(&mut q, val);
        }

        let result = q.build().execute(&pool).await.map_err(map_sqlx_error)?;
        Ok(result.rows_affected())
    }

    async fn cancel_query(&self, _profile: &ConnectionProfile, _query_id: Uuid) -> Result<()> {
        // SQLite queries can be interrupted via `sqlite3_interrupt`, but
        // sqlx-sqlite doesn't expose it through a stable API and getting
        // the raw handle out of a pooled connection is fragile. For now
        // surface "unsupported" — SQLite queries in this app are typically
        // short enough that mid-flight cancel isn't critical, and the
        // frontend can still abandon the pending promise locally.
        Err(DbError::Unsupported(
            "SQLite does not support mid-flight query cancel in this build".to_string(),
        ))
    }

    async fn disconnect(&self, profile: &ConnectionProfile) -> Result<()> {
        if let Some((_, pool)) = self.pools.remove(&profile.id) {
            pool.close().await;
        }
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
        let _ = tx.rollback().await;
        Ok(out)
    }
}

/// Quote a SQLite identifier with double-quotes. Doubles any embedded `"`.
fn sqlite_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn push_sqlite_value(q: &mut QueryBuilder<'_, Sqlite>, v: &Value) {
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

async fn run_single(pool: &SqlitePool, sql: &str, limit: usize) -> Result<QueryResult> {
    if !is_query_statement(sql) {
        let result = sqlx::query(sql)
            .execute(pool)
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

    let sqlite_rows = sqlx::query(sql)
        .fetch_all(pool)
        .await
        .map_err(map_sqlx_error)?;

    let columns: Vec<ResultColumn> = sqlite_rows
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

    let truncated = sqlite_rows.len() > limit;
    let mut rows = Vec::with_capacity(sqlite_rows.len().min(limit));
    for row in sqlite_rows.iter().take(limit) {
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

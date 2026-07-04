use async_trait::async_trait;
use uuid::Uuid;

use crate::{
    connection::ConnectionProfile,
    error::{DbError, Result},
    query::{CellUpdate, QueryRequest, QueryResult, RowDelete, RowInsert},
    schema::Schema,
    server_info::ServerInfo,
};

/// The contract every database driver implements.
///
/// Drivers normalize their engine's native errors into `DbError` and their
/// schema metadata into `Schema` so the frontend can stay engine-agnostic.
#[async_trait]
pub trait Driver: Send + Sync {
    /// Open a live connection (or connection pool). Returns a handle the
    /// caller stores; subsequent calls go through `execute` / `schema`.
    async fn connect(&self, profile: &ConnectionProfile) -> Result<()>;

    /// Cheap, low-impact reachability check. Used by the connection form's
    /// "Test connection" button.
    async fn ping(&self, profile: &ConnectionProfile) -> Result<()>;

    /// Run a SQL or engine-native query. Drivers that don't have ad-hoc query
    /// surface (Redis, etc.) return `DbError::Unsupported`.
    async fn execute(&self, profile: &ConnectionProfile, req: QueryRequest) -> Result<QueryResult>;

    /// Introspect the schema. This is the input to the ER diagram view.
    async fn schema(&self, profile: &ConnectionProfile) -> Result<Schema>;

    /// Update a single cell via parameterized UPDATE. Returns the number of
    /// rows affected — callers should refuse to apply when it isn't exactly 1
    /// (the PK filter didn't match anything, or matched more than one).
    async fn update_cell(&self, profile: &ConnectionProfile, update: CellUpdate) -> Result<u64>;

    /// INSERT a new row. Returns rows_affected (1 on success).
    async fn insert_row(&self, profile: &ConnectionProfile, req: RowInsert) -> Result<u64>;

    /// DELETE the row matching the supplied PK. Returns rows_affected —
    /// callers should refuse to treat anything but 1 as success.
    async fn delete_row(&self, profile: &ConnectionProfile, req: RowDelete) -> Result<u64>;

    /// Cancel an in-flight `execute` whose `QueryRequest::query_id` matches
    /// `query_id`. Engines that support this open a side connection and
    /// signal the original backend (`pg_cancel_backend`, `KILL QUERY`).
    /// Returns `Ok(())` for an unknown id — the query may have already
    /// finished by the time the cancel arrived, which is harmless.
    async fn cancel_query(&self, profile: &ConnectionProfile, query_id: Uuid) -> Result<()>;

    /// Close any pools associated with the profile.
    async fn disconnect(&self, profile: &ConnectionProfile) -> Result<()>;

    /// Fetch server-version + capability flags. Default impl returns
    /// `Unsupported` — drivers that can answer override this. The
    /// frontend's engine-version dispatch treats "no info" as the
    /// safe-minimum capability set, so this method staying unset is
    /// never worse than the previous behavior; overriding it just
    /// unlocks modern SQL syntax on modern servers.
    async fn server_info(&self, _profile: &ConnectionProfile) -> Result<ServerInfo> {
        Err(DbError::Unsupported(
            "server_info not implemented by this driver".into(),
        ))
    }

    /// Dry-run a batch of SQL statements without persisting effects.
    /// Returns one outcome per input statement. Backends differ in
    /// what they can verify safely:
    ///   - PG / SQLite: fully transactional DDL, so the driver
    ///     BEGINs, runs each statement inside a SAVEPOINT, and rolls
    ///     back — a true dry-run of any statement.
    ///   - MySQL: DDL auto-commits, so the driver PREPAREs DDL for
    ///     syntax check only, and uses EXPLAIN on DML. Some ALTER
    ///     shapes can't be PREPAREd — those return `Unverifiable`,
    ///     letting the UI surface a "will validate on Apply" note
    ///     instead of a false-positive green check.
    async fn dry_run(
        &self,
        _profile: &ConnectionProfile,
        _statements: Vec<String>,
    ) -> Result<Vec<LintResult>> {
        Err(DbError::Unsupported(
            "dry_run not implemented by this driver".into(),
        ))
    }
}

/// Outcome of dry-running one SQL statement. Kept in this crate so
/// every driver signature agrees without pulling in a UI-tier crate.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LintOutcome {
    Ok,
    Fail { error: String },
    Unverifiable { reason: String },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LintResult {
    pub index: usize,
    pub outcome: LintOutcome,
}

use async_trait::async_trait;

use crate::{
    connection::ConnectionProfile,
    error::Result,
    query::{CellUpdate, QueryRequest, QueryResult, RowDelete, RowInsert},
    schema::Schema,
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

    /// Close any pools associated with the profile.
    async fn disconnect(&self, profile: &ConnectionProfile) -> Result<()>;
}

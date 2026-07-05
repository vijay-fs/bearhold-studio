use dbstudio_core::{
    secrets::{self, Slot},
    server_info::ServerInfo,
    ssh_tunnel, BatchResult, CellUpdate, ConnectionProfile, DatabaseEngine, DbError, LintResult,
    QueryRequest, QueryResult, RowDelete, RowInsert, Schema,
};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::state::AppState;

/// Wire-format error returned to the frontend. The `code` field is stable and
/// keyed off by the UI; `message` is a human-readable fallback.
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl From<DbError> for CommandError {
    fn from(e: DbError) -> Self {
        Self {
            code: e.code(),
            message: e.to_string(),
        }
    }
}

pub type CommandResult<T> = Result<T, CommandError>;

#[tauri::command]
pub fn list_engines() -> Vec<DatabaseEngine> {
    vec![
        DatabaseEngine::Postgres,
        DatabaseEngine::MySql,
        DatabaseEngine::Sqlite,
        DatabaseEngine::MongoDb,
        DatabaseEngine::Redis,
    ]
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> CommandResult<()> {
    // Mongo and Redis live outside the SQL Driver trait — dispatch to
    // their own ping methods so a "Test connection" on those profiles
    // actually reaches the right backend.
    if matches!(profile.engine, DatabaseEngine::MongoDb) {
        state.mongo.ping(&profile).await?;
        return Ok(());
    }
    if matches!(profile.engine, DatabaseEngine::Redis) {
        state.redis.ping(&profile).await?;
        return Ok(());
    }
    let driver = state
        .driver_for(profile.engine)
        .ok_or_else(|| DbError::Unsupported(format!("engine {:?}", profile.engine)))?;
    driver.ping(&profile).await?;
    Ok(())
}

#[tauri::command]
pub async fn get_schema(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> CommandResult<Schema> {
    let driver = state
        .driver_for(profile.engine)
        .ok_or_else(|| DbError::Unsupported(format!("engine {:?}", profile.engine)))?;
    let schema = driver.schema(&profile).await?;
    Ok(schema)
}

/// Fetch server version + capability flags. Frontend caches on the
/// connection profile so the diff and data-diff generators can emit
/// version-appropriate SQL. Returns `Unsupported` for NoSQL engines —
/// callers should tolerate that and fall back to the safe-minimum
/// capability set.
#[tauri::command]
pub async fn get_server_info(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> CommandResult<ServerInfo> {
    let driver = state
        .driver_for(profile.engine)
        .ok_or_else(|| DbError::Unsupported(format!("engine {:?}", profile.engine)))?;
    let info = driver.server_info(&profile).await?;
    Ok(info)
}

/// Dry-run a batch of SQL statements without applying them. Used by
/// the diff and data-diff pages to surface an error badge next to a
/// generated statement BEFORE the user clicks Apply. See
/// `Driver::dry_run` for per-engine strategy notes.
#[tauri::command]
pub async fn dry_run_statements(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    statements: Vec<String>,
) -> CommandResult<Vec<LintResult>> {
    let driver = state
        .driver_for(profile.engine)
        .ok_or_else(|| DbError::Unsupported(format!("engine {:?}", profile.engine)))?;
    let results = driver.dry_run(&profile, statements).await?;
    Ok(results)
}

/// Apply a batch of SQL statements atomically. On PG/SQLite the
/// whole batch is one transaction — any failure rolls back and
/// nothing lands. On MySQL a pure-DML batch is also atomic; a batch
/// containing DDL runs one-by-one with stop-on-error, and the
/// returned result honestly reports which prior statements had
/// already committed.
#[tauri::command]
pub async fn apply_batch(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    statements: Vec<String>,
) -> CommandResult<BatchResult> {
    let driver = state
        .driver_for(profile.engine)
        .ok_or_else(|| DbError::Unsupported(format!("engine {:?}", profile.engine)))?;
    let result = driver.apply_batch(&profile, statements).await?;
    Ok(result)
}

#[tauri::command]
pub async fn run_query(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    request: QueryRequest,
) -> CommandResult<QueryResult> {
    let driver = state
        .driver_for(profile.engine)
        .ok_or_else(|| DbError::Unsupported(format!("engine {:?}", profile.engine)))?;
    let result = driver.execute(&profile, request).await?;
    Ok(result)
}

#[tauri::command]
pub async fn update_cell(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    update: CellUpdate,
) -> CommandResult<u64> {
    let driver = state
        .driver_for(profile.engine)
        .ok_or_else(|| DbError::Unsupported(format!("engine {:?}", profile.engine)))?;
    let affected = driver.update_cell(&profile, update).await?;
    Ok(affected)
}

#[tauri::command]
pub async fn insert_row(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    request: RowInsert,
) -> CommandResult<u64> {
    let driver = state
        .driver_for(profile.engine)
        .ok_or_else(|| DbError::Unsupported(format!("engine {:?}", profile.engine)))?;
    let affected = driver.insert_row(&profile, request).await?;
    Ok(affected)
}

#[tauri::command]
pub async fn delete_row(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    request: RowDelete,
) -> CommandResult<u64> {
    let driver = state
        .driver_for(profile.engine)
        .ok_or_else(|| DbError::Unsupported(format!("engine {:?}", profile.engine)))?;
    let affected = driver.delete_row(&profile, request).await?;
    Ok(affected)
}

/// Drop the cached pool (and SSH tunnel, if any) for a profile. The next
/// query will reopen everything from scratch. Used by the UI's "Reconnect"
/// button when a stale connection produces an EOF or the user wants a
/// clean slate after a network change.
#[tauri::command]
pub async fn reconnect(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> CommandResult<()> {
    let driver = state
        .driver_for(profile.engine)
        .ok_or_else(|| DbError::Unsupported(format!("engine {:?}", profile.engine)))?;
    driver.disconnect(&profile).await?;
    Ok(())
}

/// Cancel an in-flight query identified by the caller's `query_id`. The
/// frontend generates a fresh UUID per Run and passes it on the
/// `QueryRequest`; clicking Stop fires this command with the same id, and
/// the driver opens a side channel to signal the original backend. No-op
/// when the id is unknown (the query may have already finished).
#[tauri::command]
pub async fn cancel_query(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    query_id: Uuid,
) -> CommandResult<()> {
    let driver = state
        .driver_for(profile.engine)
        .ok_or_else(|| DbError::Unsupported(format!("engine {:?}", profile.engine)))?;
    driver.cancel_query(&profile, query_id).await?;
    Ok(())
}

// ---- secrets ---------------------------------------------------------------
// Secrets only cross the wire on save (set) or during dev (`get_secret`).
// Drivers themselves read directly from `core::secrets` server-side, so the
// password never makes a round trip to the frontend after initial save.

#[tauri::command]
pub async fn set_secret(profile_id: Uuid, slot: Slot, value: String) -> CommandResult<()> {
    secrets::set(profile_id, slot, value).await?;
    Ok(())
}

#[tauri::command]
pub async fn has_secret(profile_id: Uuid, slot: Slot) -> CommandResult<bool> {
    Ok(secrets::has(profile_id, slot).await?)
}

#[tauri::command]
pub async fn delete_secret(profile_id: Uuid, slot: Slot) -> CommandResult<()> {
    secrets::delete(profile_id, slot).await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_secrets(profile_id: Uuid) -> CommandResult<()> {
    secrets::delete_all(profile_id).await?;
    Ok(())
}

// ---- ssh host-key discovery ------------------------------------------------
// One-shot handshake against the bastion. Returns the SHA256 fingerprint
// presented by the server (OpenSSH format: `SHA256:<base64-no-pad>`) so the
// UI can show it for the user to verify before pinning it on the profile.

#[tauri::command]
pub async fn discover_host_key(host: String, port: u16) -> CommandResult<String> {
    let fp = ssh_tunnel::discover_fingerprint(&host, port).await?;
    Ok(fp)
}

// ---- mongo commands --------------------------------------------------------
// MongoDB lives outside the SQL Driver trait — it's a document store, so
// the per-collection / per-document operations get their own command
// surface that the frontend's mongo workspace dispatches against directly.

use dbstudio_driver_mongodb::{FindRequest, FindResponse};

/// Ping a Mongo deployment. Used by Test Connection on Mongo profiles.
#[tauri::command]
pub async fn mongo_ping(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> CommandResult<()> {
    state.mongo.ping(&profile).await?;
    Ok(())
}

#[tauri::command]
pub async fn mongo_list_databases(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> CommandResult<Vec<String>> {
    Ok(state.mongo.list_databases(&profile).await?)
}

#[tauri::command]
pub async fn mongo_list_collections(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    database: String,
) -> CommandResult<Vec<String>> {
    Ok(state.mongo.list_collections(&profile, &database).await?)
}

#[tauri::command]
pub async fn mongo_find(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    request: FindRequest,
) -> CommandResult<FindResponse> {
    Ok(state.mongo.find(&profile, request).await?)
}

#[tauri::command]
pub async fn mongo_insert_one(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    database: String,
    collection: String,
    document: serde_json::Value,
) -> CommandResult<serde_json::Value> {
    Ok(state
        .mongo
        .insert_one(&profile, &database, &collection, document)
        .await?)
}

#[tauri::command]
pub async fn mongo_replace_one(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    database: String,
    collection: String,
    document: serde_json::Value,
) -> CommandResult<u64> {
    Ok(state
        .mongo
        .replace_one(&profile, &database, &collection, document)
        .await?)
}

#[tauri::command]
pub async fn mongo_delete_one(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    database: String,
    collection: String,
    id: serde_json::Value,
) -> CommandResult<u64> {
    Ok(state
        .mongo
        .delete_one(&profile, &database, &collection, id)
        .await?)
}

#[tauri::command]
pub async fn mongo_disconnect(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> CommandResult<()> {
    state.mongo.disconnect(&profile).await?;
    Ok(())
}

// ---- redis commands --------------------------------------------------------
// Redis is a key/value store — also outside the SQL Driver trait —
// exposing its own typed surface for the keyspace browser.

use dbstudio_driver_redis::{RedisKeyDetails, ScanRequest, ScanResponse};

#[tauri::command]
pub async fn redis_ping(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> CommandResult<()> {
    state.redis.ping(&profile).await?;
    Ok(())
}

#[tauri::command]
pub async fn redis_scan(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    request: ScanRequest,
) -> CommandResult<ScanResponse> {
    Ok(state.redis.scan(&profile, request).await?)
}

#[tauri::command]
pub async fn redis_key_details(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    key: String,
) -> CommandResult<RedisKeyDetails> {
    Ok(state.redis.key_details(&profile, &key).await?)
}

#[tauri::command]
pub async fn redis_delete(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    key: String,
) -> CommandResult<u64> {
    Ok(state.redis.delete(&profile, &key).await?)
}

#[tauri::command]
pub async fn redis_disconnect(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> CommandResult<()> {
    state.redis.disconnect(&profile).await?;
    Ok(())
}

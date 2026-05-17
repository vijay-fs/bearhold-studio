use dbstudio_core::{
    secrets::{self, Slot},
    ssh_tunnel, CellUpdate, ConnectionProfile, DatabaseEngine, DbError, QueryRequest, QueryResult,
    RowDelete, RowInsert, Schema,
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
        DatabaseEngine::CockroachDb,
        DatabaseEngine::MySql,
        DatabaseEngine::MariaDb,
        DatabaseEngine::Sqlite,
        // The rest are reserved for future phases.
    ]
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> CommandResult<()> {
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

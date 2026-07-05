// Export / import orchestration.
//
// `detect` is the file-format sniffer used by the Import page before
// it decides which native CLI (pg_restore, psql, mysql) to spawn.
// `export` runs the outgoing side; import is next.

pub mod detect;
pub mod export;
pub mod import;
pub mod tool_locator;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use self::detect::{probe, DumpProbe};
use self::export::{
    run_export, ExportContext, ExportOptions, ExportProgressSink, ExportRegistry,
};
use self::import::{
    run_import, ImportContext, ImportOptions, ImportProgressSink, ImportRegistry,
};

const EXPORT_PROGRESS_EVENT: &str = "dbstudio://export/progress";
const IMPORT_PROGRESS_EVENT: &str = "dbstudio://import/progress";

/// Sniff a filesystem path and report what kind of dump we think it
/// is. See `detect::DumpFormat` for the recognized shapes. Returns
/// `Unknown` rather than erroring for unrecognized files — the UI
/// still shows the size and lets the user pick a format manually.
#[tauri::command]
pub async fn detect_dump_format(path: String) -> Result<DumpProbe, String> {
    let p = PathBuf::from(path);
    probe(&p).map_err(|e| e.to_string())
}

/// Return the byte-size of `path` on disk, or 0 if it doesn't exist.
/// Used by the Export page as a fallback when the byte-count stream
/// didn't reach the UI (e.g. SQLite `fs::copy` completes in
/// milliseconds with no intermediate progress event).
#[tauri::command]
pub async fn file_size(path: String) -> Result<u64, String> {
    let p = PathBuf::from(path);
    match std::fs::metadata(&p) {
        Ok(md) => Ok(md.len()),
        Err(_) => Ok(0),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ExportEvent {
    Stderr { line: String },
    Bytes { written: u64 },
}

#[derive(Debug, Clone, Serialize)]
struct ExportEventEnvelope {
    job_id: Uuid,
    #[serde(flatten)]
    event: ExportEvent,
}

struct AppExportSink {
    app: AppHandle,
    job_id: Uuid,
}

impl ExportProgressSink for AppExportSink {
    fn on_stderr(&self, line: &str) {
        let _ = self.app.emit(
            EXPORT_PROGRESS_EVENT,
            ExportEventEnvelope {
                job_id: self.job_id,
                event: ExportEvent::Stderr {
                    line: line.to_string(),
                },
            },
        );
    }
    fn on_bytes_written(&self, bytes: u64) {
        let _ = self.app.emit(
            EXPORT_PROGRESS_EVENT,
            ExportEventEnvelope {
                job_id: self.job_id,
                event: ExportEvent::Bytes { written: bytes },
            },
        );
    }
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub job_id: Uuid,
    pub output_path: PathBuf,
}

#[tauri::command]
pub async fn start_export(
    app: AppHandle,
    registry: State<'_, Arc<ExportRegistry>>,
    state: State<'_, crate::state::AppState>,
    options: ExportOptions,
) -> Result<ExportResult, String> {
    let job_id = Uuid::new_v4();
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let ctx = ExportContext {
        app_data_dir: data_dir,
        registry: registry.inner().clone(),
        job_id,
        // Handing the SQLite driver Arc through means the WAL
        // checkpoint runs against the app-wide pool (same one the
        // SQL editor uses), not a fresh one — which matters when the
        // file has an active writer sitting in the sidebar.
        sqlite_driver: state.inner().sqlite.clone(),
    };
    let sink: Arc<dyn ExportProgressSink> = Arc::new(AppExportSink {
        app: app.clone(),
        job_id,
    });
    let output_path = run_export(ctx, options, sink)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ExportResult { job_id, output_path })
}

#[tauri::command]
pub async fn cancel_export(
    registry: State<'_, Arc<ExportRegistry>>,
    job_id: Uuid,
) -> Result<bool, String> {
    Ok(export::cancel(registry.inner(), job_id).await)
}

// ---- Import commands ------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ImportEvent {
    Stderr { line: String },
    Bytes { read: u64 },
}

#[derive(Debug, Clone, Serialize)]
struct ImportEventEnvelope {
    job_id: Uuid,
    #[serde(flatten)]
    event: ImportEvent,
}

struct AppImportSink {
    app: AppHandle,
    job_id: Uuid,
}

impl ImportProgressSink for AppImportSink {
    fn on_stderr(&self, line: &str) {
        let _ = self.app.emit(
            IMPORT_PROGRESS_EVENT,
            ImportEventEnvelope {
                job_id: self.job_id,
                event: ImportEvent::Stderr {
                    line: line.to_string(),
                },
            },
        );
    }
    fn on_bytes_read(&self, bytes: u64) {
        let _ = self.app.emit(
            IMPORT_PROGRESS_EVENT,
            ImportEventEnvelope {
                job_id: self.job_id,
                event: ImportEvent::Bytes { read: bytes },
            },
        );
    }
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub job_id: Uuid,
}

#[tauri::command]
pub async fn start_import(
    app: AppHandle,
    registry: State<'_, Arc<ImportRegistry>>,
    options: ImportOptions,
) -> Result<ImportResult, String> {
    let job_id = Uuid::new_v4();
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let ctx = ImportContext {
        app_data_dir: data_dir,
        registry: registry.inner().clone(),
        job_id,
    };
    let sink: Arc<dyn ImportProgressSink> = Arc::new(AppImportSink {
        app: app.clone(),
        job_id,
    });
    run_import(ctx, options, sink)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ImportResult { job_id })
}

#[tauri::command]
pub async fn cancel_import(
    registry: State<'_, Arc<ImportRegistry>>,
    job_id: Uuid,
) -> Result<bool, String> {
    Ok(import::cancel(registry.inner(), job_id).await)
}

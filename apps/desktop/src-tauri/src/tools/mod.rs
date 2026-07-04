// On-demand tool bundle installer.
//
// The dump/import features need engine-specific CLI tools (pg_dump,
// mysqldump, mongodump, ...) that we don't want to ship with the
// installer for the reasons in the design doc: they're 30-55 MB
// each, add licensing complexity, and get out of sync with server
// versions. Instead the frontend prompts the user with "Download
// PostgreSQL tools (18 MB)" the first time they hit Export, we fetch
// the archive here, verify + extract into the app-support dir, and
// remember the install for next time.

pub mod cache;
pub mod download;
pub mod manifest;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

use self::download::{ProgressSink, ToolProgress};
use self::manifest::Manifest;

const PROGRESS_EVENT: &str = "dbstudio://tool/progress";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolStatus {
    pub bundle_key: String,
    pub display_name: String,
    pub tool_version: String,
    pub installed: bool,
    pub install_dir: Option<PathBuf>,
    pub tools: Vec<InstalledTool>,
    pub covers_engines: Vec<String>,
    pub download_size_bytes: Option<u64>,
    pub download_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledTool {
    pub name: String,
    pub path: Option<PathBuf>,
}

fn resolve_app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))
}

pub fn list_bundles(app_data_dir: &PathBuf) -> Result<Vec<ToolStatus>, String> {
    let manifest = Manifest::load().map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(manifest.bundles.len());
    for (key, bundle) in &manifest.bundles {
        let asset = bundle.asset_for_current_platform();
        let install_dir_path =
            cache::bundle_dir(app_data_dir, key, &bundle.tool_version);
        let installed = cache::is_bundle_installed(app_data_dir, key, &bundle.tool_version);
        let tools = bundle
            .tools
            .iter()
            .map(|t| InstalledTool {
                name: t.clone(),
                path: if installed {
                    cache::tool_executable(app_data_dir, bundle, key, t)
                } else {
                    None
                },
            })
            .collect();
        out.push(ToolStatus {
            bundle_key: key.clone(),
            display_name: bundle.display_name.clone(),
            tool_version: bundle.tool_version.clone(),
            installed,
            install_dir: if installed {
                Some(install_dir_path)
            } else {
                None
            },
            tools,
            covers_engines: bundle.covers_engines.clone(),
            download_size_bytes: asset.map(|a| a.size_bytes),
            download_url: asset.map(|a| a.url.clone()),
        });
    }
    out.sort_by(|a, b| a.bundle_key.cmp(&b.bundle_key));
    Ok(out)
}

// ---- Tauri commands --------------------------------------------------

#[tauri::command]
pub async fn list_tool_bundles(app: AppHandle) -> Result<Vec<ToolStatus>, String> {
    let data_dir = resolve_app_data_dir(&app)?;
    list_bundles(&data_dir)
}

#[tauri::command]
pub async fn install_tool_bundle(
    app: AppHandle,
    bundle_key: String,
) -> Result<ToolStatus, String> {
    let manifest = Manifest::load().map_err(|e| e.to_string())?;
    let bundle = manifest
        .bundle(&bundle_key)
        .ok_or_else(|| format!("unknown bundle: {bundle_key}"))?
        .clone();
    let data_dir = resolve_app_data_dir(&app)?;
    let sink = EventSink::new(app.clone());
    download::install_bundle(&data_dir, &bundle_key, &bundle, &sink)
        .await
        .map_err(|e| e.to_string())?;
    // Re-read status so the frontend sees the newly-installed marker.
    let statuses = list_bundles(&data_dir)?;
    statuses
        .into_iter()
        .find(|s| s.bundle_key == bundle_key)
        .ok_or_else(|| "post-install lookup failed".to_string())
}

#[tauri::command]
pub async fn uninstall_tool_bundle(
    app: AppHandle,
    bundle_key: String,
) -> Result<(), String> {
    let manifest = Manifest::load().map_err(|e| e.to_string())?;
    let bundle = manifest
        .bundle(&bundle_key)
        .ok_or_else(|| format!("unknown bundle: {bundle_key}"))?;
    let data_dir = resolve_app_data_dir(&app)?;
    let dir = cache::bundle_dir(&data_dir, &bundle_key, &bundle.tool_version);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    // Also clean any leftover staging dir from a crashed install.
    let staging = cache::tools_root(&data_dir).join(format!(".staging-{bundle_key}"));
    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    Ok(())
}

/// Bridge from the pure-async downloader to Tauri's event bus. Kept
/// as its own type so the downloader can be unit-tested with a mock
/// sink that doesn't need a live AppHandle.
struct EventSink {
    app: AppHandle,
}

impl EventSink {
    fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl ProgressSink for EventSink {
    fn emit(&self, progress: ToolProgress) {
        let _ = self.app.emit(PROGRESS_EVENT, progress);
    }
}

// AppState is unused in this module today but kept in the import list
// so the Tauri handlers can grow into it (e.g. cache-aware
// concurrency limiting) without a churny import edit.
#[allow(dead_code)]
fn _appstate_marker(_: &AppState) {}

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

use std::path::{Path, PathBuf};

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
    /// True when every tool in this bundle ships inside the installer
    /// (Tauri resources). When set, export/import work with no local
    /// setup and no download, so the frontend shows "Ready".
    pub bundled: bool,
    /// True when a downloaded bundle exists in the app-data cache.
    pub installed: bool,
    /// True when EVERY tool in `tools` was found on the system PATH.
    /// This is checked independently of the bundle install — a user
    /// who has Homebrew's libpq linked doesn't need our download at
    /// all, and the frontend should treat this as "ready".
    pub system_available: bool,
    /// Convenience flag: bundle installed OR PATH satisfies the whole
    /// tool list. Frontend uses this instead of `installed` when
    /// deciding whether to show the download prompt.
    pub ready: bool,
    pub install_dir: Option<PathBuf>,
    pub tools: Vec<InstalledTool>,
    pub covers_engines: Vec<String>,
    pub download_size_bytes: Option<u64>,
    pub download_url: Option<String>,
    /// URL host we'd fetch from — surfaced in the UI as
    /// "Download from tools.bearhold.studio". `None` when no asset
    /// exists for the current platform.
    pub download_host: Option<String>,
    /// Whether the manifest still points at a placeholder URL. When
    /// true the frontend hides the "Download" button entirely and
    /// only shows the install-hint copy.
    pub download_available: bool,
    /// OS-specific one-liner the user can paste to install this
    /// bundle themselves. Formatted for their current platform.
    pub install_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledTool {
    pub name: String,
    /// Path to the installer-bundled executable (Tauri resources), if
    /// it shipped with the app. Preferred over everything else.
    pub bundled_path: Option<PathBuf>,
    /// Path to the installed-from-bundle executable, if we downloaded
    /// it into the app-data cache.
    pub path: Option<PathBuf>,
    /// Path to a PATH-resolved executable on the system. Populated
    /// independently of `path` — the frontend prefers this when
    /// present, because it's what the user has been using in other
    /// tools too.
    pub system_path: Option<PathBuf>,
}

fn resolve_app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))
}

pub fn list_bundles(
    resource_dir: Option<&Path>,
    app_data_dir: &Path,
) -> Result<Vec<ToolStatus>, String> {
    let manifest = Manifest::load().map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(manifest.bundles.len());
    for (key, bundle) in &manifest.bundles {
        let asset = bundle.asset_for_current_platform();
        let install_dir_path = cache::bundle_dir(app_data_dir, key, &bundle.tool_version);
        let installed = cache::is_bundle_installed(app_data_dir, key, &bundle.tool_version);

        // Probe every tool independently:
        //   - `bundled_path` = installer-shipped location, if any
        //   - `path` = downloaded-into-cache location, if any
        //   - `system_path` = PATH-resolved location, if any
        // A bundle is `bundled`/`system_available` when EVERY tool has
        // that respective source. Either one gates the "no download
        // needed" UX.
        let tools: Vec<InstalledTool> = bundle
            .tools
            .iter()
            .map(|t| InstalledTool {
                name: t.clone(),
                bundled_path: cache::bundled_tool_executable(resource_dir, key, t),
                path: if installed {
                    cache::tool_executable(app_data_dir, bundle, key, t)
                } else {
                    None
                },
                system_path: which_on_path(t),
            })
            .collect();

        let bundled = !tools.is_empty() && tools.iter().all(|t| t.bundled_path.is_some());
        let system_available = !tools.is_empty() && tools.iter().all(|t| t.system_path.is_some());
        let download_url = asset.map(|a| a.url.clone());
        let download_available = download_url
            .as_deref()
            .map(|u| !u.contains("TODO_") && !u.contains("bearhold.studio"))
            .unwrap_or(false);
        // Even when the download URL is a placeholder we still surface
        // the host so the UI can render "hosted at X" copy uniformly.
        let download_host = download_url
            .as_deref()
            .and_then(|u| url::Url::parse(u).ok())
            .and_then(|u| u.host_str().map(|s| s.to_string()));

        out.push(ToolStatus {
            bundle_key: key.clone(),
            display_name: bundle.display_name.clone(),
            tool_version: bundle.tool_version.clone(),
            bundled,
            installed,
            system_available,
            ready: bundled || installed || system_available,
            install_dir: if installed {
                Some(install_dir_path)
            } else {
                None
            },
            tools,
            covers_engines: bundle.covers_engines.clone(),
            download_size_bytes: asset.map(|a| a.size_bytes),
            download_url,
            download_host,
            download_available,
            install_hint: install_hint_for(key),
        });
    }
    out.sort_by(|a, b| a.bundle_key.cmp(&b.bundle_key));
    Ok(out)
}

/// PATH lookup for a single tool name. Same behaviour as the private
/// helper in `dump::tool_locator` — kept as a local copy here so
/// `list_bundles` doesn't cross-module-depend on the dump feature.
fn which_on_path(name: &str) -> Option<PathBuf> {
    let variants = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for v in &variants {
            let candidate = dir.join(v);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// One-line install hint per bundle, tailored to the host OS. Used
/// when the hosted download isn't available (placeholder URL / no
/// asset for platform) so the user has a copy-pasteable path
/// forward instead of a raw network error.
fn install_hint_for(bundle_key: &str) -> Option<String> {
    let hint = match (bundle_key, std::env::consts::OS) {
        ("postgres", "macos") => "brew install libpq && brew link --force libpq",
        ("postgres", "linux") => "sudo apt-get install postgresql-client",
        ("postgres", "windows") => {
            "Install PostgreSQL from https://www.postgresql.org/download/windows/"
        }
        ("mysql", "macos") => "brew install mysql-client && brew link --force mysql-client",
        ("mysql", "linux") => "sudo apt-get install mysql-client",
        ("mysql", "windows") => {
            "Install MySQL from https://dev.mysql.com/downloads/installer/"
        }
        ("sqlite", "macos") => "brew install sqlite",
        ("sqlite", "linux") => "sudo apt-get install sqlite3",
        ("sqlite", "windows") => "Install SQLite from https://sqlite.org/download.html",
        ("mongodb", "macos") => "brew install mongodb-database-tools",
        ("mongodb", "linux") => {
            "Follow https://www.mongodb.com/docs/database-tools/installation/"
        }
        ("mongodb", "windows") => {
            "Install MongoDB Database Tools from https://www.mongodb.com/try/download/database-tools"
        }
        ("redis", "macos") => "brew install redis",
        ("redis", "linux") => "sudo apt-get install redis-tools",
        ("redis", "windows") => "Install Redis (or the Valkey CLI) from your package manager",
        _ => return None,
    };
    Some(hint.to_string())
}

// ---- Tauri commands --------------------------------------------------

#[tauri::command]
pub async fn list_tool_bundles(app: AppHandle) -> Result<Vec<ToolStatus>, String> {
    let data_dir = resolve_app_data_dir(&app)?;
    let resource_dir = app.path().resource_dir().ok();
    list_bundles(resource_dir.as_deref(), &data_dir)
}

#[tauri::command]
pub async fn install_tool_bundle(app: AppHandle, bundle_key: String) -> Result<ToolStatus, String> {
    let manifest = Manifest::load().map_err(|e| e.to_string())?;
    let bundle = manifest
        .bundle(&bundle_key)
        .ok_or_else(|| format!("unknown bundle: {bundle_key}"))?
        .clone();
    // Guard: refuse to hit a placeholder URL. The manifest ships
    // with `TODO_...` sentinels and the `tools.bearhold.studio`
    // hostname while the real CDN isn't wired up yet. Better to
    // return a clean error the frontend can turn into "install with
    // your OS package manager" copy than to fire a DNS request that
    // fails after a 30-second timeout.
    let asset = bundle
        .asset_for_current_platform()
        .ok_or_else(|| format!("no download asset for this platform ({})", bundle_key))?;
    let url_is_placeholder =
        asset.sha256.starts_with("TODO_") || asset.url.contains("tools.bearhold.studio");
    if url_is_placeholder {
        return Err(format!(
            "hosted download for {bundle_key} isn't available yet — install with your OS package manager instead. See the panel for a one-liner.",
        ));
    }
    let data_dir = resolve_app_data_dir(&app)?;
    let sink = EventSink::new(app.clone());
    download::install_bundle(&data_dir, &bundle_key, &bundle, &sink)
        .await
        .map_err(|e| e.to_string())?;
    // Re-read status so the frontend sees the newly-installed marker.
    let resource_dir = app.path().resource_dir().ok();
    let statuses = list_bundles(resource_dir.as_deref(), &data_dir)?;
    statuses
        .into_iter()
        .find(|s| s.bundle_key == bundle_key)
        .ok_or_else(|| "post-install lookup failed".to_string())
}

/// Return the bundled Open Source Notices (license text + any GPL
/// written offer) so an About / "Open Source Licenses" screen can
/// display them. Generated at build time by
/// `scripts/fetch-desktop-tools.mjs` into `tools/THIRD_PARTY_NOTICES.md`
/// and shipped via `bundle.resources`. Returns `None` when no tools
/// were bundled (e.g. a dev build), so the UI can hide the entry.
#[tauri::command]
pub async fn third_party_notices(app: AppHandle) -> Result<Option<String>, String> {
    let Some(resource_dir) = app.path().resource_dir().ok() else {
        return Ok(None);
    };
    let path = resource_dir.join("tools").join("THIRD_PARTY_NOTICES.md");
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read notices: {e}")),
    }
}

#[tauri::command]
pub async fn uninstall_tool_bundle(app: AppHandle, bundle_key: String) -> Result<(), String> {
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

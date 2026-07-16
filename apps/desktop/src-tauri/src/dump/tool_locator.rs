// Where do we find pg_dump / mysqldump / mongodump on this machine?
//
// Lookup order:
//   1. If the tool ships *inside the installer* (Tauri resources under
//      `<resource_dir>/tools/<bundle>/bin/<tool>`) — use that. This is
//      the default path: the binaries are bundled with the app so
//      export/import work with zero local setup and zero network.
//   2. If a bundle was downloaded on demand into the app-data cache
//      (`tools/<bundle>/<version>/bin/<tool>`) — use that. Fallback for
//      platforms/tools not shipped in the installer.
//   3. Fall back to the system PATH. Users who already have Postgres
//      installed (Postgres.app on macOS, `apt install
//      postgresql-client`) can still use their own copy.
//   4. Return `NotFound` — the UI shows the install prompt.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::tools::cache;
use crate::tools::manifest::Manifest;

#[derive(Debug, Clone, Serialize)]
pub struct ToolLocation {
    pub tool_name: String,
    pub path: PathBuf,
    /// Where we found it — useful for the UI to explain "using your
    /// system pg_dump" vs. "using the bundle we installed".
    pub source: ToolSource,
    pub version_hint: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSource {
    /// Shipped inside the installer (Tauri resources). The default.
    Bundled,
    /// From a bundle downloaded on demand into the app data dir.
    Bundle,
    /// From the system PATH.
    System,
}

#[derive(Debug, thiserror::Error)]
pub enum LocateError {
    #[error("required tool {0} not found — install the corresponding bundle or add it to PATH")]
    NotFound(String),
    #[error("unknown bundle key: {0}")]
    UnknownBundle(String),
    #[error("manifest parse error: {0}")]
    ManifestParse(String),
}

/// Find a tool binary. `bundle_key` scopes the search to the correct
/// bundle when hitting the installed cache; the same tool name never
/// appears in more than one bundle in the manifest, so this is safe.
///
/// `resource_dir` is the app's Tauri resource directory, where the
/// installer-shipped tools live. Pass `None` when it can't be resolved
/// (the lookup then skips straight to the download cache / PATH).
pub fn locate(
    resource_dir: Option<&Path>,
    app_data_dir: &Path,
    bundle_key: &str,
    tool_name: &str,
) -> Result<ToolLocation, LocateError> {
    let manifest = Manifest::load().map_err(|e| LocateError::ManifestParse(e.to_string()))?;
    let bundle = manifest
        .bundle(bundle_key)
        .ok_or_else(|| LocateError::UnknownBundle(bundle_key.to_string()))?;

    if let Some(path) = cache::bundled_tool_executable(resource_dir, bundle_key, tool_name) {
        return Ok(ToolLocation {
            tool_name: tool_name.into(),
            path,
            source: ToolSource::Bundled,
            version_hint: Some(bundle.tool_version.clone()),
        });
    }

    if let Some(path) = cache::tool_executable(app_data_dir, bundle, bundle_key, tool_name) {
        return Ok(ToolLocation {
            tool_name: tool_name.into(),
            path,
            source: ToolSource::Bundle,
            version_hint: Some(bundle.tool_version.clone()),
        });
    }

    if let Some(path) = which_on_path(tool_name) {
        return Ok(ToolLocation {
            tool_name: tool_name.into(),
            path,
            source: ToolSource::System,
            version_hint: None,
        });
    }

    Err(LocateError::NotFound(tool_name.into()))
}

/// Cross-platform PATH lookup. We don't pull in the `which` crate
/// just for this — the semantics are simple enough to spell out.
fn which_on_path(name: &str) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) {
        // On Windows, also try `.exe` and `.cmd` since some tools
        // ship as batch wrappers around the real binary.
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
        for variant in &exe_name {
            let candidate = dir.join(variant);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

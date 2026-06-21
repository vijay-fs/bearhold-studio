// On-disk cache layout for downloaded tool bundles.
//
// Layout under the app data dir:
//   tools/
//     postgres/
//       16.4/
//         bin/pg_dump
//         bin/pg_restore
//         bin/psql
//         .installed         <- empty marker file, written last
//     mysql/
//       8.0.39/
//         ...
//
// The `.installed` marker is the single source of truth for "this
// bundle is ready to use" — we write it only AFTER extraction and
// SHA-256 verification succeed, so a partial extraction never looks
// installed. Versioning the directory by `tool_version` lets us ship
// updates without breaking older installs (they coexist; cleanup is
// a separate command).

use std::path::{Path, PathBuf};

use super::manifest::Bundle;

const INSTALLED_MARKER: &str = ".installed";

pub fn tools_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("tools")
}

pub fn bundle_dir(app_data_dir: &Path, bundle_key: &str, version: &str) -> PathBuf {
    tools_root(app_data_dir).join(bundle_key).join(version)
}

pub fn installed_marker(app_data_dir: &Path, bundle_key: &str, version: &str) -> PathBuf {
    bundle_dir(app_data_dir, bundle_key, version).join(INSTALLED_MARKER)
}

pub fn is_bundle_installed(app_data_dir: &Path, bundle_key: &str, version: &str) -> bool {
    installed_marker(app_data_dir, bundle_key, version).exists()
}

/// Find the executable for a tool name inside an installed bundle.
/// Searches the standard `bin/` subdirectory first, then the bundle
/// root, since some upstream archives drop binaries at the root and
/// others nest them under `bin/`. Adds `.exe` on Windows.
pub fn tool_executable(
    app_data_dir: &Path,
    bundle: &Bundle,
    bundle_key: &str,
    tool_name: &str,
) -> Option<PathBuf> {
    let dir = bundle_dir(app_data_dir, bundle_key, &bundle.tool_version);
    let exe_name = if cfg!(target_os = "windows") {
        format!("{tool_name}.exe")
    } else {
        tool_name.to_string()
    };
    let candidates = [dir.join("bin").join(&exe_name), dir.join(&exe_name)];
    candidates.into_iter().find(|p| p.is_file())
}

pub fn write_installed_marker(
    app_data_dir: &Path,
    bundle_key: &str,
    version: &str,
) -> std::io::Result<()> {
    let path = installed_marker(app_data_dir, bundle_key, version);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, b"")
}

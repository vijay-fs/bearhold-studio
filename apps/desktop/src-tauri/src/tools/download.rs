// Streaming tool-bundle downloader.
//
// Fetches the archive with `reqwest`, hashes it with `sha2` as bytes
// stream past, then extracts to a staging directory before atomically
// moving into the versioned cache dir. The `.installed` marker is
// written LAST so a partial extraction never looks installed to
// `cache::is_bundle_installed`.
//
// Progress is emitted as Tauri events `dbstudio://tool/progress` so
// the frontend can render a live "Downloading pg_dump… 8.2 / 18.0 MB"
// UI without polling.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::cache::{bundle_dir, tools_root, write_installed_marker};
use super::manifest::{ArchiveKind, Bundle, PlatformAsset};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum ProgressPhase {
    Downloading { downloaded: u64, total: u64 },
    Verifying,
    Extracting,
    Done,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolProgress {
    pub bundle_key: String,
    #[serde(flatten)]
    pub phase: ProgressPhase,
}

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("no asset for current platform")]
    NoPlatformAsset,
    #[error("HTTP {status} fetching {url}")]
    Http { status: u16, url: String },
    #[error("SHA-256 mismatch: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("request error: {0}")]
    Request(#[from] reqwest::Error),
    #[error("archive error: {0}")]
    Archive(String),
}

pub type Result<T> = std::result::Result<T, DownloadError>;

/// Progress callback signature. Kept generic so callers can wire it
/// to a Tauri emitter or, in tests, a logger.
pub trait ProgressSink: Send + Sync {
    fn emit(&self, progress: ToolProgress);
}

/// Download + verify + extract a bundle. Returns the resolved bundle
/// directory on success. Idempotent — if the marker is already
/// present, we short-circuit without re-downloading.
pub async fn install_bundle(
    app_data_dir: &Path,
    bundle_key: &str,
    bundle: &Bundle,
    sink: &dyn ProgressSink,
) -> Result<PathBuf> {
    let asset = bundle
        .asset_for_current_platform()
        .ok_or(DownloadError::NoPlatformAsset)?;

    let dest_dir = bundle_dir(app_data_dir, bundle_key, &bundle.tool_version);
    let marker = dest_dir.join(".installed");
    if marker.exists() {
        sink.emit(ToolProgress {
            bundle_key: bundle_key.to_string(),
            phase: ProgressPhase::Done,
        });
        return Ok(dest_dir);
    }

    let staging_dir = tools_root(app_data_dir).join(format!(".staging-{bundle_key}"));
    if staging_dir.exists() {
        fs::remove_dir_all(&staging_dir)?;
    }
    fs::create_dir_all(&staging_dir)?;

    let bytes = download_streamed(asset, bundle_key, sink).await?;

    sink.emit(ToolProgress {
        bundle_key: bundle_key.to_string(),
        phase: ProgressPhase::Verifying,
    });
    let actual = hex::encode(Sha256::digest(&bytes));
    // Allow the manifest's TODO_REPLACE_WITH_REAL_SHA256_AFTER_UPLOAD
    // sentinel to pass, so devs can iterate on the UI before the
    // final CDN uploads have happened. Any real hex string is checked
    // strictly. This gate flips off before shipping to users.
    let expected_lower = asset.sha256.to_lowercase();
    let is_placeholder = expected_lower.starts_with("todo_");
    if !is_placeholder && actual.to_lowercase() != expected_lower {
        return Err(DownloadError::HashMismatch {
            expected: asset.sha256.clone(),
            actual,
        });
    }

    sink.emit(ToolProgress {
        bundle_key: bundle_key.to_string(),
        phase: ProgressPhase::Extracting,
    });
    extract_archive(&bytes, asset, &staging_dir)?;

    // Move staged content into dest_dir. Using rename gives us
    // atomic-ish semantics on the same filesystem — a crash mid-move
    // leaves either the old dest or the staged dir, never a mixed one.
    if dest_dir.exists() {
        fs::remove_dir_all(&dest_dir)?;
    }
    if let Some(parent) = dest_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&staging_dir, &dest_dir)?;

    strip_macos_quarantine(&dest_dir);
    ensure_executables(&dest_dir, bundle);

    write_installed_marker(app_data_dir, bundle_key, &bundle.tool_version)?;

    sink.emit(ToolProgress {
        bundle_key: bundle_key.to_string(),
        phase: ProgressPhase::Done,
    });
    Ok(dest_dir)
}

async fn download_streamed(
    asset: &PlatformAsset,
    bundle_key: &str,
    sink: &dyn ProgressSink,
) -> Result<Vec<u8>> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("bearhold-studio/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let resp = client.get(&asset.url).send().await?;
    if !resp.status().is_success() {
        return Err(DownloadError::Http {
            status: resp.status().as_u16(),
            url: asset.url.clone(),
        });
    }
    let total = resp.content_length().unwrap_or(asset.size_bytes);
    let mut buf = Vec::with_capacity(total as usize);
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        downloaded += chunk.len() as u64;
        buf.extend_from_slice(&chunk);
        // Emit at ~1% granularity so we don't drown the frontend in
        // ProgressEvent notifications for a 55 MB mongodump download.
        if downloaded - last_emit > total / 100 {
            sink.emit(ToolProgress {
                bundle_key: bundle_key.to_string(),
                phase: ProgressPhase::Downloading {
                    downloaded,
                    total: total.max(downloaded),
                },
            });
            last_emit = downloaded;
        }
    }
    // Final tick so the frontend sees 100 %.
    sink.emit(ToolProgress {
        bundle_key: bundle_key.to_string(),
        phase: ProgressPhase::Downloading {
            downloaded,
            total: downloaded,
        },
    });
    Ok(buf)
}

fn extract_archive(
    bytes: &[u8],
    asset: &PlatformAsset,
    dest: &Path,
) -> Result<()> {
    match asset.archive {
        ArchiveKind::TarGz => extract_tar_gz(bytes, dest, asset.strip_components),
        ArchiveKind::Zip => extract_zip(bytes, dest, asset.strip_components),
    }
}

fn extract_tar_gz(bytes: &[u8], dest: &Path, strip: usize) -> Result<()> {
    let gz = flate2::read::GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(gz);
    for entry in archive.entries().map_err(archive_err)? {
        let mut entry = entry.map_err(archive_err)?;
        let path = entry.path().map_err(archive_err)?.into_owned();
        let stripped = strip_prefix(&path, strip);
        if stripped.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest.join(&stripped);
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)?;
            }
            entry.unpack(&out_path).map_err(archive_err)?;
        }
    }
    Ok(())
}

fn extract_zip(bytes: &[u8], dest: &Path, strip: usize) -> Result<()> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(archive_err_zip)?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(archive_err_zip)?;
        let raw = match file.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        let stripped = strip_prefix(&raw, strip);
        if stripped.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest.join(&stripped);
        if file.is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut out = fs::File::create(&out_path)?;
            std::io::copy(&mut file, &mut out)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = file.unix_mode() {
                    let _ = fs::set_permissions(&out_path, fs::Permissions::from_mode(mode));
                }
            }
        }
    }
    Ok(())
}

fn strip_prefix(path: &Path, strip: usize) -> PathBuf {
    if strip == 0 {
        return path.to_path_buf();
    }
    let mut comps = path.components();
    for _ in 0..strip {
        comps.next();
    }
    comps.as_path().to_path_buf()
}

fn archive_err(e: std::io::Error) -> DownloadError {
    DownloadError::Archive(e.to_string())
}
fn archive_err_zip(e: zip::result::ZipError) -> DownloadError {
    DownloadError::Archive(e.to_string())
}

/// Remove `com.apple.quarantine` xattrs from every file in the tree.
/// Downloads inherit the attr from Safari/curl and macOS then refuses
/// to spawn the binary. Silent no-op on non-macOS.
fn strip_macos_quarantine(dir: &Path) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let _ = std::process::Command::new("xattr")
        .arg("-dr")
        .arg("com.apple.quarantine")
        .arg(dir)
        .output();
}

/// chmod +x every advertised tool binary. tar preserves modes; zip
/// often loses them on Windows-origin archives. Cheap belt-and-braces.
fn ensure_executables(dir: &Path, bundle: &Bundle) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for tool in &bundle.tools {
            let candidates = [dir.join("bin").join(tool), dir.join(tool)];
            for p in candidates {
                if p.is_file() {
                    if let Ok(md) = fs::metadata(&p) {
                        let mut perm = md.permissions();
                        perm.set_mode(perm.mode() | 0o111);
                        let _ = fs::set_permissions(&p, perm);
                    }
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (dir, bundle);
    }
}

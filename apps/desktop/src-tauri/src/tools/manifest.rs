// Tool-bundle manifest: which CLI tools we know how to install on demand,
// where to fetch them from, and how to verify them.
//
// The manifest itself ships embedded inside the binary (`manifest.json`
// next to this file). Bumping a tool version is a recompile, not a live
// update — this keeps the supply chain auditable and avoids letting a
// compromised CDN swap a binary on us between releases.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

const EMBEDDED_MANIFEST: &str = include_str!("manifest.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub bundles: HashMap<String, Bundle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bundle {
    pub display_name: String,
    pub tool_version: String,
    pub tools: Vec<String>,
    pub covers_engines: Vec<String>,
    pub platforms: HashMap<String, PlatformAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformAsset {
    pub url: String,
    pub sha256: String,
    pub archive: ArchiveKind,
    pub size_bytes: u64,
    #[serde(default)]
    pub strip_components: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveKind {
    #[serde(rename = "tar.gz")]
    TarGz,
    Zip,
}

impl Manifest {
    pub fn load() -> Result<Self, serde_json::Error> {
        serde_json::from_str(EMBEDDED_MANIFEST)
    }

    pub fn bundle(&self, key: &str) -> Option<&Bundle> {
        self.bundles.get(key)
    }
}

impl Bundle {
    pub fn asset_for_current_platform(&self) -> Option<&PlatformAsset> {
        self.platforms.get(current_platform_key())
    }
}

/// Stable key identifying the current OS+arch. Matches the keys used
/// in `manifest.json`. Returns a static string so callers never have
/// to think about platform detection.
pub fn current_platform_key() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return "darwin-aarch64";
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return "darwin-x86_64";
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return "linux-x86_64";
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return "linux-aarch64";
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return "windows-x86_64";
    }
    #[allow(unreachable_code)]
    {
        "unknown"
    }
}

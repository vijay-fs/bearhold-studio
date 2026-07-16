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
    /// License metadata — the source of truth for the bundled
    /// third-party notices. Required for anything we ship inside the
    /// installer so we can honour attribution / copyleft obligations.
    #[serde(default)]
    pub license: License,
}

/// Per-bundle license info used to generate the app's Open Source
/// Notices. For permissive tools only `spdx`, `url`, and `copyright`
/// matter. For copyleft tools (`copyleft: true`, e.g. GPLv2 mysqldump)
/// `source_url` MUST point at the *exact* corresponding source so the
/// generated written offer is valid.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct License {
    /// SPDX identifier, e.g. "GPL-2.0-only", "Apache-2.0",
    /// "PostgreSQL", "BSD-3-Clause", "blessing" (SQLite public domain).
    #[serde(default)]
    pub spdx: String,
    /// Canonical URL of the license text.
    #[serde(default)]
    pub url: Option<String>,
    /// Copyright line to reproduce in the notices.
    #[serde(default)]
    pub copyright: Option<String>,
    /// True for reciprocal/copyleft licenses that carry a
    /// source-availability obligation when we redistribute the binary.
    #[serde(default)]
    pub copyleft: bool,
    /// URL of the complete corresponding source for the exact version
    /// bundled. Populates the GPLv2 §3 written offer. Required when
    /// `copyleft` is true.
    #[serde(default)]
    pub source_url: Option<String>,
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

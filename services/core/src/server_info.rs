// Server version + capability probe results.
//
// Returned by `Driver::server_info` and surfaced to the frontend via a
// Tauri command. The frontend's `engineVersion.ts` capability model
// consumes `major` / `minor` to decide which SQL flavor to emit for
// diff and data-diff sync statements.
//
// Kept intentionally narrow — no lists of features or catalog of
// extensions. Just enough to make the version-dispatched builders on
// the frontend correct.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    /// Parsed major version. `None` when the engine reported something
    /// we couldn't parse (foreign fork, unusual build). Frontend falls
    /// back to the safe-minimum capability set in that case.
    pub major: Option<u32>,
    /// Parsed minor version. Only checked for MySQL 8.0.x-style gates.
    pub minor: Option<u32>,
    /// The raw `SELECT VERSION()` (or equivalent) string, for display
    /// in the connection details panel. Never used for feature gates —
    /// dispatch is major/minor only.
    pub raw: String,
    /// Engine-side flags the driver detected. These are additional
    /// signals beyond version — currently just the sql_mode setting
    /// on MySQL that decides whether backslash escapes work.
    #[serde(default)]
    pub flags: ServerFlags,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServerFlags {
    /// MySQL: `sql_mode` contains `NO_BACKSLASH_ESCAPES`. When true,
    /// our SQL literal formatter uses doubled-quote escapes instead
    /// of backslashes.
    pub no_backslash_escapes: bool,
}

impl ServerInfo {
    /// Parse a `X.Y[.Z]` prefix out of the raw version string.
    /// MySQL returns `8.0.39`, Postgres returns `16.4 (Ubuntu ...)`.
    /// We only
    /// look at the leading numeric-dotted prefix — anything after is
    /// vendor decoration.
    pub fn parse_version(raw: &str) -> (Option<u32>, Option<u32>) {
        let mut chars = raw.chars();
        let mut major = String::new();
        for c in chars.by_ref() {
            if c.is_ascii_digit() {
                major.push(c);
            } else {
                break;
            }
        }
        let mut minor = String::new();
        for c in chars.by_ref() {
            if c.is_ascii_digit() {
                minor.push(c);
            } else {
                break;
            }
        }
        (major.parse().ok(), minor.parse().ok())
    }
}

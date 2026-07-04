// Dump-format detector.
//
// The Import page hands us a filesystem path and asks "what is this?".
// We read the first few KB and match against a set of well-known
// signatures. This is deliberately narrow: we ONLY recognize formats
// we know how to import. Anything ambiguous (`.sql` that isn't PG or
// MySQL, `.jsonl` with no per-line JSON) returns `Unknown` so the UI
// can prompt the user rather than guessing wrong.
//
// Magic-byte references:
//   - Postgres custom dump    starts with `PGDMP`
//   - SQLite database file    starts with `SQLite format 3\0`
//   - Redis RDB snapshot      starts with `REDIS`
// Header-comment references (first 4 KB, case-insensitive):
//   - PG plain SQL            `-- PostgreSQL database dump`
//   - MySQL plain SQL         `-- MySQL dump`
//   - SQLite plain SQL dump   `PRAGMA foreign_keys` early on

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const HEADER_SCAN_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DumpFormat {
    /// `PGDMP` — pg_dump `--format=custom`. Import with `pg_restore`.
    PgCustom,
    /// `PGDMP` archive laid out as a tar archive (`pg_dump -F t`).
    /// Distinguished from PgCustom by the tar magic in the last 512 B.
    PgTar,
    /// Plain-SQL PG dump (`pg_dump --format=plain` or `psql -f`).
    /// Import with `psql -f`.
    PgPlain,
    /// Plain-SQL MySQL dump from `mysqldump`. Import with `mysql <`.
    MysqlPlain,
    /// SQLite database file. Import = replace the target's file.
    SqliteFile,
    /// `.dump` from the sqlite3 CLI. Runs through `sqlite3 db < file`.
    SqlitePlain,
    /// mongodump BSON directory (the user pointed at the top-level
    /// dir OR the .bson file). Import with `mongorestore`.
    MongoBsonDir,
    /// JSON Lines — one document per line. Driver-side `insertMany`.
    Jsonl,
    /// Redis RDB snapshot. NOT importable live (see design doc).
    RedisRdb,
    /// A gzipped archive. We don't peek inside; the UI asks the user
    /// to gunzip first. Rare in practice — most dump tools embed
    /// their own compression.
    Gzip,
    /// Nothing matched. UI prompts the user to pick a format
    /// manually or shows an error.
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DumpProbe {
    pub format: DumpFormat,
    /// File size in bytes. Handy for the UI so we can show "12.4 MB
    /// dump" without a second stat() round-trip.
    pub size_bytes: u64,
    /// Absolute canonical path.
    pub path: PathBuf,
    /// Human-readable hint the UI shows in the "Detected: ..." row.
    pub description: String,
}

pub fn probe(path: &Path) -> std::io::Result<DumpProbe> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let metadata = std::fs::metadata(&canonical)?;
    // If we were pointed at a directory, treat it as a Mongo dump if
    // it contains any .bson files. Otherwise unknown.
    if metadata.is_dir() {
        let has_bson = std::fs::read_dir(&canonical)?
            .flatten()
            .any(|e| e.file_name().to_string_lossy().ends_with(".bson"));
        return Ok(DumpProbe {
            format: if has_bson {
                DumpFormat::MongoBsonDir
            } else {
                DumpFormat::Unknown
            },
            size_bytes: 0,
            path: canonical,
            description: if has_bson {
                "MongoDB BSON dump directory".into()
            } else {
                "Directory (no .bson files detected)".into()
            },
        });
    }

    let mut header = vec![0u8; HEADER_SCAN_BYTES];
    let mut file = File::open(&canonical)?;
    let read = file.read(&mut header)?;
    header.truncate(read);

    let format = classify(&header, &canonical);
    let description = describe(format);
    Ok(DumpProbe {
        format,
        size_bytes: metadata.len(),
        path: canonical,
        description,
    })
}

fn classify(bytes: &[u8], path: &Path) -> DumpFormat {
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        return DumpFormat::Gzip;
    }
    if bytes.starts_with(b"PGDMP") {
        // pg_dump custom-format starts with `PGDMP`. The `-F t`
        // (tar) variant also starts with the same magic since it's a
        // custom-format archive tarred up — but a real GNU tar has
        // "ustar" at offset 257. Only rely on that if we have enough
        // bytes.
        if bytes.len() > 260 && &bytes[257..262] == b"ustar" {
            return DumpFormat::PgTar;
        }
        return DumpFormat::PgCustom;
    }
    if bytes.starts_with(b"SQLite format 3\0") {
        return DumpFormat::SqliteFile;
    }
    if bytes.starts_with(b"REDIS") {
        return DumpFormat::RedisRdb;
    }
    // Header sniff on the first few KB as UTF-8 (lossy). We only
    // pattern-match ASCII substrings so lossy decode is safe.
    let text = String::from_utf8_lossy(bytes);
    let lower = text.to_lowercase();
    if lower.contains("-- postgresql database dump") {
        return DumpFormat::PgPlain;
    }
    if lower.contains("-- mysql dump") || lower.contains("-- host:") && lower.contains("mysql") {
        return DumpFormat::MysqlPlain;
    }
    if lower.contains("pragma foreign_keys") && lower.contains("begin transaction") {
        return DumpFormat::SqlitePlain;
    }
    // JSONL: every non-empty line parses as a JSON object. We test
    // the first ~10 lines to avoid loading megabytes of file.
    if looks_like_jsonl(&text) {
        return DumpFormat::Jsonl;
    }
    // Extension fallback for cases the content sniffer misses (e.g. a
    // zero-content plain dump).
    match path.extension().and_then(|s| s.to_str()) {
        Some("sql") => DumpFormat::PgPlain, // generic plain-SQL — assume PG-style; UI can override
        Some("dump") => DumpFormat::PgCustom,
        Some("sqlite") | Some("db") | Some("sqlite3") => DumpFormat::SqliteFile,
        Some("jsonl") | Some("ndjson") => DumpFormat::Jsonl,
        Some("bson") => DumpFormat::MongoBsonDir,
        Some("rdb") => DumpFormat::RedisRdb,
        _ => DumpFormat::Unknown,
    }
}

fn looks_like_jsonl(text: &str) -> bool {
    let mut checked = 0;
    for line in text.lines().take(10) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
            return false;
        }
        // Cheap round-trip check via serde_json to weed out
        // "{ this is not JSON" false positives.
        if serde_json::from_str::<serde_json::Value>(trimmed).is_err() {
            return false;
        }
        checked += 1;
    }
    checked > 0
}

fn describe(f: DumpFormat) -> String {
    match f {
        DumpFormat::PgCustom => "PostgreSQL custom-format dump (pg_restore)".into(),
        DumpFormat::PgTar => "PostgreSQL tar-format dump (pg_restore)".into(),
        DumpFormat::PgPlain => "PostgreSQL plain SQL dump (psql)".into(),
        DumpFormat::MysqlPlain => "MySQL plain SQL dump (mysql)".into(),
        DumpFormat::SqliteFile => "SQLite database file".into(),
        DumpFormat::SqlitePlain => "SQLite plain SQL dump (sqlite3)".into(),
        DumpFormat::MongoBsonDir => "MongoDB BSON dump (mongorestore)".into(),
        DumpFormat::Jsonl => "JSON Lines".into(),
        DumpFormat::RedisRdb => "Redis RDB snapshot".into(),
        DumpFormat::Gzip => "Gzipped archive — decompress before import".into(),
        DumpFormat::Unknown => "Unknown format — pick manually".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn probe_bytes(bytes: &[u8], ext: &str) -> DumpFormat {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(bytes).unwrap();
        let path = f.path().with_extension(ext);
        std::fs::rename(f.path(), &path).unwrap();
        probe(&path).unwrap().format
    }

    #[test]
    fn detects_pg_custom() {
        assert_eq!(probe_bytes(b"PGDMP\x00\x00", "dump"), DumpFormat::PgCustom);
    }

    #[test]
    fn detects_sqlite_file() {
        assert_eq!(
            probe_bytes(b"SQLite format 3\0extra bytes here", "db"),
            DumpFormat::SqliteFile,
        );
    }

    #[test]
    fn detects_redis_rdb() {
        assert_eq!(probe_bytes(b"REDIS0011", "rdb"), DumpFormat::RedisRdb);
    }

    #[test]
    fn detects_pg_plain_header() {
        assert_eq!(
            probe_bytes(b"-- PostgreSQL database dump\n-- ...\n", "sql"),
            DumpFormat::PgPlain,
        );
    }

    #[test]
    fn detects_mysql_plain_header() {
        assert_eq!(
            probe_bytes(b"-- MySQL dump 10.13  Distrib 8.0\n", "sql"),
            DumpFormat::MysqlPlain,
        );
    }

    #[test]
    fn detects_jsonl() {
        assert_eq!(
            probe_bytes(b"{\"a\":1}\n{\"b\":2}\n", "jsonl"),
            DumpFormat::Jsonl,
        );
    }
}

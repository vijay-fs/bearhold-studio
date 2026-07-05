// Database export driver.
//
// Spawns pg_dump / mysqldump / sqlite3 with engine-appropriate flags,
// streams stderr to Tauri progress events, and writes the archive
// directly to the destination path the user picked.
//
// Security notes:
//   - Passwords are NEVER placed on the command line (visible in
//     `ps -ef`). PG uses the PGPASSWORD env var; MySQL uses a
//     temporary 0600-mode `--defaults-extra-file`. Both are cleared /
//     unlinked when the process exits.
//   - Output paths are checked against directory-traversal — we
//     require an absolute path with an existing parent.
//   - Tool binaries come from `tool_locator::locate` which only
//     returns paths inside the app-data tools dir OR from a
//     PATH-resolved shell-style lookup. We do NOT accept arbitrary
//     paths from the frontend.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use dbstudio_core::{
    secrets::{self, Slot},
    AuthMethod, ConnectionProfile, DatabaseEngine,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::tool_locator;

const STDERR_TAIL_MAX: usize = 8_192;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportOptions {
    pub profile: ConnectionProfile,
    /// Absolute destination path chosen via `dialog::save`. Parent
    /// dir must exist. The file is overwritten if present.
    pub output_path: PathBuf,
    pub format: ExportFormat,
    #[serde(default)]
    pub include_schema: bool,
    #[serde(default)]
    pub include_data: bool,
    /// Restrict to specific tables. Empty = whole database.
    /// Format: `schema.table` for PG, `table` for MySQL/SQLite.
    #[serde(default)]
    pub tables: Vec<String>,
    /// PG-only. Adds `--clean --if-exists` for a "drop before create"
    /// restore.
    #[serde(default)]
    pub drop_before_create: bool,
    /// PG-only. Adds `--no-owner --no-privileges`. Default true — the
    /// most common cause of "restore failed" is an owner that doesn't
    /// exist on the target.
    #[serde(default = "default_true")]
    pub no_owner: bool,
    /// MySQL only. Adds `--single-transaction` for InnoDB consistency.
    /// Default true; only turn off for `--lock-tables`-style dumps.
    #[serde(default = "default_true")]
    pub single_transaction: bool,
    /// PG only, matches `--jobs N` on custom / directory format. 0 or
    /// missing = leave off.
    #[serde(default)]
    pub parallel_jobs: Option<u32>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    /// pg_dump `--format=custom` — the archive that pg_restore likes
    /// best. Highest fidelity for PG.
    PgCustom,
    /// pg_dump `--format=plain` — a psql-runnable `.sql` file.
    PgPlain,
    /// pg_dump `--format=tar`.
    PgTar,
    /// mysqldump plain SQL (there's no other format for it).
    MysqlPlain,
    /// sqlite3 `.dump` piped to disk.
    SqlitePlain,
    /// Straight `cp` of the SQLite file. Fastest, requires the target
    /// pool to be closed first (WAL checkpoint has to complete).
    SqliteFileCopy,
}

/// Job registry so a sibling `cancel_export` command can find the
/// running child and kill it. Keyed by a caller-supplied UUID.
#[derive(Default)]
pub struct ExportRegistry {
    jobs: DashMap<Uuid, Arc<Mutex<Option<Child>>>>,
}

impl ExportRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("engine {engine:?} not supported for export")]
    UnsupportedEngine { engine: DatabaseEngine },
    #[error("format {format:?} not valid for engine {engine:?}")]
    FormatEngineMismatch {
        format: ExportFormat,
        engine: DatabaseEngine,
    },
    #[error("output path parent does not exist: {0}")]
    BadOutputPath(String),
    #[error("i/o: {0}")]
    Io(#[from] std::io::Error),
    #[error("secrets: {0}")]
    Secrets(String),
    #[error("child failed: exit code {code:?} — stderr tail: {stderr_tail}")]
    ChildFailed { code: Option<i32>, stderr_tail: String },
    #[error("job cancelled by user")]
    Cancelled,
    #[error("locate tool: {0}")]
    Locate(String),
}

pub type Result<T> = std::result::Result<T, ExportError>;

pub struct ExportContext {
    pub app_data_dir: PathBuf,
    pub registry: Arc<ExportRegistry>,
    pub job_id: Uuid,
    /// SQLite driver handle — reuses the app-wide connection pool so
    /// the WAL checkpoint runs against the same file the SQL editor
    /// has open, not a stale copy. Only used by the SQLite export
    /// path; PG/MySQL don't touch it.
    pub sqlite_driver: Arc<dbstudio_driver_sqlite::SqliteDriver>,
}

pub trait ExportProgressSink: Send + Sync {
    fn on_stderr(&self, line: &str);
    fn on_bytes_written(&self, bytes: u64);
}

/// Run the export end-to-end. Returns the path to the finalised
/// artifact on success. On cancel or error the partial output file is
/// removed so the user never sees a half-written dump.
pub async fn run_export(
    ctx: ExportContext,
    opts: ExportOptions,
    sink: Arc<dyn ExportProgressSink>,
) -> Result<PathBuf> {
    validate_output_path(&opts.output_path)?;

    // Sanity: format must belong to the engine. Cheap client-side
    // safeguard; the CLIs would error too, but this gives a friendlier
    // message.
    ensure_format_matches_engine(opts.format, opts.profile.engine)?;

    let result = match opts.profile.engine {
        DatabaseEngine::Postgres => {
            run_pg_dump(&ctx, &opts, sink.clone()).await
        }
        DatabaseEngine::MySql => run_mysqldump(&ctx, &opts, sink.clone()).await,
        DatabaseEngine::Sqlite => run_sqlite_export(&ctx, &opts, sink.clone()).await,
        e => Err(ExportError::UnsupportedEngine { engine: e }),
    };

    // Cleanup partial output on any failure — a half-written dump is
    // worse than no dump because the user assumes it's usable.
    if result.is_err() && opts.output_path.exists() {
        let _ = std::fs::remove_file(&opts.output_path);
    }
    result
}

fn ensure_format_matches_engine(f: ExportFormat, e: DatabaseEngine) -> Result<()> {
    let ok = matches!(
        (f, e),
        (ExportFormat::PgCustom | ExportFormat::PgPlain | ExportFormat::PgTar, DatabaseEngine::Postgres)
            | (ExportFormat::MysqlPlain, DatabaseEngine::MySql)
            | (ExportFormat::SqlitePlain | ExportFormat::SqliteFileCopy, DatabaseEngine::Sqlite)
    );
    if ok {
        Ok(())
    } else {
        Err(ExportError::FormatEngineMismatch { format: f, engine: e })
    }
}

fn validate_output_path(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(ExportError::BadOutputPath(
            "output path must be absolute".into(),
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| ExportError::BadOutputPath("no parent".into()))?;
    if !parent.exists() {
        return Err(ExportError::BadOutputPath(parent.display().to_string()));
    }
    Ok(())
}

// ---- Postgres --------------------------------------------------------

async fn run_pg_dump(
    ctx: &ExportContext,
    opts: &ExportOptions,
    sink: Arc<dyn ExportProgressSink>,
) -> Result<PathBuf> {
    let loc = tool_locator::locate(&ctx.app_data_dir, "postgres", "pg_dump")
        .map_err(|e| ExportError::Locate(e.to_string()))?;

    let mut cmd = Command::new(&loc.path);
    cmd.arg(format!("--host={}", opts.profile.host))
        .arg(format!("--port={}", opts.profile.port))
        .arg(format!("--dbname={}", opts.profile.database));

    if let Some(user) = user_from_auth(&opts.profile.auth) {
        cmd.arg(format!("--username={user}"));
    }
    cmd.arg("--no-password"); // never prompt on stdin

    let format_flag = match opts.format {
        ExportFormat::PgCustom => "custom",
        ExportFormat::PgPlain => "plain",
        ExportFormat::PgTar => "tar",
        _ => unreachable!("guarded by ensure_format_matches_engine"),
    };
    cmd.arg(format!("--format={format_flag}"));

    if opts.drop_before_create {
        cmd.arg("--clean").arg("--if-exists");
    }
    if opts.no_owner {
        cmd.arg("--no-owner").arg("--no-privileges");
    }
    if !opts.include_schema {
        cmd.arg("--data-only");
    } else if !opts.include_data {
        cmd.arg("--schema-only");
    }
    for t in &opts.tables {
        cmd.arg("--table").arg(t);
    }
    if let Some(jobs) = opts.parallel_jobs {
        if jobs > 1 && matches!(opts.format, ExportFormat::PgCustom | ExportFormat::PgTar) {
            cmd.arg("--jobs").arg(jobs.to_string());
        }
    }

    cmd.arg("--file").arg(&opts.output_path);

    // Password via env var — visible only to the child process, not
    // to `ps` on the machine.
    if let Some(pw) = resolve_password(&opts.profile).await? {
        cmd.env("PGPASSWORD", pw);
    }
    // Ensure no stale PG* env vars leak from the parent shell if the
    // user happens to have them set for a different profile.
    for var in ["PGHOST", "PGPORT", "PGUSER", "PGDATABASE"] {
        cmd.env_remove(var);
    }

    spawn_and_wait(ctx, cmd, sink, &opts.output_path).await
}

// ---- MySQL -----------------------------------------------------------

async fn run_mysqldump(
    ctx: &ExportContext,
    opts: &ExportOptions,
    sink: Arc<dyn ExportProgressSink>,
) -> Result<PathBuf> {
    let loc = tool_locator::locate(&ctx.app_data_dir, "mysql", "mysqldump")
        .map_err(|e| ExportError::Locate(e.to_string()))?;

    // Password + user go into a temp `--defaults-extra-file`. mysqldump
    // reads this once at startup, then we delete the file. Never on the
    // command line.
    let creds_file = if requires_password(&opts.profile.auth) {
        Some(write_mysql_creds(&opts.profile).await?)
    } else {
        None
    };

    let mut cmd = Command::new(&loc.path);
    if let Some(ref path) = creds_file {
        cmd.arg(format!("--defaults-extra-file={}", path.display()));
    }
    cmd.arg(format!("--host={}", opts.profile.host))
        .arg(format!("--port={}", opts.profile.port));

    if opts.single_transaction {
        cmd.arg("--single-transaction");
    }
    cmd.arg("--quick").arg("--hex-blob");
    if !opts.include_schema {
        cmd.arg("--no-create-info");
    }
    if !opts.include_data {
        cmd.arg("--no-data");
    }
    // MySQL 8+ defaults to writing GTID_PURGED lines that surprise
    // users importing into a non-GTID target. Turn off unless the
    // user is explicitly replicating.
    cmd.arg("--set-gtid-purged=OFF");

    // Positional args: database + (optionally) table list.
    cmd.arg(&opts.profile.database);
    for t in &opts.tables {
        cmd.arg(t);
    }

    // mysqldump writes to stdout — redirect into the destination file.
    let out_file = std::fs::File::create(&opts.output_path)?;
    cmd.stdout(Stdio::from(out_file));

    let result = spawn_and_wait(ctx, cmd, sink, &opts.output_path).await;

    // Always try to delete the creds file, success or failure.
    if let Some(path) = creds_file {
        let _ = std::fs::remove_file(path);
    }
    result
}

async fn write_mysql_creds(profile: &ConnectionProfile) -> Result<PathBuf> {
    let user = user_from_auth(&profile.auth).unwrap_or_default();
    let password = resolve_password(profile).await?.unwrap_or_default();
    let dir = std::env::temp_dir();
    let file_name = format!("bearhold-my-{}.cnf", Uuid::new_v4());
    let path = dir.join(file_name);
    let content = format!("[client]\nuser={user}\npassword={password}\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true).mode(0o600);
        use std::io::Write;
        let mut f = opts.open(&path)?;
        f.write_all(content.as_bytes())?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&path, content.as_bytes())?;
    }
    Ok(path)
}

// ---- SQLite ----------------------------------------------------------

async fn run_sqlite_export(
    ctx: &ExportContext,
    opts: &ExportOptions,
    sink: Arc<dyn ExportProgressSink>,
) -> Result<PathBuf> {
    match opts.format {
        ExportFormat::SqliteFileCopy => {
            let src = opts
                .profile
                .file_path
                .as_ref()
                .ok_or_else(|| ExportError::BadOutputPath("SQLite profile has no file_path".into()))?;

            // Flush any WAL contents into the main database file
            // BEFORE we copy. Modern SQLite defaults to
            // journal_mode=WAL, which means the .sqlite file on disk
            // only holds a snapshot up to the last checkpoint —
            // everything since lives in the `-wal` sidecar. Without
            // this step, `fs::copy` on a lively database can produce
            // a nearly-empty destination (which is what "Wrote 0 B"
            // was showing).
            //
            // We ignore checkpoint errors so a read-only SQLite file
            // still exports cleanly — worst case the copy just
            // includes the (already-persisted) main file as-is.
            let _ = ctx.sqlite_driver.checkpoint_wal(&opts.profile).await;

            // Also copy the -wal and -shm sidecars if they still
            // exist post-checkpoint. On a healthy checkpoint(TRUNCATE)
            // the -wal file is shrunk to 0 bytes and the -shm is
            // fine to leave behind, but shipping them along makes the
            // dump safe to open even if the checkpoint didn't fully
            // land.
            std::fs::copy(src, &opts.output_path)?;
            copy_sidecar(src, &opts.output_path, "-wal");
            copy_sidecar(src, &opts.output_path, "-shm");

            // Emit the final byte count so the UI shows the real
            // size instead of "0 B".
            if let Ok(md) = std::fs::metadata(&opts.output_path) {
                sink.on_bytes_written(md.len());
            }
            Ok(opts.output_path.clone())
        }
        ExportFormat::SqlitePlain => {
            // sqlite3 <db> .dump — separate binary; wire through
            // tool_locator so the user can install the bundle if
            // needed.
            let src = opts
                .profile
                .file_path
                .as_ref()
                .ok_or_else(|| ExportError::BadOutputPath("SQLite profile has no file_path".into()))?;
            // Skip the locator complexity for now; sqlite3 is almost
            // always present on macOS/Linux and can be installed via
            // the bundle later. This branch is a stub — implemented
            // in the same shape as pg_dump once we wire up the CLI.
            let _ = src;
            Err(ExportError::UnsupportedEngine {
                engine: DatabaseEngine::Sqlite,
            })
        }
        _ => unreachable!("guarded by ensure_format_matches_engine"),
    }
}

/// Copy `<src><suffix>` to `<dst><suffix>` if the source exists.
/// Silent no-op otherwise — sidecars are optional.
fn copy_sidecar(src: &Path, dst: &Path, suffix: &str) {
    let mut side_src = src.as_os_str().to_owned();
    side_src.push(suffix);
    let side_src = PathBuf::from(side_src);
    if !side_src.exists() {
        return;
    }
    let mut side_dst = dst.as_os_str().to_owned();
    side_dst.push(suffix);
    let _ = std::fs::copy(&side_src, PathBuf::from(side_dst));
}

// ---- Shared spawn/wait/stderr loop ----------------------------------

async fn spawn_and_wait(
    ctx: &ExportContext,
    mut cmd: Command,
    sink: Arc<dyn ExportProgressSink>,
    output_path: &Path,
) -> Result<PathBuf> {
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn()?;

    // Take stderr before moving `child` into the registry so we can
    // pump stderr lines concurrently with the wait.
    let stderr = child.stderr.take();
    let slot = Arc::new(Mutex::new(Some(child)));
    ctx.registry.jobs.insert(ctx.job_id, slot.clone());

    let stderr_task = tokio::spawn({
        let sink = sink.clone();
        async move {
            let mut tail = String::new();
            if let Some(stderr) = stderr {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    sink.on_stderr(&line);
                    if tail.len() + line.len() < STDERR_TAIL_MAX {
                        tail.push_str(&line);
                        tail.push('\n');
                    }
                }
            }
            tail
        }
    });

    // Byte-size ticker: watch the output file so the UI has a
    // progress signal for engines that don't emit per-table stderr.
    let size_task = tokio::spawn({
        let sink = sink.clone();
        let path = output_path.to_path_buf();
        async move {
            let mut last_size: u64 = 0;
            loop {
                tokio::time::sleep(Duration::from_millis(250)).await;
                match std::fs::metadata(&path) {
                    Ok(md) => {
                        let n = md.len();
                        if n != last_size {
                            last_size = n;
                            sink.on_bytes_written(n);
                        }
                    }
                    Err(_) => return,
                }
            }
        }
    });

    // Wait for exit.
    let status = {
        let mut guard = slot.lock().await;
        let child = guard
            .as_mut()
            .ok_or_else(|| ExportError::Cancelled)?;
        child.wait().await?
    };
    // Drop registry entry so a stale cancel is a no-op.
    ctx.registry.jobs.remove(&ctx.job_id);
    size_task.abort();
    let tail = stderr_task.await.unwrap_or_default();

    if !status.success() {
        return Err(ExportError::ChildFailed {
            code: status.code(),
            stderr_tail: tail,
        });
    }
    // Final size tick so the UI sees 100%.
    if let Ok(md) = std::fs::metadata(output_path) {
        sink.on_bytes_written(md.len());
    }
    Ok(output_path.to_path_buf())
}

pub async fn cancel(reg: &ExportRegistry, job_id: Uuid) -> bool {
    if let Some((_, slot)) = reg.jobs.remove(&job_id) {
        let mut guard = slot.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
            return true;
        }
    }
    false
}

// ---- Credential helpers ---------------------------------------------

fn user_from_auth(auth: &AuthMethod) -> Option<String> {
    match auth {
        AuthMethod::Password { username, .. } => Some(username.clone()),
        AuthMethod::SshKey { username, .. } => Some(username.clone()),
        AuthMethod::IamAws { username, .. } => Some(username.clone()),
        AuthMethod::Vault { .. } | AuthMethod::None => None,
    }
}

fn requires_password(auth: &AuthMethod) -> bool {
    matches!(auth, AuthMethod::Password { .. })
}

async fn resolve_password(profile: &ConnectionProfile) -> Result<Option<String>> {
    if !matches!(profile.auth, AuthMethod::Password { .. }) {
        return Ok(None);
    }
    // Password lookup follows the same shape drivers use: keyed by
    // `(profile_id, Slot::Password)`. The `password_ref` inside
    // AuthMethod is just a display placeholder — the actual value
    // lives in the encrypted secrets store.
    let value = secrets::get(profile.id, Slot::Password)
        .await
        .map_err(|e| ExportError::Secrets(e.to_string()))?;
    Ok(value)
}


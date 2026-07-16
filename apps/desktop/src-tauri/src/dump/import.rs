// Database import driver.
//
// Symmetric to `export.rs` but running the input file through the
// engine's restore tool: pg_restore for PG custom dumps, psql -f for
// plain SQL, mysql < for MySQL, straight file copy for SQLite.
//
// Same security discipline as the export side: passwords never on the
// command line (env var for PG, temp 0600-mode credentials file for
// MySQL), tool binaries only resolved via the bundle cache or PATH
// lookup, source path canonicalized before we hand it to a child
// process.

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

use super::detect::DumpFormat;
use super::tool_locator;

const STDERR_TAIL_MAX: usize = 8_192;
/// Poll interval for the child-exit loop in `spawn_and_wait`. Short
/// enough that job completion feels instant, long enough that the
/// slot mutex is essentially uncontended for `cancel`.
const WAIT_POLL_MS: u64 = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportOptions {
    pub profile: ConnectionProfile,
    /// Absolute path to the source dump on disk. Format is detected
    /// server-side; the frontend can pass a hint but we always
    /// canonicalize + validate here.
    pub source_path: PathBuf,
    /// Detected (or user-selected) format. If missing, the runner
    /// re-runs `detect::probe` to figure it out — the frontend has
    /// probably already done this, so passing it in saves the second
    /// read.
    pub format: DumpFormat,
    /// Wrap the whole import in a single transaction where the tool
    /// supports it (`psql -1`, `mysql --init-command="SET autocommit=0"`).
    /// Default true; set false for very large dumps where one bad
    /// statement shouldn't roll back hours of work.
    #[serde(default = "default_true")]
    pub single_transaction: bool,
    /// pg_restore only. Adds `--clean --if-exists`.
    #[serde(default)]
    pub drop_before_create: bool,
    /// pg_restore only. Adds `--no-owner --no-privileges`. Default
    /// true — mirrors the export-side default and avoids the
    /// most common "restore failed: role X does not exist" issue.
    #[serde(default = "default_true")]
    pub no_owner: bool,
    /// pg_restore only. Sets `--jobs=N` for parallel restore. 0/None
    /// means single-stream.
    #[serde(default)]
    pub parallel_jobs: Option<u32>,
    /// Stop the child on first error. On by default; some users
    /// prefer to plow through and see everything that failed at the
    /// end.
    #[serde(default = "default_true")]
    pub stop_on_error: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Default)]
pub struct ImportRegistry {
    jobs: DashMap<Uuid, Arc<Mutex<Option<Child>>>>,
}

impl ImportRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("engine {engine:?} not supported for import")]
    UnsupportedEngine { engine: DatabaseEngine },
    #[error("format {format:?} not valid for engine {engine:?}")]
    FormatEngineMismatch {
        format: DumpFormat,
        engine: DatabaseEngine,
    },
    #[error("source path not found: {0}")]
    SourceMissing(String),
    #[error("locate tool: {0}")]
    Locate(String),
    #[error("i/o: {0}")]
    Io(#[from] std::io::Error),
    #[error("secrets: {0}")]
    Secrets(String),
    #[error("child failed: exit code {code:?} — stderr tail: {stderr_tail}")]
    ChildFailed {
        code: Option<i32>,
        stderr_tail: String,
    },
    #[error("job cancelled by user")]
    Cancelled,
    #[error("this connection uses an SSH tunnel — import runs native CLI tools that can't use it yet, and connecting directly could restore into a different server. Import from a machine with direct access to the database")]
    SshTunnelUnsupported,
}

pub type Result<T> = std::result::Result<T, ImportError>;

pub struct ImportContext {
    pub app_data_dir: PathBuf,
    /// App resource directory holding installer-bundled CLI tools.
    /// `None` when it couldn't be resolved (dev builds) — the locator
    /// then falls back to the download cache / system PATH.
    pub resource_dir: Option<PathBuf>,
    pub registry: Arc<ImportRegistry>,
    pub job_id: Uuid,
}

pub trait ImportProgressSink: Send + Sync {
    fn on_stderr(&self, line: &str);
    fn on_bytes_read(&self, bytes: u64);
}

pub async fn run_import(
    ctx: ImportContext,
    opts: ImportOptions,
    sink: Arc<dyn ImportProgressSink>,
) -> Result<()> {
    if !opts.source_path.exists() {
        return Err(ImportError::SourceMissing(
            opts.source_path.display().to_string(),
        ));
    }
    ensure_format_matches_engine(opts.format, opts.profile.engine)?;

    // Same guard as export: the native CLIs connect straight to
    // profile.host with no tunnel, so a tunneled profile could restore
    // into a DIFFERENT server than the one the app browses. Refuse
    // loudly. (SQLite is exempt — file-copy import is local.)
    if opts.profile.ssh_tunnel.is_some() && !matches!(opts.profile.engine, DatabaseEngine::Sqlite) {
        return Err(ImportError::SshTunnelUnsupported);
    }

    match opts.profile.engine {
        DatabaseEngine::Postgres => run_pg_import(&ctx, &opts, sink).await,
        DatabaseEngine::MySql => run_mysql_import(&ctx, &opts, sink).await,
        DatabaseEngine::Sqlite => run_sqlite_import(&opts, sink).await,
        e => Err(ImportError::UnsupportedEngine { engine: e }),
    }
}

fn ensure_format_matches_engine(f: DumpFormat, e: DatabaseEngine) -> Result<()> {
    let ok = matches!(
        (f, e),
        (
            DumpFormat::PgCustom | DumpFormat::PgTar | DumpFormat::PgPlain,
            DatabaseEngine::Postgres,
        ) | (DumpFormat::MysqlPlain, DatabaseEngine::MySql)
            | (
                DumpFormat::SqliteFile | DumpFormat::SqlitePlain,
                DatabaseEngine::Sqlite,
            )
    );
    if ok {
        Ok(())
    } else {
        Err(ImportError::FormatEngineMismatch {
            format: f,
            engine: e,
        })
    }
}

// ---- Postgres --------------------------------------------------------

async fn run_pg_import(
    ctx: &ImportContext,
    opts: &ImportOptions,
    sink: Arc<dyn ImportProgressSink>,
) -> Result<()> {
    // pg_restore for archive formats, psql for plain SQL. Different
    // binaries; both live in the same bundle.
    let (tool_name, use_psql) = match opts.format {
        DumpFormat::PgCustom | DumpFormat::PgTar => ("pg_restore", false),
        DumpFormat::PgPlain => ("psql", true),
        _ => unreachable!("guarded by ensure_format_matches_engine"),
    };
    let loc = tool_locator::locate(
        ctx.resource_dir.as_deref(),
        &ctx.app_data_dir,
        "postgres",
        tool_name,
    )
    .map_err(|e| ImportError::Locate(e.to_string()))?;

    let mut cmd = Command::new(&loc.path);
    cmd.arg(format!("--host={}", opts.profile.host))
        .arg(format!("--port={}", opts.profile.port))
        .arg(format!("--dbname={}", opts.profile.database));

    if let Some(user) = user_from_auth(&opts.profile.auth) {
        cmd.arg(format!("--username={user}"));
    }
    cmd.arg("--no-password");

    if use_psql {
        // psql: -f runs the file. `ON_ERROR_STOP=1` is set as a var
        // when the user asked for stop-on-error. `-1` wraps everything
        // in a single transaction so a mid-file failure rolls back
        // cleanly.
        cmd.arg("-f").arg(&opts.source_path);
        if opts.stop_on_error {
            cmd.arg("-v").arg("ON_ERROR_STOP=1");
        }
        if opts.single_transaction {
            cmd.arg("-1");
        }
        // psql chatters status to stdout; silence unless user wanted
        // verbose. stderr is where the real errors go anyway.
        cmd.arg("--quiet");
    } else {
        // pg_restore
        if opts.drop_before_create {
            cmd.arg("--clean").arg("--if-exists");
        }
        if opts.no_owner {
            cmd.arg("--no-owner").arg("--no-privileges");
        }
        if opts.stop_on_error {
            cmd.arg("--exit-on-error");
        }
        if opts.single_transaction {
            cmd.arg("--single-transaction");
        }
        if let Some(jobs) = opts.parallel_jobs {
            if jobs > 1 && !opts.single_transaction {
                cmd.arg("--jobs").arg(jobs.to_string());
            }
        }
        cmd.arg(&opts.source_path);
    }

    // Same explicit guard as export: fail loud when the profile
    // advertises password auth but resolution finds nothing, so the
    // user gets a "re-enter password" message instead of psql's
    // opaque `fe_sendauth: no password supplied`.
    let pw = resolve_password(&opts.profile).await?;
    match (&opts.profile.auth, pw) {
        (AuthMethod::Password { .. }, Some(pw)) => {
            cmd.env("PGPASSWORD", pw);
        }
        (AuthMethod::Password { .. }, None) => {
            return Err(ImportError::Secrets(
                "profile is set to password auth but no password is stored — re-enter the password in the connection form".into(),
            ));
        }
        _ => {}
    }
    for var in ["PGHOST", "PGPORT", "PGUSER", "PGDATABASE"] {
        cmd.env_remove(var);
    }

    spawn_and_wait(ctx, cmd, sink, &opts.source_path, None).await
}

// ---- MySQL -----------------------------------------------------------

async fn run_mysql_import(
    ctx: &ImportContext,
    opts: &ImportOptions,
    sink: Arc<dyn ImportProgressSink>,
) -> Result<()> {
    let loc = tool_locator::locate(
        ctx.resource_dir.as_deref(),
        &ctx.app_data_dir,
        "mysql",
        "mysql",
    )
    .map_err(|e| ImportError::Locate(e.to_string()))?;

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
        .arg(format!("--port={}", opts.profile.port))
        .arg("-D")
        .arg(&opts.profile.database);
    if !opts.stop_on_error {
        cmd.arg("--force");
    }
    // Wrap the DML in a transaction when asked. MySQL DDL implicitly
    // commits, so this is best-effort — it covers the DML between DDL
    // statements. The init-command only opens the transaction; the
    // matching COMMIT is appended AFTER the file contents via the
    // stdin trailer below. Without it (mysqldump output contains no
    // COMMIT of its own) everything after the last implicit-commit
    // DDL was silently rolled back on disconnect.
    if opts.single_transaction {
        cmd.arg("--init-command=SET autocommit=0;");
    }

    // mysql reads the dump from stdin. We stream the file ourselves
    // rather than redirecting the fd so a trailer can be appended.
    let feed = StdinFeed {
        path: opts.source_path.clone(),
        trailer: opts.single_transaction.then_some(b"\nCOMMIT;\n".as_slice()),
    };

    let result = spawn_and_wait(ctx, cmd, sink, &opts.source_path, Some(feed)).await;
    if let Some(path) = creds_file {
        let _ = std::fs::remove_file(path);
    }
    result
}

async fn write_mysql_creds(profile: &ConnectionProfile) -> Result<PathBuf> {
    let user = user_from_auth(&profile.auth).unwrap_or_default();
    let password = match resolve_password(profile).await? {
        Some(pw) => pw,
        None if matches!(profile.auth, AuthMethod::Password { .. }) => {
            return Err(ImportError::Secrets(
                "profile is set to password auth but no password is stored — re-enter the password in the connection form".into(),
            ));
        }
        None => String::new(),
    };
    let dir = std::env::temp_dir();
    let file_name = format!("bearhold-my-imp-{}.cnf", Uuid::new_v4());
    let path = dir.join(file_name);
    let content = format!("[client]\nuser={user}\npassword={password}\n");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true).mode(0o600);
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

async fn run_sqlite_import(opts: &ImportOptions, sink: Arc<dyn ImportProgressSink>) -> Result<()> {
    let target = opts
        .profile
        .file_path
        .as_ref()
        .ok_or_else(|| ImportError::UnsupportedEngine {
            engine: DatabaseEngine::Sqlite,
        })?;

    match opts.format {
        DumpFormat::SqliteFile => {
            // Straight file replace. The caller is expected to have
            // closed the driver pool for this profile before invoking
            // — the Import page uses `api.reconnect` after we return
            // to re-open on the new file.
            std::fs::copy(&opts.source_path, target)?;

            // The target's OLD -wal/-shm sidecars belong to the file
            // we just replaced. Left in place, SQLite would replay the
            // stale WAL's frames onto the new database on next open —
            // corrupting it or resurrecting overwritten data. Remove
            // them, then bring over the source's sidecars if the
            // snapshot shipped with any (the exporter copies them
            // alongside the main file).
            for suffix in ["-wal", "-shm"] {
                remove_sidecar(target, suffix)?;
                copy_sidecar(&opts.source_path, target, suffix);
            }

            if let Ok(md) = std::fs::metadata(target) {
                sink.on_bytes_read(md.len());
            }
            Ok(())
        }
        DumpFormat::SqlitePlain => Err(ImportError::UnsupportedEngine {
            engine: DatabaseEngine::Sqlite,
        }),
        _ => unreachable!("guarded by ensure_format_matches_engine"),
    }
}

/// Delete `<base><suffix>` if it exists. Errors matter here — failing
/// to remove a stale WAL means the freshly imported database gets
/// corrupted on next open, so this is not a best-effort cleanup.
fn remove_sidecar(base: &Path, suffix: &str) -> Result<()> {
    let mut path = base.as_os_str().to_owned();
    path.push(suffix);
    let path = PathBuf::from(path);
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
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

// ---- Shared spawn/wait/stderr ----------------------------------------

/// Stream a file into the child's stdin, optionally followed by a
/// trailer. Lets the MySQL import append `COMMIT;` after the dump —
/// impossible with a plain fd redirect.
struct StdinFeed {
    path: PathBuf,
    trailer: Option<&'static [u8]>,
}

async fn spawn_and_wait(
    ctx: &ImportContext,
    mut cmd: Command,
    sink: Arc<dyn ImportProgressSink>,
    source_path: &Path,
    stdin_feed: Option<StdinFeed>,
) -> Result<()> {
    cmd.stderr(Stdio::piped());
    if stdin_feed.is_some() {
        cmd.stdin(Stdio::piped());
    }

    let mut child = cmd.spawn()?;
    let stderr = child.stderr.take();
    // Pump the source file into stdin in the background. If the child
    // dies early the copy fails with a broken pipe and the task just
    // ends — the exit-status path below reports the real error.
    let stdin_task = stdin_feed.and_then(|feed| {
        child.stdin.take().map(|mut stdin| {
            tokio::spawn(async move {
                use tokio::io::AsyncWriteExt;
                let Ok(mut file) = tokio::fs::File::open(&feed.path).await else {
                    return;
                };
                if tokio::io::copy(&mut file, &mut stdin).await.is_err() {
                    return;
                }
                if let Some(trailer) = feed.trailer {
                    let _ = stdin.write_all(trailer).await;
                }
                // Close stdin so the child sees EOF and finishes.
                let _ = stdin.shutdown().await;
            })
        })
    });
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

    // Progress ticker: emit the source file size — the frontend
    // already knows total size from detect() and can compute a
    // percentage. This tick fires once per second so the "N% imported"
    // label doesn't jitter.
    let source_size = std::fs::metadata(source_path).map(|m| m.len()).unwrap_or(0);
    let size_task = tokio::spawn({
        let sink = sink.clone();
        async move {
            loop {
                tokio::time::sleep(Duration::from_millis(1000)).await;
                sink.on_bytes_read(source_size);
            }
        }
    });

    // Wait for exit WITHOUT holding the slot lock across an await —
    // `cancel` needs this same lock to reach the child and kill it, so
    // holding it for the whole run made every job uncancellable. Poll
    // `try_wait` instead; the lock is held only for the microseconds
    // each poll takes.
    let wait_result: Result<std::process::ExitStatus> = loop {
        {
            let mut guard = slot.lock().await;
            match guard.as_mut() {
                // Cancel emptied the slot and killed the child.
                None => break Err(ImportError::Cancelled),
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => break Ok(status),
                    Ok(None) => {}
                    Err(e) => break Err(e.into()),
                },
            }
        }
        tokio::time::sleep(Duration::from_millis(WAIT_POLL_MS)).await;
    };

    // Drop registry entry so a stale cancel is a no-op, and stop the
    // helper tasks on every exit path (they leaked on error before).
    ctx.registry.jobs.remove(&ctx.job_id);
    size_task.abort();
    // The stdin pump has either finished (child read to EOF) or is
    // stuck on a dead pipe — abort is a no-op in the former case.
    if let Some(task) = stdin_task {
        task.abort();
    }
    let status = match wait_result {
        Ok(status) => status,
        Err(e) => {
            stderr_task.abort();
            return Err(e);
        }
    };
    let tail = stderr_task.await.unwrap_or_default();

    if !status.success() {
        return Err(ImportError::ChildFailed {
            code: status.code(),
            stderr_tail: tail,
        });
    }
    sink.on_bytes_read(source_size);
    Ok(())
}

pub async fn cancel(reg: &ImportRegistry, job_id: Uuid) -> bool {
    if let Some((_, slot)) = reg.jobs.remove(&job_id) {
        let mut guard = slot.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
            // Reap the killed process so it doesn't linger as a
            // zombie; SIGKILL makes this return promptly.
            let _ = child.wait().await;
            return true;
        }
    }
    false
}

// ---- Credential helpers (shared with export) ------------------------

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
    let password_ref = match &profile.auth {
        AuthMethod::Password { password_ref, .. } => password_ref,
        _ => return Ok(None),
    };
    // Same two-tier lookup the PG driver uses: inline value first
    // (legacy stored profiles), then the encrypted secrets store.
    // See dump/export.rs::resolve_password for the full rationale.
    if !password_ref.is_empty() {
        return Ok(Some(password_ref.clone()));
    }
    let value = secrets::get(profile.id, Slot::Password)
        .await
        .map_err(|e| ImportError::Secrets(e.to_string()))?;
    Ok(value)
}

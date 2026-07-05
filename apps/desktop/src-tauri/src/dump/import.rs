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
    ChildFailed { code: Option<i32>, stderr_tail: String },
    #[error("job cancelled by user")]
    Cancelled,
}

pub type Result<T> = std::result::Result<T, ImportError>;

pub struct ImportContext {
    pub app_data_dir: PathBuf,
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
    let loc = tool_locator::locate(&ctx.app_data_dir, "postgres", tool_name)
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

    spawn_and_wait(ctx, cmd, sink, &opts.source_path).await
}

// ---- MySQL -----------------------------------------------------------

async fn run_mysql_import(
    ctx: &ImportContext,
    opts: &ImportOptions,
    sink: Arc<dyn ImportProgressSink>,
) -> Result<()> {
    let loc = tool_locator::locate(&ctx.app_data_dir, "mysql", "mysql")
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
    // Wrap the whole file in a transaction when asked. MySQL DDL
    // implicitly commits, so a `single_transaction` flag is
    // best-effort — it covers all DML while it lasts. The
    // `SET autocommit=0; ... COMMIT;` init runs before the file
    // contents.
    if opts.single_transaction {
        cmd.arg("--init-command=SET autocommit=0;");
    }

    // mysql reads from stdin. Redirect the source file into it.
    let source = std::fs::File::open(&opts.source_path)?;
    cmd.stdin(Stdio::from(source));

    let result = spawn_and_wait(ctx, cmd, sink, &opts.source_path).await;
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

async fn run_sqlite_import(
    opts: &ImportOptions,
    sink: Arc<dyn ImportProgressSink>,
) -> Result<()> {
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

// ---- Shared spawn/wait/stderr ----------------------------------------

async fn spawn_and_wait(
    ctx: &ImportContext,
    mut cmd: Command,
    sink: Arc<dyn ImportProgressSink>,
    source_path: &Path,
) -> Result<()> {
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn()?;
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

    let status = {
        let mut guard = slot.lock().await;
        let child = guard.as_mut().ok_or(ImportError::Cancelled)?;
        child.wait().await?
    };
    ctx.registry.jobs.remove(&ctx.job_id);
    size_task.abort();
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

//! Live export/import round-trip tests against the docker test matrix.
//!
//! Ignored by default (they need docker DBs + CLI tools). Run with:
//!
//!   docker compose -f infra/test/docker-compose.yml up -d pg16
//!   cargo test -p dbstudio-desktop --test dump_roundtrip -- --ignored
//!
//! The PG tests use whatever pg_dump/psql/pg_restore the tool locator
//! finds (bundled → cache → PATH) — same resolution as production.

use std::sync::Arc;

use dbstudio_core::{AuthMethod, ConnectionProfile, DatabaseEngine, Driver, QueryRequest, TlsMode};
use dbstudio_desktop_lib::dump::export::{
    run_export, ExportContext, ExportFormat, ExportOptions, ExportProgressSink, ExportRegistry,
};
use dbstudio_desktop_lib::dump::import::{
    run_import, ImportContext, ImportOptions, ImportProgressSink, ImportRegistry,
};
use dbstudio_desktop_lib::dump::detect;
use uuid::Uuid;

struct NullSink;
impl ExportProgressSink for NullSink {
    fn on_stderr(&self, _line: &str) {}
    fn on_bytes_written(&self, _bytes: u64) {}
}
impl ImportProgressSink for NullSink {
    fn on_stderr(&self, _line: &str) {}
    fn on_bytes_read(&self, _bytes: u64) {}
}

fn pg_profile(database: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: Uuid::new_v4(),
        name: format!("e2e-{database}"),
        engine: DatabaseEngine::Postgres,
        host: "127.0.0.1".into(),
        port: 5416,
        database: database.into(),
        auth: AuthMethod::Password {
            username: "dbstudio".into(),
            password_ref: "dbstudio_test".into(),
        },
        tls: TlsMode::Prefer,
        ssh_tunnel: None,
        options: Default::default(),
        file_path: None,
    }
}

async fn pg_exec(profile: &ConnectionProfile, sql: &str) {
    let driver = dbstudio_driver_postgres::PostgresDriver::new();
    driver
        .execute(
            profile,
            QueryRequest {
                sql: sql.to_string(),
                params: vec![],
                limit: None,
                query_id: None,
            },
        )
        .await
        .unwrap_or_else(|e| panic!("SQL failed ({sql}): {e}"));
}

async fn pg_scalar_i64(profile: &ConnectionProfile, sql: &str) -> i64 {
    let driver = dbstudio_driver_postgres::PostgresDriver::new();
    let r = driver
        .execute(
            profile,
            QueryRequest {
                sql: sql.to_string(),
                params: vec![],
                limit: None,
                query_id: None,
            },
        )
        .await
        .expect("scalar query");
    r.rows[0][0]
        .as_i64()
        .or_else(|| r.rows[0][0].as_str().and_then(|s| s.parse().ok()))
        .expect("integer scalar")
}

async fn seed_pg(db: &str) -> ConnectionProfile {
    let admin = pg_profile("shop");
    pg_exec(&admin, &format!("DROP DATABASE IF EXISTS {db}")).await;
    pg_exec(&admin, &format!("CREATE DATABASE {db}")).await;
    let p = pg_profile(db);
    pg_exec(
        &p,
        "CREATE TABLE customers (
           id BIGSERIAL PRIMARY KEY,
           email VARCHAR(255) NOT NULL UNIQUE,
           note TEXT,
           balance NUMERIC(12,2) NOT NULL DEFAULT 0
         )",
    )
    .await;
    pg_exec(
        &p,
        "INSERT INTO customers (email, note, balance) VALUES
           ('a@x.com', 'first', 10.50),
           ('b@x.com', NULL, 0),
           ('c@x.com', 'quote '' inside', -3.25),
           ('d@x.com', 'unicode Строганова', 9999999.99)",
    )
    .await;
    p
}

fn export_ctx(tmp: &std::path::Path) -> ExportContext {
    ExportContext {
        app_data_dir: tmp.to_path_buf(),
        resource_dir: None,
        registry: Arc::new(ExportRegistry::new()),
        job_id: Uuid::new_v4(),
        sqlite_driver: Arc::new(dbstudio_driver_sqlite::SqliteDriver::new()),
    }
}

fn import_ctx(tmp: &std::path::Path) -> ImportContext {
    ImportContext {
        app_data_dir: tmp.to_path_buf(),
        resource_dir: None,
        registry: Arc::new(ImportRegistry::new()),
        job_id: Uuid::new_v4(),
    }
}

async fn pg_round_trip(
    format: ExportFormat,
    artifact_name: &str,
    expect_format: detect::DumpFormat,
    db_suffix: &str,
) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let exp_db = format!("e2e_exp_{db_suffix}");
    let imp_db = format!("e2e_imp_{db_suffix}");
    let src = seed_pg(&exp_db).await;
    let out = tmp.path().join(artifact_name);

    let exported = run_export(
        export_ctx(tmp.path()),
        ExportOptions {
            profile: src.clone(),
            output_path: out.clone(),
            format,
            include_schema: true,
            include_data: true,
            tables: vec![],
            drop_before_create: false,
            no_owner: true,
            single_transaction: true,
            parallel_jobs: None,
        },
        Arc::new(NullSink),
    )
    .await
    .expect("export");
    assert!(exported.exists(), "artifact missing");
    assert!(
        std::fs::metadata(&exported).unwrap().len() > 0,
        "artifact empty"
    );

    // Format sniffing must identify our own artifact.
    let detected = detect::probe(&exported).expect("probe").format;
    assert_eq!(detected, expect_format, "detect::probe misidentified the dump");

    // Import into a fresh database.
    let admin = pg_profile("shop");
    pg_exec(&admin, &format!("DROP DATABASE IF EXISTS {imp_db}")).await;
    pg_exec(&admin, &format!("CREATE DATABASE {imp_db}")).await;
    let dst = pg_profile(&imp_db);
    run_import(
        import_ctx(tmp.path()),
        ImportOptions {
            profile: dst.clone(),
            source_path: exported,
            format: detected,
            // pg_dump 17+ writes `SET transaction_timeout` which older
            // servers reject. Continuing past it is the documented
            // recovery (see augment_stderr_hint + the lenient exit
            // handling in import.rs) — and it requires BOTH flags off,
            // since single_transaction makes any error fatal. The row
            // assertions below verify the restore truly landed.
            single_transaction: false,
            stop_on_error: false,
            drop_before_create: false,
            no_owner: true,
            parallel_jobs: None,
        },
        Arc::new(NullSink),
    )
    .await
    .expect("import");

    let n = pg_scalar_i64(&dst, "SELECT COUNT(*) FROM customers").await;
    assert_eq!(n, 4, "row count after restore");
    let neg = pg_scalar_i64(
        &dst,
        "SELECT COUNT(*) FROM customers WHERE balance < 0",
    )
    .await;
    assert_eq!(neg, 1, "negative balance survived round-trip");

    pg_exec(&admin, &format!("DROP DATABASE IF EXISTS {exp_db}")).await;
    pg_exec(&admin, &format!("DROP DATABASE IF EXISTS {imp_db}")).await;
}

#[tokio::test]
#[ignore = "needs docker pg16 + pg_dump/psql on PATH"]
async fn pg_plain_export_import_round_trip() {
    pg_round_trip(ExportFormat::PgPlain, "dump.sql", detect::DumpFormat::PgPlain, "plain").await;
}

#[tokio::test]
#[ignore = "needs docker pg16 + pg_dump/pg_restore on PATH"]
async fn pg_custom_export_import_round_trip() {
    pg_round_trip(ExportFormat::PgCustom, "dump.pgdump", detect::DumpFormat::PgCustom, "custom").await;
}

#[tokio::test]
#[ignore = "needs write access to a temp dir only"]
async fn sqlite_file_copy_round_trip() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let db_path = tmp.path().join("source.db");
    std::fs::write(&db_path, b"").expect("touch");

    let profile = ConnectionProfile {
        id: Uuid::new_v4(),
        name: "e2e-sqlite".into(),
        engine: DatabaseEngine::Sqlite,
        host: String::new(),
        port: 0,
        database: String::new(),
        auth: AuthMethod::None,
        tls: TlsMode::Prefer,
        ssh_tunnel: None,
        options: Default::default(),
        file_path: Some(db_path.clone()),
    };

    let driver = dbstudio_driver_sqlite::SqliteDriver::new();
    driver
        .execute(
            &profile,
            QueryRequest {
                sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);
                      INSERT INTO t (v) VALUES ('one'), ('two');"
                    .into(),
                params: vec![],
                limit: None,
                query_id: None,
            },
        )
        .await
        .expect("seed sqlite");

    let out = tmp.path().join("copy.db");
    run_export(
        ExportContext {
            app_data_dir: tmp.path().to_path_buf(),
            resource_dir: None,
            registry: Arc::new(ExportRegistry::new()),
            job_id: Uuid::new_v4(),
            sqlite_driver: Arc::new(driver),
        },
        ExportOptions {
            profile: profile.clone(),
            output_path: out.clone(),
            format: ExportFormat::SqliteFileCopy,
            include_schema: true,
            include_data: true,
            tables: vec![],
            drop_before_create: false,
            no_owner: true,
            single_transaction: true,
            parallel_jobs: None,
        },
        Arc::new(NullSink),
    )
    .await
    .expect("sqlite export");

    // The copy must itself be a queryable database with the rows.
    let copy_profile = ConnectionProfile {
        id: Uuid::new_v4(),
        file_path: Some(out),
        ..profile
    };
    let driver2 = dbstudio_driver_sqlite::SqliteDriver::new();
    let r = driver2
        .execute(
            &copy_profile,
            QueryRequest {
                sql: "SELECT COUNT(*) FROM t".into(),
                params: vec![],
                limit: None,
                query_id: None,
            },
        )
        .await
        .expect("query copy");
    assert_eq!(r.rows[0][0].as_i64(), Some(2), "copied db row count");
}

#[tokio::test]
#[ignore = "behavior depends on whether mysqldump is installed"]
async fn mysql_export_fails_cleanly_without_tool() {
    let mysqldump_on_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join("mysqldump").is_file()))
        .unwrap_or(false);
    if mysqldump_on_path {
        eprintln!("mysqldump present — skipping the missing-tool assertion");
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let profile = ConnectionProfile {
        id: Uuid::new_v4(),
        name: "e2e-mysql".into(),
        engine: DatabaseEngine::MySql,
        host: "127.0.0.1".into(),
        port: 3380,
        database: "shop".into(),
        auth: AuthMethod::Password {
            username: "dbstudio".into(),
            password_ref: "dbstudio_test".into(),
        },
        tls: TlsMode::Prefer,
        ssh_tunnel: None,
        options: Default::default(),
        file_path: None,
    };
    let err = run_export(
        export_ctx(tmp.path()),
        ExportOptions {
            profile,
            output_path: tmp.path().join("dump.sql"),
            format: ExportFormat::MysqlPlain,
            include_schema: true,
            include_data: true,
            tables: vec![],
            drop_before_create: false,
            no_owner: true,
            single_transaction: true,
            parallel_jobs: None,
        },
        Arc::new(NullSink),
    )
    .await
    .expect_err("export should fail without mysqldump");
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("locate") || msg.contains("not") || msg.contains("mysqldump"),
        "unhelpful missing-tool error: {msg}"
    );
}

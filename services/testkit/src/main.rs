//! Headless test shim over the production drivers.
//!
//! The E2E harness (scripts/test-e2e) drives THIS binary instead of
//! re-implementing database access with node clients — so every test
//! exercises the exact code path the desktop app ships: the Driver
//! trait, connection pooling, statement splitting, introspection and
//! batch apply.
//!
//! Protocol: one JSON request on stdin, one JSON response on stdout.
//!
//!   { "op": "ping" | "server_info" | "schema" | "query" | "apply",
//!     "profile": <ConnectionProfile JSON>,
//!     "sql": "...",              // op=query
//!     "statements": ["...", …],  // op=apply
//!     "limit": 10000 }           // op=query, optional
//!
//! Response: { "ok": <op result> } or { "err": { "code", "message" } }.

use std::io::Read;

use dbstudio_core::{ConnectionProfile, DatabaseEngine, Driver, QueryRequest};
use dbstudio_driver_mysql::MySqlDriver;
use dbstudio_driver_postgres::PostgresDriver;
use dbstudio_driver_sqlite::SqliteDriver;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Request {
    op: String,
    profile: ConnectionProfile,
    #[serde(default)]
    sql: Option<String>,
    #[serde(default)]
    statements: Option<Vec<String>>,
    #[serde(default)]
    limit: Option<u32>,
}

fn driver_for(engine: DatabaseEngine) -> Option<Box<dyn Driver>> {
    match engine {
        DatabaseEngine::Postgres => Some(Box::new(PostgresDriver::new())),
        DatabaseEngine::MySql => Some(Box::new(MySqlDriver::new())),
        DatabaseEngine::Sqlite => Some(Box::new(SqliteDriver::new())),
        _ => None,
    }
}

async fn dispatch(req: Request) -> std::result::Result<Value, dbstudio_core::DbError> {
    let driver = driver_for(req.profile.engine).ok_or_else(|| {
        dbstudio_core::DbError::Unsupported(format!("engine {:?}", req.profile.engine))
    })?;

    match req.op.as_str() {
        "ping" => {
            driver.ping(&req.profile).await?;
            Ok(json!({ "pong": true }))
        }
        "server_info" => {
            let info = driver.server_info(&req.profile).await?;
            Ok(serde_json::to_value(info).expect("serializable"))
        }
        "schema" => {
            let schema = driver.schema(&req.profile).await?;
            Ok(serde_json::to_value(schema).expect("serializable"))
        }
        "query" => {
            let sql = req.sql.unwrap_or_default();
            let result = driver
                .execute(
                    &req.profile,
                    QueryRequest {
                        sql,
                        params: vec![],
                        limit: req.limit,
                        query_id: None,
                    },
                )
                .await?;
            Ok(serde_json::to_value(result).expect("serializable"))
        }
        "apply" => {
            let statements = req.statements.unwrap_or_default();
            let result = driver.apply_batch(&req.profile, statements).await?;
            Ok(serde_json::to_value(result).expect("serializable"))
        }
        other => Err(dbstudio_core::DbError::InvalidInput(format!(
            "unknown op: {other}"
        ))),
    }
}

#[tokio::main]
async fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        print_err("io", "failed to read stdin");
        std::process::exit(2);
    }

    let req: Request = match serde_json::from_str(&input) {
        Ok(r) => r,
        Err(e) => {
            print_err("bad_request", &format!("invalid request JSON: {e}"));
            std::process::exit(2);
        }
    };

    match dispatch(req).await {
        Ok(value) => {
            println!("{}", json!({ "ok": value }));
        }
        Err(e) => {
            print_err(e.code(), &e.to_string());
            std::process::exit(1);
        }
    }
}

fn print_err(code: &str, message: &str) {
    println!("{}", json!({ "err": { "code": code, "message": message } }));
}

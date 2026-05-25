use std::sync::Arc;

use dbstudio_core::{DatabaseEngine, Driver};
use dbstudio_driver_mongodb::MongoDriver;
use dbstudio_driver_mysql::MySqlDriver;
use dbstudio_driver_postgres::PostgresDriver;
use dbstudio_driver_redis::RedisDriver;
use dbstudio_driver_sqlite::SqliteDriver;

/// Shared Tauri state: a registry of drivers, one instance per engine. Each
/// driver owns its own connection pools, keyed by `ConnectionProfile.id`.
///
/// The SQL-shaped drivers (postgres/mysql/sqlite) implement the `Driver`
/// trait and are dispatched through `driver_for`. MongoDB lives alongside
/// them but doesn't implement `Driver` — none of its document operations
/// fit the SQL row/column shape — so it's exposed as its own field for
/// the `mongo_*` commands to call directly.
pub struct AppState {
    pub postgres: Arc<PostgresDriver>,
    pub mysql: Arc<MySqlDriver>,
    pub sqlite: Arc<SqliteDriver>,
    pub mongo: Arc<MongoDriver>,
    pub redis: Arc<RedisDriver>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            postgres: Arc::new(PostgresDriver::new()),
            mysql: Arc::new(MySqlDriver::new()),
            sqlite: Arc::new(SqliteDriver::new()),
            mongo: Arc::new(MongoDriver::new()),
            redis: Arc::new(RedisDriver::new()),
        }
    }

    /// Look up the driver for an engine. Engines without a driver yet return
    /// `None`; commands map this to `DbError::Unsupported`.
    pub fn driver_for(&self, engine: DatabaseEngine) -> Option<Arc<dyn Driver>> {
        match engine {
            DatabaseEngine::Postgres | DatabaseEngine::CockroachDb => {
                Some(self.postgres.clone() as Arc<dyn Driver>)
            }
            DatabaseEngine::MySql | DatabaseEngine::MariaDb => {
                Some(self.mysql.clone() as Arc<dyn Driver>)
            }
            DatabaseEngine::Sqlite => Some(self.sqlite.clone() as Arc<dyn Driver>),
            _ => None,
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

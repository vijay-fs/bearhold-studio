use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseEngine {
    Postgres,
    #[serde(rename = "mysql")]
    MySql,
    Sqlite,
    #[serde(rename = "mongodb")]
    MongoDb,
    Redis,
    Cassandra,
    Neo4j,
    #[serde(rename = "couchdb")]
    CouchDb,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TlsMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

impl Default for TlsMode {
    fn default() -> Self {
        TlsMode::Prefer
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthMethod {
    Password {
        username: String,
        /// Secret reference (e.g. keychain handle). Never the plaintext.
        password_ref: String,
    },
    SshKey {
        username: String,
        key_ref: String,
        passphrase_ref: Option<String>,
    },
    IamAws {
        username: String,
        region: String,
    },
    Vault {
        mount: String,
        role: String,
    },
    /// SQLite, embedded engines, or auth-less connections.
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SshAuth {
    Password { password_ref: String },
    Key { key_ref: String, passphrase_ref: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshTunnel {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    /// SHA256 of the expected host public key. Strict verification is mandatory.
    pub host_key_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    pub id: Uuid,
    pub name: String,
    pub engine: DatabaseEngine,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub tls: TlsMode,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnel>,
    /// Free-form per-driver options (e.g. application_name, schema, sslmode overrides).
    #[serde(default)]
    pub options: std::collections::BTreeMap<String, String>,
    /// Filesystem-only fields, used by SQLite-style engines.
    #[serde(default)]
    pub file_path: Option<PathBuf>,
}

impl ConnectionProfile {
    pub fn new(name: impl Into<String>, engine: DatabaseEngine) -> Self {
        let (default_port, default_db) = match engine {
            DatabaseEngine::Postgres => (5432, "postgres"),
            DatabaseEngine::MySql => (3306, ""),
            DatabaseEngine::MongoDb => (27017, "admin"),
            DatabaseEngine::Redis => (6379, "0"),
            DatabaseEngine::Cassandra => (9042, ""),
            DatabaseEngine::Neo4j => (7687, "neo4j"),
            DatabaseEngine::CouchDb => (5984, ""),
            DatabaseEngine::Sqlite => (0, ""),
        };

        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            engine,
            host: "localhost".to_string(),
            port: default_port,
            database: default_db.to_string(),
            auth: AuthMethod::None,
            tls: TlsMode::default(),
            ssh_tunnel: None,
            options: Default::default(),
            file_path: None,
        }
    }
}

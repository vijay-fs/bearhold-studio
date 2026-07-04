//! dbstudio-core
//!
//! Engine-agnostic domain model and the `Driver` trait that every database
//! driver implements. This crate stays free of HTTP, Tauri, and engine-specific
//! dependencies so it can be embedded anywhere.

pub mod connection;
pub mod driver;
pub mod error;
pub mod query;
pub mod schema;
pub mod secrets;
pub mod server_info;
pub mod ssh_tunnel;

pub use connection::{
    AuthMethod, ConnectionProfile, DatabaseEngine, SshAuth, SshTunnel, TlsMode,
};
pub use driver::{Driver, LintOutcome, LintResult};
pub use error::{DbError, Result};
pub use query::{CellUpdate, QueryRequest, QueryResult, ResultColumn, RowDelete, RowInsert, Value};
pub use schema::{
    Column, ForeignKey, Index, NamedSchema, PrimaryKey, RefAction, Schema, Table, View,
};
pub use server_info::{ServerFlags, ServerInfo};

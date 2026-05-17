use serde::{Deserialize, Serialize};

pub type Value = serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryRequest {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub rows_affected: Option<u64>,
    pub elapsed_ms: u64,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultColumn {
    pub name: String,
    pub data_type: String,
}

/// INSERT a new row. Empty `values` is rejected by drivers — every engine
/// requires at least one column, and a DEFAULT-VALUES row is rarely what
/// the user wants from a row-editor flow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowInsert {
    pub schema: String,
    pub table: String,
    pub values: Vec<(String, Value)>,
}

/// DELETE the row identified by `pk`. Same shape as `CellUpdate`'s pk
/// component so call-sites that build a PK filter can reuse it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowDelete {
    pub schema: String,
    pub table: String,
    pub pk: Vec<(String, Value)>,
}

/// Single-cell UPDATE request emitted by the table-browser grid.
///
/// `pk` is the (column, value) pairs that identify the target row — usually
/// the primary key, but the model accepts any column set so composite-PK
/// tables work the same way. The driver builds:
///
///   UPDATE "<schema>"."<table>" SET "<set_column>" = $1
///   WHERE "<pk[0].col>" = $2 AND "<pk[1].col>" = $3 ...
///
/// All values flow through bound parameters — never interpolated — so the
/// usual SQL-injection class is closed by construction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellUpdate {
    pub schema: String,
    pub table: String,
    pub pk: Vec<(String, Value)>,
    pub set_column: String,
    pub new_value: Value,
}

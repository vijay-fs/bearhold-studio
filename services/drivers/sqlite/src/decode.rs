//! SQLite has dynamic typing — a column's declared affinity ("INTEGER",
//! "TEXT", etc.) is a hint, not a guarantee. We decode using the runtime
//! column type returned by sqlx, falling back to string if a row holds an
//! unexpected type.

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use serde_json::Value;
use sqlx::{sqlite::SqliteRow, Row};

pub fn decode_cell(row: &SqliteRow, idx: usize, type_name: &str) -> Value {
    match type_name {
        "INTEGER" | "BIGINT" | "INT" | "INT4" | "INT8" => opt::<i64>(row, idx)
            .map(|v| Value::Number(v.into()))
            .unwrap_or(Value::Null),

        "REAL" | "DOUBLE" | "FLOAT" => opt::<f64>(row, idx)
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::Null),

        "TEXT" | "VARCHAR" | "CHAR" | "CLOB" => opt::<String>(row, idx)
            .map(Value::String)
            .unwrap_or(Value::Null),

        "BOOLEAN" | "BOOL" => opt::<bool>(row, idx)
            .map(Value::Bool)
            .unwrap_or(Value::Null),

        // SQLite has no native date/time type. Apps typically store as TEXT
        // (ISO-8601) or INTEGER (unix epoch). Try both via sqlx.
        "DATETIME" | "TIMESTAMP" => opt::<NaiveDateTime>(row, idx)
            .map(|t| Value::String(t.to_string()))
            .or_else(|| opt::<DateTime<Utc>>(row, idx).map(|t| Value::String(t.to_rfc3339())))
            .or_else(|| opt::<String>(row, idx).map(Value::String))
            .unwrap_or(Value::Null),
        "DATE" => opt::<NaiveDate>(row, idx)
            .map(|t| Value::String(t.to_string()))
            .or_else(|| opt::<String>(row, idx).map(Value::String))
            .unwrap_or(Value::Null),

        "BLOB" => opt::<Vec<u8>>(row, idx)
            .map(|bytes| match std::str::from_utf8(&bytes) {
                Ok(s) => Value::String(s.to_string()),
                Err(_) => Value::String(format!("0x{}", hex_encode(&bytes))),
            })
            .unwrap_or(Value::Null),

        // SQLite NULLs (column type "NULL") or unknown: try common types,
        // fall back to string.
        _ => opt::<String>(row, idx)
            .map(Value::String)
            .or_else(|| opt::<i64>(row, idx).map(|v| Value::Number(v.into())))
            .or_else(|| {
                opt::<f64>(row, idx)
                    .and_then(serde_json::Number::from_f64)
                    .map(Value::Number)
            })
            .unwrap_or(Value::Null),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn opt<'a, T>(row: &'a SqliteRow, idx: usize) -> Option<T>
where
    T: sqlx::Decode<'a, sqlx::Sqlite> + sqlx::Type<sqlx::Sqlite>,
{
    row.try_get::<Option<T>, _>(idx).ok().flatten()
}

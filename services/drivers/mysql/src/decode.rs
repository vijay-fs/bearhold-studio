//! Generic MySQL -> JSON value decoding for the result grid.

use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde_json::Value;
use sqlx::{mysql::MySqlRow, Row};

pub fn decode_cell(row: &MySqlRow, idx: usize, type_name: &str) -> Value {
    match type_name {
        // ---- integers ---------------------------------------------------
        "TINYINT" => opt::<i8>(row, idx)
            .map(|v| Value::Number((v as i64).into()))
            .unwrap_or(Value::Null),
        "TINYINT UNSIGNED" | "BOOLEAN" => opt::<u8>(row, idx)
            .map(|v| Value::Number((v as u64).into()))
            .unwrap_or(Value::Null),
        "SMALLINT" => opt::<i16>(row, idx)
            .map(|v| Value::Number((v as i64).into()))
            .unwrap_or(Value::Null),
        "SMALLINT UNSIGNED" => opt::<u16>(row, idx)
            .map(|v| Value::Number((v as u64).into()))
            .unwrap_or(Value::Null),
        "MEDIUMINT" | "INT" | "INTEGER" => opt::<i32>(row, idx)
            .map(|v| Value::Number((v as i64).into()))
            .unwrap_or(Value::Null),
        "MEDIUMINT UNSIGNED" | "INT UNSIGNED" => opt::<u32>(row, idx)
            .map(|v| Value::Number((v as u64).into()))
            .unwrap_or(Value::Null),
        "BIGINT" => opt::<i64>(row, idx)
            .map(|v| Value::Number(v.into()))
            .unwrap_or(Value::Null),
        "BIGINT UNSIGNED" => opt::<u64>(row, idx)
            .map(|v| Value::Number(v.into()))
            .unwrap_or(Value::Null),
        "YEAR" => opt::<u16>(row, idx)
            .map(|v| Value::Number((v as u64).into()))
            .unwrap_or(Value::Null),

        // ---- floats / decimals -----------------------------------------
        "FLOAT" => opt::<f32>(row, idx)
            .and_then(|v| serde_json::Number::from_f64(v as f64))
            .map(Value::Number)
            .unwrap_or(Value::Null),
        "DOUBLE" => opt::<f64>(row, idx)
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        "DECIMAL" | "NUMERIC" => opt::<BigDecimal>(row, idx)
            .map(|d| Value::String(d.to_string()))
            .unwrap_or(Value::Null),

        // ---- strings ---------------------------------------------------
        "VARCHAR" | "CHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            opt::<String>(row, idx)
                .map(Value::String)
                .unwrap_or(Value::Null)
        }

        // ---- temporal --------------------------------------------------
        "TIMESTAMP" => opt::<DateTime<Utc>>(row, idx)
            .map(|t| Value::String(t.to_rfc3339()))
            .unwrap_or(Value::Null),
        "DATETIME" => opt::<NaiveDateTime>(row, idx)
            .map(|t| Value::String(t.to_string()))
            .unwrap_or(Value::Null),
        "DATE" => opt::<NaiveDate>(row, idx)
            .map(|t| Value::String(t.to_string()))
            .unwrap_or(Value::Null),
        "TIME" => opt::<NaiveTime>(row, idx)
            .map(|t| Value::String(t.to_string()))
            .unwrap_or(Value::Null),

        // ---- json ------------------------------------------------------
        "JSON" => opt::<Value>(row, idx).unwrap_or(Value::Null),

        // ---- binary ----------------------------------------------------
        "BINARY" | "VARBINARY" | "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
            opt::<Vec<u8>>(row, idx)
                .map(|bytes| match std::str::from_utf8(&bytes) {
                    Ok(s) => Value::String(s.to_string()),
                    Err(_) => Value::String(format!("0x{}", hex_encode(&bytes))),
                })
                .unwrap_or(Value::Null)
        }

        // ---- fallback --------------------------------------------------
        _ => opt::<String>(row, idx)
            .map(Value::String)
            .unwrap_or_else(|| Value::String(format!("(unsupported type {type_name})"))),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn opt<'a, T>(row: &'a MySqlRow, idx: usize) -> Option<T>
where
    T: sqlx::Decode<'a, sqlx::MySql> + sqlx::Type<sqlx::MySql>,
{
    row.try_get::<Option<T>, _>(idx).ok().flatten()
}

//! Generic Postgres -> JSON value decoding for the result grid.
//!
//! We can't statically type-check ad-hoc user SQL, so we dispatch on the
//! column's runtime type name and try the matching Rust type. Anything we
//! don't recognise falls back to a TEXT decode, and beyond that to a
//! placeholder string — better than failing the whole query for one cell.

use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde_json::Value;
use sqlx::{postgres::types::PgInterval, postgres::PgRow, Row};
use uuid::Uuid;

pub fn decode_cell(row: &PgRow, idx: usize, type_name: &str) -> Value {
    match type_name {
        "BOOL" => opt::<bool>(row, idx)
            .map(Value::Bool)
            .unwrap_or(Value::Null),

        "INT2" => opt::<i16>(row, idx)
            .map(|v| Value::Number(v.into()))
            .unwrap_or(Value::Null),
        "INT4" => opt::<i32>(row, idx)
            .map(|v| Value::Number(v.into()))
            .unwrap_or(Value::Null),
        "INT8" => opt::<i64>(row, idx)
            .map(|v| Value::Number(v.into()))
            .unwrap_or(Value::Null),

        "FLOAT4" => opt::<f32>(row, idx)
            .and_then(|v| serde_json::Number::from_f64(v as f64))
            .map(Value::Number)
            .unwrap_or(Value::Null),
        "FLOAT8" => opt::<f64>(row, idx)
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::Null),

        // NUMERIC/DECIMAL are arbitrary precision. We render as a string so
        // we don't lose precision against JSON's f64 limits ($199.00 stays
        // "199.00", not 199 or 199.0000000000001).
        "NUMERIC" => opt::<BigDecimal>(row, idx)
            .map(|d| Value::String(d.to_string()))
            .unwrap_or(Value::Null),

        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CHAR" | "CITEXT" => opt::<String>(row, idx)
            .map(Value::String)
            .unwrap_or(Value::Null),

        "UUID" => opt::<Uuid>(row, idx)
            .map(|u| Value::String(u.to_string()))
            .unwrap_or(Value::Null),

        "TIMESTAMPTZ" => opt::<DateTime<Utc>>(row, idx)
            .map(|t| Value::String(t.to_rfc3339()))
            .unwrap_or(Value::Null),
        "TIMESTAMP" => opt::<NaiveDateTime>(row, idx)
            .map(|t| Value::String(t.to_string()))
            .unwrap_or(Value::Null),
        "DATE" => opt::<NaiveDate>(row, idx)
            .map(|t| Value::String(t.to_string()))
            .unwrap_or(Value::Null),
        "TIME" => opt::<NaiveTime>(row, idx)
            .map(|t| Value::String(t.to_string()))
            .unwrap_or(Value::Null),

        "JSON" | "JSONB" => opt::<Value>(row, idx).unwrap_or(Value::Null),

        // INTERVAL has no fixed length (months can mean 28-31 days), so the
        // text form Postgres uses ("1 year 2 mons 3 days 04:05:06") is the
        // most accurate JSON-safe representation.
        "INTERVAL" => opt::<PgInterval>(row, idx)
            .map(|iv| Value::String(format_interval(&iv)))
            .unwrap_or(Value::Null),

        // Unknown: try string, otherwise emit a typed placeholder.
        _ => opt::<String>(row, idx)
            .map(Value::String)
            .unwrap_or_else(|| Value::String(format!("(unsupported type {type_name})"))),
    }
}

fn opt<'a, T>(row: &'a PgRow, idx: usize) -> Option<T>
where
    T: sqlx::Decode<'a, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
{
    row.try_get::<Option<T>, _>(idx).ok().flatten()
}

/// Render a `PgInterval` the way `psql` does: "1 year 2 mons 3 days 04:05:06".
/// Months/days/microseconds each carry their own sign in PgInterval, so we
/// format every component independently.
fn format_interval(iv: &PgInterval) -> String {
    let mut parts: Vec<String> = Vec::new();

    let years = iv.months / 12;
    let months_rem = iv.months % 12;

    if years != 0 {
        parts.push(format!(
            "{} year{}",
            years,
            if years.abs() == 1 { "" } else { "s" }
        ));
    }
    if months_rem != 0 {
        parts.push(format!(
            "{} mon{}",
            months_rem,
            if months_rem.abs() == 1 { "" } else { "s" }
        ));
    }
    if iv.days != 0 {
        parts.push(format!(
            "{} day{}",
            iv.days,
            if iv.days.abs() == 1 { "" } else { "s" }
        ));
    }
    if iv.microseconds != 0 {
        let neg = iv.microseconds < 0;
        let total = iv.microseconds.unsigned_abs();
        let secs_total = total / 1_000_000;
        let micros = total % 1_000_000;
        let hours = secs_total / 3600;
        let mins = (secs_total % 3600) / 60;
        let secs = secs_total % 60;
        let sign = if neg { "-" } else { "" };
        if micros == 0 {
            parts.push(format!("{sign}{hours:02}:{mins:02}:{secs:02}"));
        } else {
            parts.push(format!("{sign}{hours:02}:{mins:02}:{secs:02}.{micros:06}"));
        }
    }

    if parts.is_empty() {
        "00:00:00".to_string()
    } else {
        parts.join(" ")
    }
}

#[cfg(test)]
mod interval_tests {
    use super::format_interval;
    use sqlx::postgres::types::PgInterval;

    fn iv(months: i32, days: i32, microseconds: i64) -> PgInterval {
        PgInterval {
            months,
            days,
            microseconds,
        }
    }

    #[test]
    fn zero() {
        assert_eq!(format_interval(&iv(0, 0, 0)), "00:00:00");
    }

    #[test]
    fn years_months_days_time() {
        let result = format_interval(&iv(14, 3, (4 * 3600 + 5 * 60 + 6) * 1_000_000));
        assert_eq!(result, "1 year 2 mons 3 days 04:05:06");
    }

    #[test]
    fn singular_unit() {
        assert_eq!(format_interval(&iv(1, 1, 0)), "1 mon 1 day");
    }

    #[test]
    fn fractional_seconds() {
        assert_eq!(format_interval(&iv(0, 0, 1_500_000)), "00:00:01.500000");
    }

    #[test]
    fn negative_time() {
        assert_eq!(format_interval(&iv(0, 0, -3_600_000_000)), "-01:00:00");
    }
}

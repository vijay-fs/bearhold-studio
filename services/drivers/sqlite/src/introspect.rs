//! SQLite schema introspection via `sqlite_master` and PRAGMAs.
//!
//! PRAGMA queries don't accept bind parameters, so table names are
//! interpolated. We source names from `sqlite_master` first, so the strings
//! are trusted (not user input).

use std::collections::BTreeMap;

use dbstudio_core::{
    Column, ForeignKey, Index, NamedSchema, PrimaryKey, RefAction, Result, Schema, Table, View,
};
use sqlx::{Row, SqlitePool};

use crate::map_error::map_sqlx_error;

const SCHEMA_NAME: &str = "main";

pub async fn load_schema(pool: &SqlitePool) -> Result<Schema> {
    let table_names = load_table_names(pool).await?;
    let view_rows = load_views(pool).await?;

    let mut tables: Vec<Table> = Vec::with_capacity(table_names.len());
    for name in &table_names {
        let columns = load_columns(pool, name).await?;
        let pk_columns: Vec<String> = columns
            .iter()
            .filter(|c| c.pk > 0)
            .map(|c| c.name.clone())
            .collect();

        let primary_key = if pk_columns.is_empty() {
            None
        } else {
            Some(PrimaryKey {
                name: format!("{name}_pk"),
                columns: pk_columns,
            })
        };

        let foreign_keys = load_foreign_keys(pool, name).await?;
        let indexes = load_indexes(pool, name).await?;

        tables.push(Table {
            schema: SCHEMA_NAME.to_string(),
            name: name.clone(),
            columns: columns
                .into_iter()
                .map(|c| Column {
                    name: c.name,
                    data_type: if c.type_name.is_empty() {
                        "BLOB".to_string() // SQLite default affinity
                    } else {
                        c.type_name
                    },
                    nullable: c.notnull == 0,
                    default: c.default,
                    position: c.cid as u32 + 1,
                    comment: None,
                    // SQLite has no native enum type — column constraints
                    // implement "enum" semantics via CHECK clauses, which
                    // we don't parse out here.
                    enum_options: None,
                })
                .collect(),
            primary_key,
            foreign_keys,
            indexes,
            comment: None,
        });
    }

    let mut grouped: BTreeMap<String, NamedSchema> = BTreeMap::new();
    grouped.insert(
        SCHEMA_NAME.to_string(),
        NamedSchema {
            name: SCHEMA_NAME.to_string(),
            tables,
            views: view_rows
                .into_iter()
                .map(|(name, sql)| View {
                    schema: SCHEMA_NAME.to_string(),
                    name,
                    columns: vec![],
                    definition: Some(sql),
                })
                .collect(),
        },
    );

    Ok(Schema {
        schemas: grouped.into_values().collect(),
    })
}

async fn load_table_names(pool: &SqlitePool) -> Result<Vec<String>> {
    let rows = sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .fetch_all(pool)
        .await
        .map_err(map_sqlx_error)?;
    Ok(rows.into_iter().map(|r| r.get::<String, _>(0)).collect())
}

async fn load_views(pool: &SqlitePool) -> Result<Vec<(String, String)>> {
    let rows = sqlx::query("SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name")
        .fetch_all(pool)
        .await
        .map_err(map_sqlx_error)?;
    Ok(rows
        .into_iter()
        .map(|r| (r.get::<String, _>(0), r.get::<String, _>(1)))
        .collect())
}

struct ColumnInfo {
    cid: i32,
    name: String,
    type_name: String,
    notnull: i32,
    default: Option<String>,
    pk: i32,
}

async fn load_columns(pool: &SqlitePool, table: &str) -> Result<Vec<ColumnInfo>> {
    let quoted = quote_ident(table);
    let rows = sqlx::query(&format!("PRAGMA table_info({quoted})"))
        .fetch_all(pool)
        .await
        .map_err(map_sqlx_error)?;
    Ok(rows
        .into_iter()
        .map(|r| ColumnInfo {
            cid: r.get(0),
            name: r.get(1),
            type_name: r.get(2),
            notnull: r.get(3),
            default: r.try_get(4).ok(),
            pk: r.get(5),
        })
        .collect())
}

async fn load_foreign_keys(pool: &SqlitePool, table: &str) -> Result<Vec<ForeignKey>> {
    let quoted = quote_ident(table);
    let rows = sqlx::query(&format!("PRAGMA foreign_key_list({quoted})"))
        .fetch_all(pool)
        .await
        .map_err(map_sqlx_error)?;

    // PRAGMA foreign_key_list returns one row per column in a composite FK,
    // grouped by `id`. Fold them.
    let mut by_id: BTreeMap<i64, ForeignKey> = BTreeMap::new();
    for r in rows {
        let id: i64 = r.get(0);
        let ref_table: String = r.get(2);
        let from: String = r.get(3);
        let to: String = r.get(4);
        let on_update: String = r.get(5);
        let on_delete: String = r.get(6);

        let entry = by_id.entry(id).or_insert_with(|| ForeignKey {
            name: format!("{table}_fk_{id}"),
            columns: vec![],
            references_schema: SCHEMA_NAME.to_string(),
            references_table: ref_table.clone(),
            references_columns: vec![],
            on_delete: parse_action(&on_delete),
            on_update: parse_action(&on_update),
        });
        entry.columns.push(from);
        entry.references_columns.push(to);
    }

    Ok(by_id.into_values().collect())
}

async fn load_indexes(pool: &SqlitePool, table: &str) -> Result<Vec<Index>> {
    let quoted = quote_ident(table);
    let list = sqlx::query(&format!("PRAGMA index_list({quoted})"))
        .fetch_all(pool)
        .await
        .map_err(map_sqlx_error)?;

    let mut indexes = Vec::new();
    for r in list {
        let name: String = r.get(1);
        let unique: i32 = r.get(2);
        let origin: String = r.get(3); // 'c' = explicit, 'pk' = primary key, 'u' = unique constraint
        let primary = origin == "pk";

        let info_rows = sqlx::query(&format!(
            "PRAGMA index_info({quoted_name})",
            quoted_name = quote_ident(&name)
        ))
        .fetch_all(pool)
        .await
        .map_err(map_sqlx_error)?;
        let columns: Vec<String> = info_rows
            .into_iter()
            .map(|r| r.get::<String, _>(2))
            .collect();

        indexes.push(Index {
            name,
            columns,
            unique: unique != 0,
            primary,
        });
    }
    Ok(indexes)
}

fn parse_action(s: &str) -> Option<RefAction> {
    match s {
        "NO ACTION" => Some(RefAction::NoAction),
        "RESTRICT" => Some(RefAction::Restrict),
        "CASCADE" => Some(RefAction::Cascade),
        "SET NULL" => Some(RefAction::SetNull),
        "SET DEFAULT" => Some(RefAction::SetDefault),
        _ => None,
    }
}

/// Wrap an identifier in double-quotes, escaping embedded `"` per SQLite rules.
fn quote_ident(name: &str) -> String {
    let escaped = name.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

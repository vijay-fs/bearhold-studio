//! MySQL schema introspection via `information_schema`.
//!
//! Returns the engine-agnostic `Schema` shape so the ER diagram works
//! unchanged. Filters to the currently-selected `database` (MySQL conflates
//! schema and database — there's no cross-database listing).

use std::collections::BTreeMap;

use dbstudio_core::{
    Column, ForeignKey, Index, NamedSchema, PrimaryKey, RefAction, Result, Schema, Table, View,
};
use sqlx::MySqlPool;

use crate::map_error::map_sqlx_error;

pub async fn load_schema(pool: &MySqlPool, database: &str) -> Result<Schema> {
    let columns = load_columns(pool, database).await?;
    let pks = load_primary_keys(pool, database).await?;
    let fks = load_foreign_keys(pool, database).await?;
    let indexes = load_indexes(pool, database).await?;
    let views = load_views(pool, database).await?;

    let mut grouped: BTreeMap<(String, String), Table> = BTreeMap::new();

    for col in columns {
        let key = (col.schema.clone(), col.table.clone());
        grouped
            .entry(key)
            .or_insert_with(|| Table {
                schema: col.schema.clone(),
                name: col.table.clone(),
                columns: vec![],
                primary_key: None,
                foreign_keys: vec![],
                indexes: vec![],
                comment: None,
            })
            .columns
            .push(Column {
                name: col.name,
                data_type: col.data_type,
                nullable: col.nullable,
                default: col.default,
                position: col.position,
                comment: None,
                // MySQL stores enum literals inline in the column
                // type (`enum('a','b','c')`), so the frontend can parse
                // them directly without a side-channel options list.
                enum_options: None,
            });
    }

    for pk in pks {
        if let Some(table) = grouped.get_mut(&(pk.schema, pk.table)) {
            table.primary_key = Some(PrimaryKey {
                name: pk.name,
                columns: pk.columns,
            });
        }
    }

    for fk in fks {
        if let Some(table) = grouped.get_mut(&(fk.schema.clone(), fk.table.clone())) {
            table.foreign_keys.push(ForeignKey {
                name: fk.name,
                columns: fk.columns,
                references_schema: fk.ref_schema,
                references_table: fk.ref_table,
                references_columns: fk.ref_columns,
                on_delete: parse_action(&fk.on_delete),
                on_update: parse_action(&fk.on_update),
            });
        }
    }

    for idx in indexes {
        if let Some(table) = grouped.get_mut(&(idx.schema, idx.table)) {
            table.indexes.push(Index {
                name: idx.name,
                columns: idx.columns,
                unique: idx.unique,
                primary: idx.primary,
            });
        }
    }

    let mut schemas: BTreeMap<String, NamedSchema> = BTreeMap::new();
    for ((schema_name, _), table) in grouped {
        schemas
            .entry(schema_name.clone())
            .or_insert_with(|| NamedSchema {
                name: schema_name,
                tables: vec![],
                views: vec![],
            })
            .tables
            .push(table);
    }
    for v in views {
        schemas
            .entry(v.schema.clone())
            .or_insert_with(|| NamedSchema {
                name: v.schema.clone(),
                tables: vec![],
                views: vec![],
            })
            .views
            .push(View {
                schema: v.schema,
                name: v.name,
                columns: vec![],
                definition: v.definition,
            });
    }

    Ok(Schema {
        schemas: schemas.into_values().collect(),
    })
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

fn split_csv(s: &str) -> Vec<String> {
    s.split(',').map(|p| p.trim().to_string()).collect()
}

// ---- queries ---------------------------------------------------------------

struct ColumnRow {
    schema: String,
    table: String,
    name: String,
    data_type: String,
    nullable: bool,
    default: Option<String>,
    position: u32,
}

async fn load_columns(pool: &MySqlPool, db: &str) -> Result<Vec<ColumnRow>> {
    // information_schema text columns are returned as VARBINARY on MySQL 8+,
    // which sqlx can't decode into String. Force a text conversion via CONVERT.
    let rows = sqlx::query_as::<_, (String, String, String, String, String, Option<String>, u32)>(
        r#"
        SELECT CONVERT(TABLE_SCHEMA   USING utf8mb4) AS TABLE_SCHEMA,
               CONVERT(TABLE_NAME     USING utf8mb4) AS TABLE_NAME,
               CONVERT(COLUMN_NAME    USING utf8mb4) AS COLUMN_NAME,
               CONVERT(COLUMN_TYPE    USING utf8mb4) AS COLUMN_TYPE,
               CONVERT(IS_NULLABLE    USING utf8mb4) AS IS_NULLABLE,
               CONVERT(COLUMN_DEFAULT USING utf8mb4) AS COLUMN_DEFAULT,
               ORDINAL_POSITION
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
        "#,
    )
    .bind(db)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    Ok(rows
        .into_iter()
        .map(
            |(schema, table, name, data_type, is_nullable, default, position)| ColumnRow {
                schema,
                table,
                name,
                data_type,
                nullable: is_nullable == "YES",
                default,
                position,
            },
        )
        .collect())
}

struct PrimaryKeyRow {
    schema: String,
    table: String,
    name: String,
    columns: Vec<String>,
}

async fn load_primary_keys(pool: &MySqlPool, db: &str) -> Result<Vec<PrimaryKeyRow>> {
    let rows = sqlx::query_as::<_, (String, String, String, String)>(
        r#"
        SELECT CONVERT(k.TABLE_SCHEMA    USING utf8mb4) AS TABLE_SCHEMA,
               CONVERT(k.TABLE_NAME      USING utf8mb4) AS TABLE_NAME,
               CONVERT(k.CONSTRAINT_NAME USING utf8mb4) AS CONSTRAINT_NAME,
               CONVERT(
                 GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ',')
                 USING utf8mb4
               ) AS COLS
        FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.TABLE_CONSTRAINTS c
          ON c.CONSTRAINT_NAME   = k.CONSTRAINT_NAME
         AND c.TABLE_SCHEMA      = k.TABLE_SCHEMA
         AND c.TABLE_NAME        = k.TABLE_NAME
        WHERE c.CONSTRAINT_TYPE = 'PRIMARY KEY' AND k.TABLE_SCHEMA = ?
        GROUP BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME
        "#,
    )
    .bind(db)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    Ok(rows
        .into_iter()
        .map(|(schema, table, name, cols)| PrimaryKeyRow {
            schema,
            table,
            name,
            columns: split_csv(&cols),
        })
        .collect())
}

struct ForeignKeyRow {
    schema: String,
    table: String,
    name: String,
    columns: Vec<String>,
    ref_schema: String,
    ref_table: String,
    ref_columns: Vec<String>,
    on_delete: String,
    on_update: String,
}

async fn load_foreign_keys(pool: &MySqlPool, db: &str) -> Result<Vec<ForeignKeyRow>> {
    let rows = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
        ),
    >(
        r#"
        SELECT CONVERT(k.TABLE_SCHEMA            USING utf8mb4) AS TABLE_SCHEMA,
               CONVERT(k.TABLE_NAME              USING utf8mb4) AS TABLE_NAME,
               CONVERT(k.CONSTRAINT_NAME         USING utf8mb4) AS CONSTRAINT_NAME,
               CONVERT(
                 GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ',')
                 USING utf8mb4
               ) AS COLS,
               CONVERT(k.REFERENCED_TABLE_SCHEMA USING utf8mb4) AS REF_SCHEMA,
               CONVERT(k.REFERENCED_TABLE_NAME   USING utf8mb4) AS REF_TABLE,
               CONVERT(
                 GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ',')
                 USING utf8mb4
               ) AS REF_COLS,
               CONVERT(rc.DELETE_RULE USING utf8mb4) AS DELETE_RULE,
               CONVERT(rc.UPDATE_RULE USING utf8mb4) AS UPDATE_RULE
        FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
          ON rc.CONSTRAINT_NAME   = k.CONSTRAINT_NAME
         AND rc.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
        WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
        GROUP BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME,
                 k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME,
                 rc.DELETE_RULE, rc.UPDATE_RULE
        "#,
    )
    .bind(db)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    Ok(rows
        .into_iter()
        .map(
            |(schema, table, name, cols, ref_schema, ref_table, ref_cols, on_delete, on_update)| {
                ForeignKeyRow {
                    schema,
                    table,
                    name,
                    columns: split_csv(&cols),
                    ref_schema,
                    ref_table,
                    ref_columns: split_csv(&ref_cols),
                    on_delete,
                    on_update,
                }
            },
        )
        .collect())
}

struct IndexRow {
    schema: String,
    table: String,
    name: String,
    columns: Vec<String>,
    unique: bool,
    primary: bool,
}

async fn load_indexes(pool: &MySqlPool, db: &str) -> Result<Vec<IndexRow>> {
    // STATISTICS.NON_UNIQUE: 0 = unique, 1 = non-unique. We flip it.
    let rows = sqlx::query_as::<_, (String, String, String, String, i64)>(
        r#"
        SELECT CONVERT(TABLE_SCHEMA USING utf8mb4) AS TABLE_SCHEMA,
               CONVERT(TABLE_NAME   USING utf8mb4) AS TABLE_NAME,
               CONVERT(INDEX_NAME   USING utf8mb4) AS INDEX_NAME,
               CONVERT(
                 GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',')
                 USING utf8mb4
               ) AS COLS,
               MAX(NON_UNIQUE) AS NON_UNIQUE
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?
        GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME
        "#,
    )
    .bind(db)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    Ok(rows
        .into_iter()
        .map(|(schema, table, name, cols, non_unique)| IndexRow {
            schema,
            table,
            primary: name == "PRIMARY",
            unique: non_unique == 0,
            name,
            columns: split_csv(&cols),
        })
        .collect::<Vec<_>>())
}

struct ViewRow {
    schema: String,
    name: String,
    definition: Option<String>,
}

async fn load_views(pool: &MySqlPool, db: &str) -> Result<Vec<ViewRow>> {
    let rows = sqlx::query_as::<_, (String, String, String)>(
        r#"
        SELECT CONVERT(TABLE_SCHEMA    USING utf8mb4) AS TABLE_SCHEMA,
               CONVERT(TABLE_NAME      USING utf8mb4) AS TABLE_NAME,
               CONVERT(VIEW_DEFINITION USING utf8mb4) AS VIEW_DEFINITION
        FROM information_schema.VIEWS
        WHERE TABLE_SCHEMA = ?
        "#,
    )
    .bind(db)
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    Ok(rows
        .into_iter()
        .map(|(schema, name, definition)| ViewRow {
            schema,
            name,
            definition: Some(definition),
        })
        .collect())
}

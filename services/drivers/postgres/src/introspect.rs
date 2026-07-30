//! Schema introspection. Reads `information_schema` + `pg_catalog` and produces
//! the engine-agnostic `Schema` shape that feeds the ER diagram view.

use std::collections::BTreeMap;

use dbstudio_core::{
    Column, ForeignKey, Index, NamedSchema, PrimaryKey, RefAction, Result, Schema, Table, View,
};
use sqlx::PgPool;

use crate::map_error::map_sqlx_error;

pub async fn load_schema(pool: &PgPool) -> Result<Schema> {
    let columns = load_columns(pool).await?;
    let pks = load_primary_keys(pool).await?;
    let fks = load_foreign_keys(pool).await?;
    let indexes = load_indexes(pool).await?;
    let views = load_views(pool).await?;
    // Map of (enum_schema, enum_type_name) -> options, used to resolve
    // user-defined enum columns into their value lists. Empty on databases
    // that don't define any enum types.
    let enums = load_enum_types(pool).await?;

    // Group everything by (schema, table). BTreeMap so order is stable.
    let mut grouped: BTreeMap<(String, String), Table> = BTreeMap::new();

    for col in columns {
        let key = (col.schema.clone(), col.table.clone());
        // `information_schema.columns.data_type` returns "USER-DEFINED" for
        // every column whose type isn't a SQL built-in (enums, domains,
        // composite types). For an enum, the real type name lives in
        // `udt_name`, and we resolve its options via pg_enum. Replace the
        // unhelpful "USER-DEFINED" with the actual type name so the user
        // sees `mood` instead of a placeholder.
        let (data_type, enum_options) = if col.data_type.eq_ignore_ascii_case("USER-DEFINED") {
            let udt_key = (col.udt_schema.clone(), col.udt_name.clone());
            let options = enums.get(&udt_key).cloned();
            (col.udt_name.clone(), options)
        } else {
            (col.data_type, None)
        };

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
                data_type,
                nullable: col.nullable,
                default: col.default,
                position: col.position,
                comment: None,
                enum_options,
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
                on_delete: fk.on_delete.and_then(parse_ref_action),
                on_update: fk.on_update.and_then(parse_ref_action),
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

    // Bucket tables by schema name.
    let mut schemas: BTreeMap<String, NamedSchema> = BTreeMap::new();
    for ((schema_name, _), table) in grouped {
        schemas
            .entry(schema_name.clone())
            .or_insert_with(|| NamedSchema {
                name: schema_name.clone(),
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

fn parse_ref_action(s: String) -> Option<RefAction> {
    match s.as_str() {
        "a" => Some(RefAction::NoAction),
        "r" => Some(RefAction::Restrict),
        "c" => Some(RefAction::Cascade),
        "n" => Some(RefAction::SetNull),
        "d" => Some(RefAction::SetDefault),
        _ => None,
    }
}

struct ColumnRow {
    schema: String,
    table: String,
    name: String,
    data_type: String,
    nullable: bool,
    default: Option<String>,
    position: u32,
    /// Underlying type schema (e.g. `public`) — same as `data_type` for
    /// built-ins, but for `USER-DEFINED` columns this points at where the
    /// custom type lives so we can join with pg_enum.
    udt_schema: String,
    /// Underlying type name (e.g. `mood` for `CREATE TYPE mood AS ENUM`).
    udt_name: String,
}

async fn load_columns(pool: &PgPool) -> Result<Vec<ColumnRow>> {
    let rows = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            String,
            Option<String>,
            i32,
            String,
            String,
        ),
    >(
        r#"
        SELECT c.table_schema, c.table_name, c.column_name, c.data_type,
               c.is_nullable, c.column_default, c.ordinal_position,
               c.udt_schema, c.udt_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema
         AND t.table_name   = c.table_name
        -- information_schema.columns lists VIEW columns too; without
        -- this filter every view is also introspected as a table
        -- (duplicated in the ER diagram, double-emitted by the diff).
        WHERE t.table_type = 'BASE TABLE'
          AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY c.table_schema, c.table_name, c.ordinal_position
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    Ok(rows
        .into_iter()
        .map(
            |(
                schema,
                table,
                name,
                data_type,
                is_nullable,
                default,
                position,
                udt_schema,
                udt_name,
            )| ColumnRow {
                schema,
                table,
                name,
                data_type,
                nullable: is_nullable == "YES",
                default,
                position: position as u32,
                udt_schema,
                udt_name,
            },
        )
        .collect())
}

/// Read every user-defined enum type into a `(schema, type_name) -> labels`
/// map. The labels come back in `enumsortorder` so the UI shows them in
/// the same order the developer declared them with `CREATE TYPE`. Returns
/// an empty map when the database has no enums.
async fn load_enum_types(pool: &PgPool) -> Result<BTreeMap<(String, String), Vec<String>>> {
    let rows = sqlx::query_as::<_, (String, String, String)>(
        r#"
        SELECT n.nspname AS schema,
               t.typname AS name,
               e.enumlabel AS label
        FROM pg_type t
        JOIN pg_enum e      ON e.enumtypid = t.oid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY n.nspname, t.typname, e.enumsortorder
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    let mut out: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    for (schema, name, label) in rows {
        out.entry((schema, name)).or_default().push(label);
    }
    Ok(out)
}

struct PrimaryKeyRow {
    schema: String,
    table: String,
    name: String,
    columns: Vec<String>,
}

async fn load_primary_keys(pool: &PgPool) -> Result<Vec<PrimaryKeyRow>> {
    let rows = sqlx::query_as::<_, (String, String, String, Vec<String>)>(
        r#"
        SELECT n.nspname AS schema,
               t.relname AS table,
               c.conname AS name,
               array_agg(a.attname ORDER BY array_position(c.conkey, a.attnum)) AS columns
        FROM pg_constraint c
        JOIN pg_class t      ON t.oid = c.conrelid
        JOIN pg_namespace n  ON n.oid = t.relnamespace
        JOIN pg_attribute a  ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'p'
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        GROUP BY n.nspname, t.relname, c.conname
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    Ok(rows
        .into_iter()
        .map(|(schema, table, name, columns)| PrimaryKeyRow {
            schema,
            table,
            name,
            columns,
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
    on_delete: Option<String>,
    on_update: Option<String>,
}

async fn load_foreign_keys(pool: &PgPool) -> Result<Vec<ForeignKeyRow>> {
    let rows = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            Vec<String>,
            String,
            String,
            Vec<String>,
            String,
            String,
        ),
    >(
        r#"
        SELECT
          n.nspname  AS schema,
          t.relname  AS table,
          c.conname  AS name,
          (SELECT array_agg(a.attname ORDER BY array_position(c.conkey, a.attnum))
             FROM pg_attribute a
             WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)) AS columns,
          fn.nspname AS ref_schema,
          ft.relname AS ref_table,
          (SELECT array_agg(a.attname ORDER BY array_position(c.confkey, a.attnum))
             FROM pg_attribute a
             WHERE a.attrelid = c.confrelid AND a.attnum = ANY(c.confkey)) AS ref_columns,
          c.confdeltype::text AS on_delete,
          c.confupdtype::text AS on_update
        FROM pg_constraint c
        JOIN pg_class t      ON t.oid = c.conrelid
        JOIN pg_namespace n  ON n.oid = t.relnamespace
        JOIN pg_class ft     ON ft.oid = c.confrelid
        JOIN pg_namespace fn ON fn.oid = ft.relnamespace
        WHERE c.contype = 'f'
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    Ok(rows
        .into_iter()
        .map(
            |(
                schema,
                table,
                name,
                columns,
                ref_schema,
                ref_table,
                ref_columns,
                on_delete,
                on_update,
            )| ForeignKeyRow {
                schema,
                table,
                name,
                columns,
                ref_schema,
                ref_table,
                ref_columns,
                on_delete: Some(on_delete),
                on_update: Some(on_update),
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

async fn load_indexes(pool: &PgPool) -> Result<Vec<IndexRow>> {
    let rows = sqlx::query_as::<_, (String, String, String, Vec<String>, bool, bool)>(
        r#"
        SELECT n.nspname AS schema,
               t.relname AS table,
               i.relname AS name,
               array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) AS columns,
               ix.indisunique  AS unique,
               ix.indisprimary AS primary
        FROM pg_index ix
        JOIN pg_class t      ON t.oid = ix.indrelid
        JOIN pg_class i      ON i.oid = ix.indexrelid
        JOIN pg_namespace n  ON n.oid = t.relnamespace
        JOIN pg_attribute a  ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        GROUP BY n.nspname, t.relname, i.relname, ix.indisunique, ix.indisprimary
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    Ok(rows
        .into_iter()
        .map(|(schema, table, name, columns, unique, primary)| IndexRow {
            schema,
            table,
            name,
            columns,
            unique,
            primary,
        })
        .collect())
}

struct ViewRow {
    schema: String,
    name: String,
    definition: Option<String>,
}

async fn load_views(pool: &PgPool) -> Result<Vec<ViewRow>> {
    let rows = sqlx::query_as::<_, (String, String, Option<String>)>(
        r#"
        SELECT table_schema, table_name, view_definition
        FROM information_schema.views
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(map_sqlx_error)?;

    Ok(rows
        .into_iter()
        .map(|(schema, name, definition)| ViewRow {
            schema,
            name,
            definition,
        })
        .collect())
}

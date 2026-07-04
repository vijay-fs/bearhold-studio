// TypeScript mirror of services/core/src/schema.rs. Keep in sync — the Rust
// side is authoritative. These are the shapes returned by the `get_schema`
// Tauri command and by the cloud API's /api/v1/connections/schema route.

export type RefAction = 'no_action' | 'restrict' | 'cascade' | 'set_null' | 'set_default';

export interface Column {
  name: string;
  data_type: string;
  nullable: boolean;
  default?: string | null;
  position: number;
  comment?: string | null;
  /** Set when the column has a fixed list of allowed string values
   *  (Postgres user-defined enum). Drives the Insert dialog's enum
   *  picker. MySQL enum columns leave this undefined — their options
   *  can be parsed out of `data_type` directly. */
  enum_options?: string[] | null;
}

export interface PrimaryKey {
  name: string;
  columns: string[];
}

export interface ForeignKey {
  name: string;
  columns: string[];
  references_schema: string;
  references_table: string;
  references_columns: string[];
  on_delete?: RefAction | null;
  on_update?: RefAction | null;
}

export interface Index {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface Table {
  schema: string;
  name: string;
  columns: Column[];
  primary_key?: PrimaryKey | null;
  foreign_keys: ForeignKey[];
  indexes: Index[];
  comment?: string | null;
}

export interface View {
  schema: string;
  name: string;
  columns: Column[];
  definition?: string | null;
}

export interface NamedSchema {
  name: string;
  tables: Table[];
  views: View[];
}

export interface Schema {
  schemas: NamedSchema[];
}

export function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

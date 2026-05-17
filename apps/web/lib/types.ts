// TypeScript mirrors of services/core/src/*. Authoritative source is Rust;
// keep these in sync when the Rust side changes.

export type DatabaseEngine =
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'sqlite'
  | 'mongodb'
  | 'redis'
  | 'cassandra'
  | 'neo4j'
  | 'cockroachdb'
  | 'couchdb';

export type TlsMode = 'disable' | 'prefer' | 'require' | 'verify_ca' | 'verify_full';

export type AuthMethod =
  | { kind: 'password'; username: string; password_ref: string }
  | { kind: 'ssh_key'; username: string; key_ref: string; passphrase_ref?: string | null }
  | { kind: 'iam_aws'; username: string; region: string }
  | { kind: 'vault'; mount: string; role: string }
  | { kind: 'none' };

export type SshAuth =
  | { kind: 'password'; password_ref: string }
  | { kind: 'key'; key_ref: string; passphrase_ref?: string | null };

export interface SshTunnel {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  host_key_fingerprint?: string | null;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  database: string;
  auth: AuthMethod;
  tls?: TlsMode;
  ssh_tunnel?: SshTunnel | null;
  options?: Record<string, string>;
  file_path?: string | null;
}

export interface QueryRequest {
  sql: string;
  params?: unknown[];
  limit?: number | null;
}

export interface ResultColumn {
  name: string;
  data_type: string;
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: unknown[][];
  rows_affected?: number | null;
  elapsed_ms: number;
  truncated: boolean;
}

export interface CellUpdate {
  schema: string;
  table: string;
  /** Tuples of [column_name, current_value] that identify the target row. */
  pk: Array<[string, unknown]>;
  set_column: string;
  new_value: unknown;
}

export interface RowInsert {
  schema: string;
  table: string;
  /** Tuples of [column_name, value]. Omit columns that should take their
   *  default (auto-increment PK, NOW(), etc.). */
  values: Array<[string, unknown]>;
}

export interface RowDelete {
  schema: string;
  table: string;
  pk: Array<[string, unknown]>;
}

export interface CommandError {
  code: string;
  message: string;
}

export const ENGINE_LABELS: Record<DatabaseEngine, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  sqlite: 'SQLite',
  mongodb: 'MongoDB',
  redis: 'Redis',
  cassandra: 'Cassandra',
  neo4j: 'Neo4j',
  cockroachdb: 'CockroachDB',
  couchdb: 'CouchDB',
};

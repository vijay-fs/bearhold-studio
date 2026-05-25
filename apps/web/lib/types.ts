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
  /** Optional UUID the frontend mints per Run. Drivers register the
   *  underlying backend PID / connection id against this token so a
   *  sibling `cancelQuery` call can target it. */
  query_id?: string;
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

// ---- MongoDB ----
// Mongo is a document store, not row/column. These wire types are
// returned by `mongo_*` Tauri commands and consumed by the
// `/connections/[id]/mongo` workspace.

export interface MongoFindRequest {
  database: string;
  collection: string;
  /** MongoDB filter document (`{}` for "all"). Extended-JSON `$oid` is
   *  parsed into ObjectId server-side. */
  filter?: Record<string, unknown> | null;
  /** Sort document. Same shape as Mongo's native sort spec
   *  (`{ field: 1 }` ascending, `-1` descending). */
  sort?: Record<string, unknown> | null;
  /** Projection — pick which fields come back. */
  projection?: Record<string, unknown> | null;
  limit?: number | null;
  skip?: number | null;
}

export interface MongoFindResponse {
  /** Documents in MongoDB extended-JSON form. ObjectId, Date etc. appear
   *  as `{"$oid": "..."}` / `{"$date": "..."}` so they round-trip
   *  losslessly through JSON.parse. */
  documents: Array<Record<string, unknown>>;
  /** Approximate total document count from `estimated_document_count`.
   *  Always labeled as approximate in the UI. */
  approx_total: number;
  elapsed_ms: number;
}

// ---- Redis ----
// Type-tagged value union mirroring the Rust `RedisValue` enum. Each
// shape carries the metadata its viewer needs (total length for
// truncation hints, scores for sorted sets, etc.) so the keyspace
// browser can render the right control without a second round-trip.

export type RedisValue =
  | { kind: 'none' }
  | { kind: 'string'; value: string }
  | { kind: 'list'; items: string[]; total: number }
  | { kind: 'set'; members: string[]; total: number }
  | { kind: 'hash'; fields: Record<string, string>; total: number }
  | { kind: 'sorted_set'; items: Array<[string, number]>; total: number }
  | { kind: 'stream' }
  | { kind: 'unknown'; type_name: string };

export interface RedisKeyEntry {
  key: string;
  /** Redis's own type label: string / list / set / hash / zset / stream / none. */
  type_name: string;
  /** Seconds until expiry. -1 = no expiry, -2 = missing key. */
  ttl_seconds: number | null;
}

export interface RedisKeyDetails {
  key: string;
  type_name: string;
  ttl_seconds: number | null;
  value: RedisValue;
}

export interface RedisScanRequest {
  /** Pass 0 (or omit) for the first call; then the server-returned
   *  cursor for subsequent pages. 0 in the response means we walked
   *  the full keyspace under the current pattern. */
  cursor?: number | null;
  /** Glob pattern. Defaults to `*` server-side when omitted. */
  match_pattern?: string | null;
  /** SCAN COUNT hint. Capped at 1000 server-side. */
  count?: number | null;
}

export interface RedisScanResponse {
  keys: RedisKeyEntry[];
  next_cursor: number;
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

// Unified API client. In desktop, calls Tauri commands. In web (SaaS),
// calls the Axum server. Both surfaces return the same shapes.

import type { Schema } from '@dbstudio/erd';

import { isDesktop } from './runtime';
import type {
  CellUpdate,
  CommandError,
  ConnectionProfile,
  DatabaseEngine,
  MongoFindRequest,
  MongoFindResponse,
  RedisKeyDetails,
  RedisScanRequest,
  RedisScanResponse,
  QueryRequest,
  QueryResult,
  RowDelete,
  RowInsert,
} from './types';
import type {
  DumpProbe,
  ExportOptions,
  ExportResult,
  ImportOptions,
  ImportResult,
  ToolBundleStatus,
} from './tools';

const API_BASE = process.env.NEXT_PUBLIC_DBSTUDIO_API ?? 'http://localhost:8080/api/v1';

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (isDesktop()) {
    const tauri = await import('@tauri-apps/api/core');
    return tauri.invoke<T>(cmd, args);
  }
  throw {
    code: 'desktop_only',
    message: `${cmd} is only available in the desktop app for Phase 1.`,
  } as CommandError;
}

export type SecretSlot =
  | 'password'
  | 'ssh_passphrase'
  | 'ssh_tunnel_passphrase'
  | 'ssh_tunnel_password';

export const api = {
  listEngines(): Promise<DatabaseEngine[]> {
    return invoke('list_engines', {});
  },

  testConnection(profile: ConnectionProfile): Promise<null> {
    return invoke('test_connection', { profile });
  },

  getSchema(profile: ConnectionProfile): Promise<Schema> {
    return invoke('get_schema', { profile });
  },

  /** Returns `{ major, minor, raw, flags }` — the frontend's engine
   *  capability model consumes major/minor to gate modern SQL syntax
   *  (IF NOT EXISTS, RETURNING, ON CONFLICT). Rejects with
   *  Unsupported on NoSQL engines; callers should tolerate that. */
  getServerInfo(profile: ConnectionProfile): Promise<{
    major: number | null;
    minor: number | null;
    raw: string;
    flags: { no_backslash_escapes?: boolean };
  }> {
    return invoke('get_server_info', { profile });
  },

  /** Dry-run a batch of SQL statements against the target without
   *  persisting effects. Returns one outcome per input statement:
   *    - `ok` — server accepted the statement in a rolled-back /
   *      parse-only context.
   *    - `fail` — server rejected with an error string.
   *    - `unverifiable` — engine can't safely dry-run this statement
   *      shape (MySQL DDL is the primary case). The UI shows a
   *      "will validate on Apply" note instead of a green check. */
  dryRunStatements(
    profile: ConnectionProfile,
    statements: string[],
  ): Promise<
    Array<{
      index: number;
      outcome:
        | { kind: 'ok' }
        | { kind: 'fail'; error: string }
        | { kind: 'unverifiable'; reason: string };
    }>
  > {
    return invoke('dry_run_statements', { profile, statements });
  },

  /** Apply a batch of SQL statements atomically. On PG/SQLite the
   *  whole batch is one transaction — failure means nothing lands.
   *  On MySQL a pure-DML batch is atomic; DDL batches run one-by-one
   *  with stop-on-error and the result honestly reports the state.
   *
   *  Use this instead of a loop of `runQuery` when the caller needs
   *  either the "all-or-nothing" guarantee or a per-statement log
   *  for migration history. */
  applyBatch(
    profile: ConnectionProfile,
    statements: string[],
  ): Promise<{
    committed: boolean;
    summary: string;
    statements: Array<{
      index: number;
      outcome:
        | { kind: 'ok'; rows_affected: number | null }
        | { kind: 'fail'; error: string }
        | { kind: 'skipped' };
    }>;
  }> {
    return invoke('apply_batch', { profile, statements });
  },

  runQuery(profile: ConnectionProfile, request: QueryRequest): Promise<QueryResult> {
    return invoke('run_query', { profile, request });
  },

  // ---- Tool bundles ------------------------------------------------
  // On-demand pg_dump / mysqldump / mongodump / etc. installer. See
  // apps/desktop/src-tauri/src/tools/. The frontend calls these three
  // to render the "Download & Install (18 MB)" prompt, kick off a
  // download, or clean up when the user wants to reclaim disk.

  listToolBundles(): Promise<ToolBundleStatus[]> {
    return invoke('list_tool_bundles', {});
  },

  installToolBundle(bundleKey: string): Promise<ToolBundleStatus> {
    return invoke('install_tool_bundle', { bundleKey });
  },

  uninstallToolBundle(bundleKey: string): Promise<null> {
    return invoke('uninstall_tool_bundle', { bundleKey });
  },

  // ---- Dump format detection --------------------------------------
  detectDumpFormat(path: string): Promise<DumpProbe> {
    return invoke('detect_dump_format', { path });
  },

  /** Byte-size of a file on disk, or 0 if it doesn't exist. Cheap
   *  fs::metadata call; used by the Export page to backfill the
   *  "Wrote N B" display when the progress stream missed the final
   *  tick (e.g. SQLite fs::copy). */
  fileSize(path: string): Promise<number> {
    return invoke('file_size', { path });
  },

  // ---- Export -----------------------------------------------------
  startExport(options: ExportOptions): Promise<ExportResult> {
    return invoke('start_export', { options });
  },
  cancelExport(jobId: string): Promise<boolean> {
    return invoke('cancel_export', { jobId });
  },

  // ---- Import -----------------------------------------------------
  startImport(options: ImportOptions): Promise<ImportResult> {
    return invoke('start_import', { options });
  },
  cancelImport(jobId: string): Promise<boolean> {
    return invoke('cancel_import', { jobId });
  },

  // Single-cell UPDATE via parameterized SQL. Returns rows_affected — callers
  // should refuse to treat ≠ 1 as success (PK didn't match, or PK was wrong).
  updateCell(profile: ConnectionProfile, update: CellUpdate): Promise<number> {
    return invoke('update_cell', { profile, update });
  },

  // INSERT a new row.
  insertRow(profile: ConnectionProfile, request: RowInsert): Promise<number> {
    return invoke('insert_row', { profile, request });
  },

  // DELETE a row identified by its PK.
  deleteRow(profile: ConnectionProfile, request: RowDelete): Promise<number> {
    return invoke('delete_row', { profile, request });
  },

  setSecret(profileId: string, slot: SecretSlot, value: string): Promise<null> {
    return invoke('set_secret', { profileId, slot, value });
  },

  hasSecret(profileId: string, slot: SecretSlot): Promise<boolean> {
    return invoke('has_secret', { profileId, slot });
  },

  deleteSecret(profileId: string, slot: SecretSlot): Promise<null> {
    return invoke('delete_secret', { profileId, slot });
  },

  deleteSecrets(profileId: string): Promise<null> {
    return invoke('delete_secrets', { profileId });
  },

  // One-shot SSH handshake. Returns the bastion's SHA256 host-key fingerprint
  // (OpenSSH format: `SHA256:<base64-no-pad>`) so the UI can show it for
  // the user to verify before pinning it on the profile.
  discoverHostKey(host: string, port: number): Promise<string> {
    return invoke('discover_host_key', { host, port });
  },

  // Drop the cached pool + SSH tunnel for a profile. Next query reopens
  // both from scratch. Use after a stale-connection error or a network
  // change.
  reconnect(profile: ConnectionProfile): Promise<null> {
    return invoke('reconnect', { profile });
  },

  // Signal the server to cancel the in-flight query identified by
  // `queryId`. The pending `runQuery` promise will reject with code
  // "query_cancelled" once the engine acknowledges the abort. No-op if
  // the id is unknown — typically because the query already finished.
  cancelQuery(profile: ConnectionProfile, queryId: string): Promise<null> {
    return invoke('cancel_query', { profile, queryId });
  },

  // ---- MongoDB ----
  // Mongo is a document store, so it sits outside the SQL Driver API
  // surface and gets its own namespace. Every method is a Tauri
  // command in the `mongo_*` group on the Rust side.
  mongo: {
    ping(profile: ConnectionProfile): Promise<null> {
      return invoke('mongo_ping', { profile });
    },
    listDatabases(profile: ConnectionProfile): Promise<string[]> {
      return invoke('mongo_list_databases', { profile });
    },
    listCollections(profile: ConnectionProfile, database: string): Promise<string[]> {
      return invoke('mongo_list_collections', { profile, database });
    },
    find(profile: ConnectionProfile, request: MongoFindRequest): Promise<MongoFindResponse> {
      return invoke('mongo_find', { profile, request });
    },
    /** Insert one document. Returns the inserted `_id` in extended-
     *  JSON form so the UI can refetch the row that just landed. */
    insertOne(
      profile: ConnectionProfile,
      database: string,
      collection: string,
      document: Record<string, unknown>,
    ): Promise<unknown> {
      return invoke('mongo_insert_one', { profile, database, collection, document });
    },
    /** Replace one document. `document._id` is used as the filter; the
     *  rest of the document becomes the new payload. */
    replaceOne(
      profile: ConnectionProfile,
      database: string,
      collection: string,
      document: Record<string, unknown>,
    ): Promise<number> {
      return invoke('mongo_replace_one', { profile, database, collection, document });
    },
    /** Delete one document by `_id`. The `id` argument is the
     *  extended-JSON form of the _id field — pass it as the UI saw it
     *  (`{"$oid": "..."}` for ObjectId, raw scalar for primitives). */
    deleteOne(
      profile: ConnectionProfile,
      database: string,
      collection: string,
      id: unknown,
    ): Promise<number> {
      return invoke('mongo_delete_one', { profile, database, collection, id });
    },
    disconnect(profile: ConnectionProfile): Promise<null> {
      return invoke('mongo_disconnect', { profile });
    },
  },

  // ---- Redis ----
  // Key/value store; the workspace dispatches against this namespace
  // rather than the SQL-shaped runQuery surface.
  redis: {
    ping(profile: ConnectionProfile): Promise<null> {
      return invoke('redis_ping', { profile });
    },
    scan(profile: ConnectionProfile, request: RedisScanRequest): Promise<RedisScanResponse> {
      return invoke('redis_scan', { profile, request });
    },
    keyDetails(profile: ConnectionProfile, key: string): Promise<RedisKeyDetails> {
      return invoke('redis_key_details', { profile, key });
    },
    delete(profile: ConnectionProfile, key: string): Promise<number> {
      return invoke('redis_delete', { profile, key });
    },
    disconnect(profile: ConnectionProfile): Promise<null> {
      return invoke('redis_disconnect', { profile });
    },
  },
};

export async function httpFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!resp.ok) throw new Error(`http ${resp.status}`);
  return (await resp.json()) as T;
}

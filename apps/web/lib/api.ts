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

  runQuery(profile: ConnectionProfile, request: QueryRequest): Promise<QueryResult> {
    return invoke('run_query', { profile, request });
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

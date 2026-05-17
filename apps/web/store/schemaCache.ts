// In-memory cache of fetched `Schema` objects, keyed by connection id.
//
// Used both by the ER diagram view (cheaper than re-introspecting on every
// remount) and by the table browser (needs PK columns to compose UPDATEs).
// Not persisted: schemas can be large and re-fetching on app reload is cheap.

import { create } from 'zustand';

import type { Schema } from '@dbstudio/erd';
import type { ConnectionProfile } from '@/lib/types';
import { api } from '@/lib/api';

interface CacheEntry {
  schema: Schema;
  loadedAt: number;
}

interface SchemaCacheState {
  entries: Record<string, CacheEntry>;
  inFlight: Record<string, Promise<Schema> | undefined>;
  get: (connectionId: string) => Schema | undefined;
  load: (profile: ConnectionProfile, force?: boolean) => Promise<Schema>;
  invalidate: (connectionId: string) => void;
}

export const useSchemaCache = create<SchemaCacheState>((set, getState) => ({
  entries: {},
  inFlight: {},

  get: (connectionId) => getState().entries[connectionId]?.schema,

  load: async (profile, force) => {
    const state = getState();
    if (!force) {
      const cached = state.entries[profile.id];
      if (cached) return cached.schema;
      const pending = state.inFlight[profile.id];
      if (pending) return pending;
    }
    const promise = api.getSchema(profile).then((schema) => {
      set((s) => ({
        entries: { ...s.entries, [profile.id]: { schema, loadedAt: Date.now() } },
        inFlight: { ...s.inFlight, [profile.id]: undefined },
      }));
      return schema;
    });
    set((s) => ({ inFlight: { ...s.inFlight, [profile.id]: promise } }));
    return promise;
  },

  invalidate: (connectionId) =>
    set((s) => {
      const { [connectionId]: _, ...rest } = s.entries;
      return { entries: rest };
    }),
}));

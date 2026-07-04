// Per-connection ServerInfo cache. Same shape as schemaCache — one
// entry per profile.id, in-flight dedupe so racing calls share the
// same round-trip. Consumed by the diff and data-diff pages to pass
// `sourceVersion` / `writeSideVersion` into the SQL generators.
//
// NoSQL engines (Mongo, Redis) return `Unsupported` from the Rust
// side. We swallow that and cache `null` so we don't retry on every
// diff refresh — the frontend treats null as "safe minimum
// capability set" which is correct for engines outside the
// version-aware SQL dispatch.

import { create } from 'zustand';

import type { ConnectionProfile } from '@/lib/types';
import { api } from '@/lib/api';
import { parseVersionString, type EngineVersion } from '@/lib/engineVersion';

interface Entry {
  version: EngineVersion | null;
  flags: { no_backslash_escapes?: boolean };
  loadedAt: number;
}

interface CacheState {
  entries: Record<string, Entry>;
  inFlight: Record<string, Promise<Entry> | undefined>;
  get: (id: string) => Entry | undefined;
  load: (profile: ConnectionProfile, force?: boolean) => Promise<Entry>;
  invalidate: (id: string) => void;
}

export const useServerInfoCache = create<CacheState>((set, getState) => ({
  entries: {},
  inFlight: {},

  get: (id) => getState().entries[id],

  load: async (profile, force) => {
    const state = getState();
    const pending = state.inFlight[profile.id];
    if (pending) return pending;
    if (!force && state.entries[profile.id]) return state.entries[profile.id]!;

    const promise = api.getServerInfo(profile).then(
      (info) => {
        const version = info.raw
          ? parseVersionString(profile.engine, info.raw)
          : null;
        // The Rust side already returned parsed major/minor — prefer
        // those over our string parse when available.
        const finalVersion: EngineVersion | null = version
          ? { ...version, major: info.major ?? version.major, minor: info.minor ?? version.minor }
          : null;
        const entry: Entry = {
          version: finalVersion,
          flags: info.flags ?? {},
          loadedAt: Date.now(),
        };
        set((s) => ({
          entries: { ...s.entries, [profile.id]: entry },
          inFlight: { ...s.inFlight, [profile.id]: undefined },
        }));
        return entry;
      },
      () => {
        // NoSQL engines return Unsupported. Cache a null entry so we
        // don't retry every render. The safe-minimum capability set
        // applies from here on.
        const entry: Entry = { version: null, flags: {}, loadedAt: Date.now() };
        set((s) => ({
          entries: { ...s.entries, [profile.id]: entry },
          inFlight: { ...s.inFlight, [profile.id]: undefined },
        }));
        return entry;
      },
    );
    set((s) => ({ inFlight: { ...s.inFlight, [profile.id]: promise } }));
    return promise;
  },

  invalidate: (id) =>
    set((s) => {
      const { [id]: _dropped, ...rest } = s.entries;
      return { entries: rest };
    }),
}));

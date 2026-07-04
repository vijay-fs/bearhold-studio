// Local-only connection profile store. Persists to localStorage in browser dev
// and to OS-keychain-backed SQLite in desktop (Phase 1.5 — currently localStorage
// in both contexts for simplicity).

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { ConnectionProfile, DatabaseEngine } from '@/lib/types';

/** Sidecar UI metadata kept out of `ConnectionProfile` so the wire format
 *  mirrored from Rust stays clean. Driven by hover/click behaviour, not
 *  authoritative state — losing it has no real consequence beyond losing
 *  the user's pin/order. */
export interface ConnectionMeta {
  pinned?: boolean;
  /** ms epoch — bumped when the user opens this connection's SQL / schema
   *  / history / snippets page. Drives the palette's "recent first"
   *  ordering. */
  lastUsedAt?: number;
}

interface ConnectionsState {
  profiles: ConnectionProfile[];
  meta: Record<string, ConnectionMeta>;
  upsert: (profile: ConnectionProfile) => void;
  remove: (id: string) => void;
  get: (id: string) => ConnectionProfile | undefined;
  /** Bump `lastUsedAt` for the given id. Idempotent — safe to call on
   *  every render of the connection's page via useEffect. */
  markUsed: (id: string) => void;
  /** Flip the `pinned` flag. Pinned connections sort first in the
   *  sidebar so the user can keep their daily-driver databases at the
   *  top without having to scroll past 30 archived ones. */
  togglePinned: (id: string) => void;
}

export const useConnections = create<ConnectionsState>()(
  persist(
    (set, getState) => ({
      profiles: [],
      meta: {},
      upsert: (profile) =>
        set((s) => {
          const idx = s.profiles.findIndex((p) => p.id === profile.id);
          if (idx >= 0) {
            const next = [...s.profiles];
            next[idx] = profile;
            return { profiles: next };
          }
          return { profiles: [...s.profiles, profile] };
        }),
      remove: (id) =>
        set((s) => {
          const { [id]: _dropped, ...restMeta } = s.meta;
          void _dropped;
          return {
            profiles: s.profiles.filter((p) => p.id !== id),
            meta: restMeta,
          };
        }),
      get: (id) => getState().profiles.find((p) => p.id === id),
      markUsed: (id) =>
        set((s) => ({
          meta: { ...s.meta, [id]: { ...s.meta[id], lastUsedAt: Date.now() } },
        })),
      togglePinned: (id) =>
        set((s) => ({
          meta: {
            ...s.meta,
            [id]: { ...s.meta[id], pinned: !s.meta[id]?.pinned },
          },
        })),
    }),
    { name: 'dbstudio.connections' },
  ),
);

export function newProfile(engine: DatabaseEngine = 'postgres'): ConnectionProfile {
  if (engine === 'sqlite') {
    return {
      id: crypto.randomUUID(),
      name: 'New SQLite connection',
      engine,
      host: '',
      port: 0,
      database: '',
      auth: { kind: 'none' },
      tls: 'disable',
      ssh_tunnel: null,
      options: {},
      file_path: '',
    };
  }
  const defaultPort =
    engine === 'mysql'
      ? 3306
      : engine === 'mongodb'
        ? 27017
        : engine === 'redis'
          ? 6379
          : 5432;
  return {
    id: crypto.randomUUID(),
    name: 'New connection',
    engine,
    host: 'localhost',
    port: defaultPort,
    // Database + username start empty rather than being pre-filled
    // with `postgres`. The PG-specific default was misleading on
    // other engines (MySQL doesn't have a `postgres` user/db) and
    // even on PG the user almost always wants to type their own.
    database: '',
    auth: { kind: 'password', username: '', password_ref: '' },
    tls: 'prefer',
    ssh_tunnel: null,
    options: {},
    file_path: null,
  };
}

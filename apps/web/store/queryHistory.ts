// Per-connection history of every SQL execution.
//
// Persisted to localStorage (`dbstudio.queryHistory`). Capped globally at
// MAX_ENTRIES so a forgotten generator-script can't unbound it. Newest first.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const MAX_ENTRIES = 500;

export interface QueryHistoryEntry {
  id: string;
  connectionId: string;
  sql: string;
  /** Unix ms. */
  timestamp: number;
  elapsedMs: number;
  status: 'ok' | 'error';
  rowsReturned?: number;
  rowsAffected?: number;
  truncated?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export type QueryHistoryRecord = Omit<QueryHistoryEntry, 'id' | 'timestamp'>;

interface QueryHistoryState {
  entries: QueryHistoryEntry[];
  record: (entry: QueryHistoryRecord) => void;
  forConnection: (connectionId: string) => QueryHistoryEntry[];
  remove: (id: string) => void;
  clear: (connectionId?: string) => void;
}

export const useQueryHistory = create<QueryHistoryState>()(
  persist(
    (set, get) => ({
      entries: [],

      record: (entry) =>
        set((s) => {
          const next: QueryHistoryEntry = {
            ...entry,
            id: crypto.randomUUID(),
            timestamp: Date.now(),
          };
          const combined = [next, ...s.entries];
          return {
            entries:
              combined.length > MAX_ENTRIES ? combined.slice(0, MAX_ENTRIES) : combined,
          };
        }),

      forConnection: (connectionId) =>
        get().entries.filter((e) => e.connectionId === connectionId),

      remove: (id) => set((s) => ({ entries: s.entries.filter((e) => e.id !== id) })),

      clear: (connectionId) =>
        set((s) => ({
          entries: connectionId
            ? s.entries.filter((e) => e.connectionId !== connectionId)
            : [],
        })),
    }),
    { name: 'dbstudio.queryHistory' },
  ),
);

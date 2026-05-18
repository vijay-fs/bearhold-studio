// Saved SQL snippets, scoped per connection.
//
// Snippets are explicitly curated by the user (vs. the auto-recorded query
// history). Storing per-connection because a query like "show inactive
// users from the last 30 days" is meaningful against a specific schema —
// cross-connection sharing isn't a useful default and would let leakage
// happen quietly.
//
// Persisted to localStorage so they survive reloads. No size cap yet —
// users curate the list explicitly, so we trust their judgment.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface SqlSnippet {
  id: string;
  connectionId: string;
  name: string;
  sql: string;
  createdAt: number;
  updatedAt: number;
}

interface SnippetsState {
  entries: SqlSnippet[];
  create: (connectionId: string, name: string, sql: string) => SqlSnippet;
  rename: (id: string, name: string) => void;
  updateSql: (id: string, sql: string) => void;
  remove: (id: string) => void;
  forConnection: (connectionId: string) => SqlSnippet[];
}

export const useSnippets = create<SnippetsState>()(
  persist(
    (set, get) => ({
      entries: [],

      create: (connectionId, name, sql) => {
        const now = Date.now();
        const snippet: SqlSnippet = {
          id: crypto.randomUUID(),
          connectionId,
          name: name.trim() || 'Untitled snippet',
          sql,
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({ entries: [snippet, ...s.entries] }));
        return snippet;
      },

      rename: (id, name) =>
        set((s) => ({
          entries: s.entries.map((e) =>
            e.id === id ? { ...e, name: name.trim() || e.name, updatedAt: Date.now() } : e,
          ),
        })),

      updateSql: (id, sql) =>
        set((s) => ({
          entries: s.entries.map((e) =>
            e.id === id ? { ...e, sql, updatedAt: Date.now() } : e,
          ),
        })),

      remove: (id) => set((s) => ({ entries: s.entries.filter((e) => e.id !== id) })),

      forConnection: (connectionId) =>
        get().entries.filter((e) => e.connectionId === connectionId),
    }),
    { name: 'dbstudio.snippets' },
  ),
);

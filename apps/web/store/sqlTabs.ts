// Per-connection SQL editor tabs. Each tab keeps its own buffer; run results
// stay in component memory (not persisted) — only the SQL text survives a
// reload, which is what we'd want anyway (rerunning is one Cmd+Enter away).

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface SqlTab {
  id: string;
  title: string;
  sql: string;
  /** ms epoch — used only as a stable creation-order tiebreaker. */
  createdAt: number;
}

interface PerConnection {
  tabs: SqlTab[];
  activeId: string | null;
}

interface SqlTabsState {
  byConnection: Record<string, PerConnection>;
  /** Returns the per-connection slot, creating a default if absent. */
  ensure: (connectionId: string, defaultSql: string) => PerConnection;
  setActive: (connectionId: string, tabId: string) => void;
  newTab: (connectionId: string, sql?: string) => SqlTab;
  closeTab: (connectionId: string, tabId: string) => void;
  setSql: (connectionId: string, tabId: string, sql: string) => void;
  /** Overwrite + activate the named tab. Used by the command palette's
   *  "load recent query" flow so it lands in a dedicated tab instead of
   *  trampling whatever the user had open. */
  loadIntoNewTab: (connectionId: string, sql: string) => SqlTab;
}

function defaultTab(sql: string): SqlTab {
  return {
    id: crypto.randomUUID(),
    title: deriveTitle(sql),
    sql,
    createdAt: Date.now(),
  };
}

export function deriveTitle(sql: string): string {
  const firstLine = sql
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('--') && !l.startsWith('/*'));
  if (!firstLine) return 'Untitled';
  const trimmed = firstLine.length > 32 ? firstLine.slice(0, 30) + '…' : firstLine;
  // Strip trailing semicolons / commas so titles read cleanly.
  return trimmed.replace(/[;,]+$/, '');
}

export const useSqlTabs = create<SqlTabsState>()(
  persist(
    (set, get) => ({
      byConnection: {},

      ensure: (connectionId, defaultSql) => {
        const existing = get().byConnection[connectionId];
        if (existing && existing.tabs.length > 0) return existing;
        const tab = defaultTab(defaultSql);
        const slot: PerConnection = { tabs: [tab], activeId: tab.id };
        set((s) => ({
          byConnection: { ...s.byConnection, [connectionId]: slot },
        }));
        return slot;
      },

      setActive: (connectionId, tabId) =>
        set((s) => {
          const slot = s.byConnection[connectionId];
          if (!slot) return s;
          return {
            byConnection: {
              ...s.byConnection,
              [connectionId]: { ...slot, activeId: tabId },
            },
          };
        }),

      newTab: (connectionId, sql = '') => {
        const tab = defaultTab(sql);
        set((s) => {
          const slot = s.byConnection[connectionId] ?? { tabs: [], activeId: null };
          return {
            byConnection: {
              ...s.byConnection,
              [connectionId]: {
                tabs: [...slot.tabs, tab],
                activeId: tab.id,
              },
            },
          };
        });
        return tab;
      },

      closeTab: (connectionId, tabId) =>
        set((s) => {
          const slot = s.byConnection[connectionId];
          if (!slot) return s;
          const idx = slot.tabs.findIndex((t) => t.id === tabId);
          if (idx < 0) return s;
          const remaining = slot.tabs.filter((t) => t.id !== tabId);
          // Last tab closing: keep the slot, drop everything — caller will
          // ensure() a fresh starter tab on next mount.
          if (remaining.length === 0) {
            return {
              byConnection: {
                ...s.byConnection,
                [connectionId]: { tabs: [], activeId: null },
              },
            };
          }
          // Pick the neighbor: tab to the right if it existed, else the new last.
          const nextActive =
            slot.activeId === tabId
              ? (remaining[idx]?.id ?? remaining[remaining.length - 1]?.id ?? null)
              : slot.activeId;
          return {
            byConnection: {
              ...s.byConnection,
              [connectionId]: { tabs: remaining, activeId: nextActive },
            },
          };
        }),

      setSql: (connectionId, tabId, sql) =>
        set((s) => {
          const slot = s.byConnection[connectionId];
          if (!slot) return s;
          return {
            byConnection: {
              ...s.byConnection,
              [connectionId]: {
                ...slot,
                tabs: slot.tabs.map((t) =>
                  t.id === tabId ? { ...t, sql, title: deriveTitle(sql) } : t,
                ),
              },
            },
          };
        }),

      loadIntoNewTab: (connectionId, sql) => {
        const tab = defaultTab(sql);
        set((s) => {
          const slot = s.byConnection[connectionId] ?? { tabs: [], activeId: null };
          return {
            byConnection: {
              ...s.byConnection,
              [connectionId]: {
                tabs: [...slot.tabs, tab],
                activeId: tab.id,
              },
            },
          };
        });
        return tab;
      },
    }),
    { name: 'dbstudio.sqlTabs' },
  ),
);

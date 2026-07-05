// Local-only migration history.
//
// Every "Apply" click on the Compare workspace records a Migration
// entry here, keyed by client-generated id. The store persists to
// localStorage so a fresh app launch still shows what happened.
//
// Each entry captures enough information to:
//   - Show the user what was applied, when, against which connection
//   - Report which specific statement failed if the batch didn't
//     commit (for MySQL DDL partial-apply cases)
//   - Support future revert flows — statements + their engine so we
//     can generate the inverse SQL later

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { DatabaseEngine } from '@/lib/types';

const MAX_ENTRIES = 200;

export type MigrationKind = 'schema' | 'data';

export interface MigrationStatement {
  sql: string;
  outcome:
    | { kind: 'ok'; rowsAffected: number | null }
    | { kind: 'fail'; error: string }
    | { kind: 'skipped' };
}

export interface MigrationEntry {
  id: string;
  kind: MigrationKind;
  /** ms epoch. Bumped once at record time; never edited. */
  timestamp: number;
  sourceConnectionId: string;
  sourceConnectionName: string;
  targetConnectionId: string | null;
  targetConnectionName: string | null;
  engine: DatabaseEngine;
  /** True when the driver reported an atomic commit. False on any
   *  rollback OR any MySQL partial-DDL failure. */
  committed: boolean;
  summary: string;
  statements: MigrationStatement[];
  /** Free-text notes surfaced in the log view — set by the panel
   *  that recorded the entry (e.g. "Users table sync"). */
  label: string;
}

interface MigrationLogState {
  entries: MigrationEntry[];
  record: (entry: Omit<MigrationEntry, 'id' | 'timestamp'>) => MigrationEntry;
  remove: (id: string) => void;
  clear: () => void;
  forConnection: (connectionId: string) => MigrationEntry[];
}

export const useMigrationLog = create<MigrationLogState>()(
  persist(
    (set, get) => ({
      entries: [],

      record: (entry) => {
        const full: MigrationEntry = {
          ...entry,
          id: crypto.randomUUID(),
          timestamp: Date.now(),
        };
        set((s) => {
          const next = [full, ...s.entries];
          if (next.length > MAX_ENTRIES) next.length = MAX_ENTRIES;
          return { entries: next };
        });
        return full;
      },

      remove: (id) =>
        set((s) => ({ entries: s.entries.filter((e) => e.id !== id) })),

      clear: () => set({ entries: [] }),

      forConnection: (id) =>
        get().entries.filter(
          (e) =>
            e.sourceConnectionId === id || e.targetConnectionId === id,
        ),
    }),
    { name: 'dbstudio.migrationLog' },
  ),
);

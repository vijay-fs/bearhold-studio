// Persists AG Grid column state — visibility, order, width, sort — per
// (connection, schema, table). The grid stays "fluid" by default for
// arbitrary SELECTs; we only save state when the result is anchored to
// a known table (the editable case), since that's the only key shape we
// can safely route a saved layout back to on the next visit.
//
// We persist via Zustand's `persist` middleware to localStorage. The
// stored value is whatever `gridApi.getColumnState()` returns — that's
// AG Grid's own opaque format. Treating it as opaque keeps us forward-
// compatible with any new fields AG Grid adds in future versions.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ColumnState } from 'ag-grid-community';

interface TableLayoutsState {
  /** Keyed by `${connectionId}|${schema}.${table}` so connections never
   *  collide and the same table name across schemas is kept separate. */
  layouts: Record<string, ColumnState[]>;
  save: (key: string, state: ColumnState[]) => void;
  load: (key: string) => ColumnState[] | undefined;
  clear: (key: string) => void;
}

export const useTableLayouts = create<TableLayoutsState>()(
  persist(
    (set, get) => ({
      layouts: {},
      save: (key, state) =>
        set((s) => ({ layouts: { ...s.layouts, [key]: state } })),
      load: (key) => get().layouts[key],
      clear: (key) =>
        set((s) => {
          const { [key]: _dropped, ...rest } = s.layouts;
          void _dropped;
          return { layouts: rest };
        }),
    }),
    { name: 'dbstudio.tableLayouts' },
  ),
);

/** Build the storage key from the editable-config triple. Centralised
 *  so the save/load sites can't drift out of sync. */
export function layoutKey(
  connectionId: string,
  schema: string,
  table: string,
): string {
  return `${connectionId}|${schema}.${table}`;
}

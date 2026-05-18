'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellValueChangedEvent,
  type ColDef,
  type FilterChangedEvent,
  type GridApi,
  type ICellRendererParams,
} from 'ag-grid-community';
import {
  AlertCircle,
  Check,
  Download,
  FilterX,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';

import type {
  CellUpdate,
  ConnectionProfile,
  QueryResult,
  RowDelete,
  RowInsert,
} from '@/lib/types';
import { exportAs, type ExportFormat } from '@/lib/exporters';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Column as SchemaColumn } from '@dbstudio/erd';

// AG Grid v33+ requires explicit module registration — without this the
// grid mounts as an empty shell. Registering the full community bundle is
// fine for our size (~250KB gzip) and avoids picking modules à la carte.
ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * Theme tuned to sit next to our shadcn/Tailwind UI without a hard visual
 * break. AG Grid's CSS-var theme system wants concrete colors (not HSL
 * tokens), so we use neutral RGB values close to the rest of the app.
 * Dark-mode support comes when we add a global theme toggle.
 */
// Compact theme — closer to the old hand-rolled grid's density. AG Grid's
// `spacing` parameter scales most internal paddings; explicit row/header
// heights nail the per-row footprint regardless of font metrics.
const dbstudioTheme = themeQuartz.withParams({
  accentColor: 'rgb(59, 130, 246)',
  backgroundColor: 'transparent',
  borderColor: 'rgb(228, 231, 236)',
  borderRadius: 2,
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  fontSize: 11,
  foregroundColor: 'rgb(15, 23, 42)',
  headerBackgroundColor: 'rgb(243, 244, 246)',
  headerTextColor: 'rgb(15, 23, 42)',
  headerFontWeight: 600,
  headerFontSize: 11,
  headerHeight: 28,
  rowHeight: 24,
  oddRowBackgroundColor: 'transparent',
  rowHoverColor: 'rgba(59, 130, 246, 0.04)',
  selectedRowBackgroundColor: 'rgba(59, 130, 246, 0.08)',
  spacing: 4,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
});

export interface EditableConfig {
  profile: ConnectionProfile;
  schema: string;
  table: string;
  pkColumns: string[];
  /** Column metadata from the introspected schema. Required to render the
   *  Insert form with type hints and to skip auto-default columns. */
  tableColumns: SchemaColumn[];
  /** Called after a successful insert or delete so the parent can refetch.
   *  Cell updates patch the grid row directly and don't need a refresh. */
  onChanged?: () => void;
}

/** A single pending cell edit, identified by (rowId, column). The
 *  originalValue lets us highlight reverts-to-original and the
 *  `pkSnapshot` captures the row's PK at edit-time so a later edit to a
 *  PK column wouldn't break the eventual UPDATE's WHERE clause. */
interface PendingEdit {
  rowId: string;
  column: string;
  originalValue: unknown;
  newValue: unknown;
  /** PK column → value at the time of first edit. The row's current PK
   *  values *should* be unchanged (PK columns are non-editable), but we
   *  snapshot anyway so the UPDATE targets exactly the row the user edited. */
  pkSnapshot: Array<[string, unknown]>;
}

type ApplyState =
  | { kind: 'idle' }
  | { kind: 'previewing' }
  | { kind: 'applying' }
  | { kind: 'errors'; failures: Array<{ edit: PendingEdit; message: string }> };

interface InsertDraft {
  name: string;
  data_type: string;
  nullable: boolean;
  hasDefault: boolean;
  include: boolean;
  value: string;
}

function buildInsertDraft(columns: SchemaColumn[]): InsertDraft[] {
  return columns.map((c) => ({
    name: c.name,
    data_type: c.data_type,
    nullable: c.nullable,
    hasDefault: c.default != null,
    include: !c.nullable && c.default == null,
    value: '',
  }));
}

export function ResultTable({
  result,
  editable,
}: {
  result: QueryResult;
  editable?: EditableConfig;
}) {
  const gridApiRef = useRef<GridApi | null>(null);

  // ---- Editable readiness ------------------------------------------------
  const pkColumnNames = useMemo(
    () => new Set(editable?.pkColumns ?? []),
    [editable?.pkColumns],
  );
  const editableReady = useMemo(() => {
    if (!editable) return false;
    return editable.pkColumns.every((c) => result.columns.some((rc) => rc.name === c));
  }, [editable, result.columns]);

  // ---- Convert array-of-arrays rows into AG Grid's row objects ----------
  // AG Grid wants row objects keyed by column name. We attach a stable
  // `__id` so it can track rows across edits/deletes without losing state.
  const rowData = useMemo(() => {
    return result.rows.map((row, i) => {
      const obj: Record<string, unknown> = { __id: i };
      result.columns.forEach((c, idx) => {
        obj[c.name] = row[idx];
      });
      return obj;
    });
  }, [result.rows, result.columns]);

  // ---- Insert / Delete dialog state -------------------------------------
  const [insertOpen, setInsertOpen] = useState(false);
  const [insertDraft, setInsertDraft] = useState<InsertDraft[]>([]);
  const [insertError, setInsertError] = useState<string | null>(null);
  const [insertApplying, setInsertApplying] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Record<string, unknown> | null>(null);
  const [deleteApplying, setDeleteApplying] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ---- Pending-changes model --------------------------------------------
  // Edits accumulate in `pendingEditsRef` until the user clicks Apply.
  // Keyed by AG Grid row id (the stable `__id` field) and column name.
  // The ref doesn't trigger re-renders directly — we mirror the count
  // into `pendingCount` for the toolbar, and ask AG Grid to refresh the
  // touched cells whenever the ref changes (for the yellow tint).
  const pendingEditsRef = useRef<Map<string, Map<string, PendingEdit>>>(new Map());
  const [pendingCount, setPendingCount] = useState(0);
  const [applyState, setApplyState] = useState<ApplyState>({ kind: 'idle' });

  // Reset pending edits whenever the parent passes a fresh result — e.g.
  // after a reload triggered by onChanged.
  useEffect(() => {
    pendingEditsRef.current.clear();
    setPendingCount(0);
    setApplyState({ kind: 'idle' });
  }, [result]);

  // ---- Filter state ------------------------------------------------------
  // A single quick filter applied across every column. AG Grid's
  // `quickFilterText` does case-insensitive contains-match on the rendered
  // string of each cell — much closer to "one search box rules all" than
  // a row of per-column inputs, and it covers the 95% case.
  const [quickFilter, setQuickFilter] = useState('');
  const [displayedCount, setDisplayedCount] = useState(rowData.length);
  useEffect(() => {
    setDisplayedCount(rowData.length);
  }, [rowData.length]);

  const onFilterChanged = useCallback((e: FilterChangedEvent) => {
    setDisplayedCount(e.api.getDisplayedRowCount());
  }, []);

  // ---- Cell editing (pending-changes model) -----------------------------
  // We DON'T fire UPDATE on each Enter/Tab — that produced silent reverts
  // when individual statements failed. Instead, edits accumulate locally,
  // the cell tints yellow, and the user reviews + confirms a batch via
  // Apply. Each entry stores its original value so Revert restores cleanly
  // and a back-to-original edit auto-drops from the pending set.
  const onCellValueChanged = useCallback(
    (event: CellValueChangedEvent) => {
      if (!editable || !editableReady) return;
      const field = event.colDef.field;
      const rowId = event.node.id;
      if (!field || rowId == null) return;
      const { oldValue, newValue, data, node } = event;
      // Type-aware no-op check. AG Grid's number editor may reformat the
      // value on open (`"12.8000"` → `12.8`); without column-type-aware
      // equality, that round-trip alone registers a phantom pending edit
      // even though nothing changed semantically.
      const colMeta = editable.tableColumns.find((c) => c.name === field);
      const dataType = colMeta?.data_type ?? '';
      if (valuesEqual(oldValue, newValue, dataType)) return;
      const rowMap = pendingEditsRef.current.get(rowId) ?? new Map();
      const existing = rowMap.get(field);

      if (existing) {
        // The user edited this cell again. If they typed it back to the
        // original, drop the pending edit entirely.
        if (valuesEqual(existing.originalValue, newValue, dataType)) {
          rowMap.delete(field);
        } else {
          existing.newValue = newValue;
        }
      } else {
        const pkSnapshot: Array<[string, unknown]> = editable.pkColumns.map(
          (col) => [col, data[col]],
        );
        rowMap.set(field, {
          rowId,
          column: field,
          originalValue: oldValue,
          newValue,
          pkSnapshot,
        });
      }

      if (rowMap.size > 0) {
        pendingEditsRef.current.set(rowId, rowMap);
      } else {
        pendingEditsRef.current.delete(rowId);
      }

      setPendingCount(countPending(pendingEditsRef.current));
      // Refresh the touched cell so cellStyle re-evaluates the yellow tint.
      event.api.refreshCells({ rowNodes: [node], columns: [field], force: true });
    },
    [editable, editableReady],
  );

  // ---- Apply / Revert pending changes ------------------------------------
  const revertPending = useCallback(() => {
    const grid = gridApiRef.current;
    if (!grid) return;
    for (const [rowId, cols] of pendingEditsRef.current.entries()) {
      const node = grid.getRowNode(rowId);
      if (!node) continue;
      for (const edit of cols.values()) {
        node.setDataValue(edit.column, edit.originalValue);
      }
    }
    pendingEditsRef.current.clear();
    setPendingCount(0);
    setApplyState({ kind: 'idle' });
  }, []);

  const applyPending = useCallback(async () => {
    if (!editable) return;
    setApplyState({ kind: 'applying' });
    const failures: Array<{ edit: PendingEdit; message: string }> = [];
    // Run sequentially — keeps error messages tied to the right edit and
    // avoids overloading the pool. Most batches are small.
    for (const [rowId, cols] of Array.from(pendingEditsRef.current.entries())) {
      for (const edit of Array.from(cols.values())) {
        const colMeta = editable.tableColumns.find((c) => c.name === edit.column);
        const coerced = coerceCellValue(
          edit.newValue,
          colMeta?.data_type ?? '',
          colMeta?.nullable ?? true,
        );
        try {
          const affected = await api.updateCell(editable.profile, {
            schema: editable.schema,
            table: editable.table,
            pk: edit.pkSnapshot,
            set_column: edit.column,
            new_value: coerced,
          });
          if (affected !== 1) {
            throw {
              code: 'unexpected_rows',
              message: `Expected 1 row affected, got ${affected}.`,
            };
          }
          // Commit the new value to the row's data so the cell still
          // shows the new value once the pending entry is dropped (else
          // the valueGetter falls back to the original rowData value).
          const node = gridApiRef.current?.getRowNode(rowId);
          if (node) node.setDataValue(edit.column, coerced);
          cols.delete(edit.column);
        } catch (e: unknown) {
          const err = e as { code?: string; message?: string };
          failures.push({
            edit,
            message: `${err.code ?? 'unknown'} · ${err.message ?? String(e)}`,
          });
        }
      }
      if (cols.size === 0) pendingEditsRef.current.delete(rowId);
    }
    setPendingCount(countPending(pendingEditsRef.current));
    if (failures.length > 0) {
      setApplyState({ kind: 'errors', failures });
    } else {
      setApplyState({ kind: 'idle' });
    }
    gridApiRef.current?.refreshCells({ force: true });
  }, [editable]);

  // ---- Insert flow ------------------------------------------------------
  const openInsert = () => {
    if (!editable) return;
    setInsertDraft(buildInsertDraft(editable.tableColumns));
    setInsertError(null);
    setInsertOpen(true);
  };

  const applyInsert = async () => {
    if (!editable) return;
    const included = insertDraft.filter((d) => d.include);
    if (included.length === 0) {
      setInsertError('Pick at least one column to insert.');
      return;
    }
    setInsertError(null);
    setInsertApplying(true);
    try {
      const values: Array<[string, unknown]> = included.map((d) => [
        d.name,
        coerceInsertValue(d),
      ]);
      const request: RowInsert = {
        schema: editable.schema,
        table: editable.table,
        values,
      };
      const affected = await api.insertRow(editable.profile, request);
      if (affected !== 1) {
        throw {
          code: 'unexpected_rows',
          message: `Expected 1 row affected, got ${affected}.`,
        };
      }
      setInsertOpen(false);
      editable.onChanged?.();
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setInsertError(`${err.code ?? 'unknown'} · ${err.message ?? String(e)}`);
    } finally {
      setInsertApplying(false);
    }
  };

  // ---- Delete flow ------------------------------------------------------
  const openDelete = useCallback((rowObj: Record<string, unknown>) => {
    setDeleteTarget(rowObj);
    setDeleteError(null);
  }, []);

  const applyDelete = async () => {
    if (!editable || !deleteTarget) return;
    setDeleteError(null);
    setDeleteApplying(true);
    try {
      const pk: Array<[string, unknown]> = editable.pkColumns.map((col) => [
        col,
        deleteTarget[col],
      ]);
      const request: RowDelete = {
        schema: editable.schema,
        table: editable.table,
        pk,
      };
      const affected = await api.deleteRow(editable.profile, request);
      if (affected !== 1) {
        throw {
          code: 'unexpected_rows',
          message: `Expected 1 row affected, got ${affected}.`,
        };
      }
      // Splice locally for snappy feedback. Parent's onChanged refetches.
      gridApiRef.current?.applyTransaction({ remove: [deleteTarget] });
      setDisplayedCount((c) => Math.max(0, c - 1));
      setDeleteTarget(null);
      editable.onChanged?.();
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setDeleteError(`${err.code ?? 'unknown'} · ${err.message ?? String(e)}`);
    } finally {
      setDeleteApplying(false);
    }
  };

  // ---- Export ----------------------------------------------------------
  // We export the post-filter / post-sort view by walking AG Grid's
  // displayed nodes, then hand the rows to our existing exporters so JSON
  // and SQL output stays identical across the app.
  const handleExport = (format: ExportFormat) => {
    const api = gridApiRef.current;
    const rows: unknown[][] = [];
    if (api) {
      api.forEachNodeAfterFilterAndSort((node) => {
        if (node.data) {
          rows.push(result.columns.map((c) => (node.data as Record<string, unknown>)[c.name]));
        }
      });
    }
    exportAs(format, {
      columns: result.columns,
      rows,
      baseName: editable ? `${editable.schema}.${editable.table}` : 'dbstudio-result',
    });
  };

  // ---- Column defs ------------------------------------------------------
  const columnDefs = useMemo<ColDef[]>(() => {
    const defs: ColDef[] = result.columns.map((c) => {
      const isPk = pkColumnNames.has(c.name);
      const numeric = isNumericType(c.data_type);
      const bool = isBoolType(c.data_type);
      return {
        field: c.name,
        headerName: c.name,
        type: numeric ? 'numericColumn' : undefined,
        filter: numeric ? 'agNumberColumnFilter' : 'agTextColumnFilter',
        floatingFilter: false,
        sortable: true,
        resizable: true,
        editable: editableReady && !isPk,
        cellEditor: numeric
          ? 'agNumberCellEditor'
          : bool
            ? 'agCheckboxCellEditor'
            : 'agTextCellEditor',
        cellEditorParams: numeric
          ? { precision: isIntegerType(c.data_type) ? 0 : undefined }
          : undefined,
        // valueGetter consults pendingEditsRef before falling back to row
        // data. This is what makes pending edits "stick" — even if AG Grid
        // re-pulls from the rowData prop on an unrelated re-render, the
        // cell still shows what the user typed until they Apply / Revert.
        valueGetter: (p) => {
          const rid = p.node?.id;
          if (rid != null) {
            const pending = pendingEditsRef.current.get(rid)?.get(c.name);
            if (pending) return pending.newValue;
          }
          return p.data?.[c.name];
        },
        valueFormatter: (p) => renderCell(p.value),
        cellClass: (p) =>
          isPk ? 'text-amber-700 dark:text-amber-400' : '',
        cellStyle: (p) => {
          if (!p.node?.id || !p.colDef.field) return null;
          const isPending = pendingEditsRef.current
            .get(p.node.id)
            ?.has(p.colDef.field);
          return isPending
            ? { backgroundColor: 'rgba(245, 158, 11, 0.18)' }
            : null;
        },
        headerTooltip: `${c.name} · ${c.data_type}${isPk ? ' · PRIMARY KEY' : ''}`,
        minWidth: 100,
      };
    });
    if (editable && editableReady) {
      defs.push({
        headerName: '',
        colId: '__actions__',
        width: 44,
        minWidth: 44,
        maxWidth: 44,
        pinned: 'right',
        sortable: false,
        filter: false,
        editable: false,
        resizable: false,
        suppressMovable: true,
        cellRenderer: DeleteCellRenderer,
        cellRendererParams: { onDelete: openDelete },
      });
    }
    return defs;
  }, [result.columns, pkColumnNames, editable, editableReady, openDelete]);

  const defaultColDef = useMemo<ColDef>(
    () => ({
      // Keep things terse and snappy.
      sortable: true,
      filter: true,
      resizable: true,
      suppressMovable: false,
    }),
    [],
  );

  // ---- Render ----------------------------------------------------------
  const totalCount = result.rows.length;
  const filteredOut = totalCount - displayedCount;
  const hasActiveFilter = filteredOut > 0;
  const canExport = result.columns.length > 0 && totalCount > 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {hasActiveFilter ? (
            <>
              {displayedCount.toLocaleString()} / {totalCount.toLocaleString()} rows (filtered)
            </>
          ) : (
            <>
              {totalCount.toLocaleString()} row{totalCount === 1 ? '' : 's'}
            </>
          )}
          {result.rows_affected != null && ` · ${result.rows_affected} affected`}
          {result.columns.length > 0 &&
            ` · ${result.columns.length} col${result.columns.length === 1 ? '' : 's'}`}
          {editable && !editableReady && (
            <span className="ml-2 text-amber-600 dark:text-amber-400">
              read-only · PK columns ({editable.pkColumns.join(', ') || 'none'}) missing from result
            </span>
          )}
        </span>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={quickFilter}
              onChange={(e) => setQuickFilter(e.target.value)}
              placeholder="Search rows…"
              className="h-6 w-44 rounded border border-input bg-background pl-6 pr-6 text-[11px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            {quickFilter && (
              <button
                type="button"
                onClick={() => setQuickFilter('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          {hasActiveFilter && (
            <button
              type="button"
              onClick={() => {
                gridApiRef.current?.setFilterModel(null);
                setQuickFilter('');
              }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-background hover:text-foreground"
              title="Clear search and any column filters"
            >
              <FilterX className="h-3 w-3" />
              Clear
            </button>
          )}
          {editable && editableReady && (
            <button
              type="button"
              onClick={openInsert}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-background hover:text-foreground"
              title="Insert a new row"
            >
              <Plus className="h-3 w-3" />
              New row
            </button>
          )}
          {canExport && (
            <ExportMenu onExport={handleExport} />
          )}
          <span className="font-mono">{result.elapsed_ms} ms</span>
        </div>
      </header>

      {applyState.kind === 'errors' && (
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertCircle className="h-3.5 w-3.5" />
              {applyState.failures.length} edit
              {applyState.failures.length === 1 ? '' : 's'} failed — yellow cells still
              hold the rejected values.
            </div>
            <ul className="space-y-0.5 pl-5 font-mono text-[10px]">
              {applyState.failures.slice(0, 5).map((f, i) => (
                <li key={i}>
                  <span className="opacity-70">
                    {f.edit.pkSnapshot.map(([c, v]) => `${c}=${renderCell(v)}`).join(', ')}
                    {' · '}
                    {f.edit.column}:
                  </span>{' '}
                  {f.message}
                </li>
              ))}
              {applyState.failures.length > 5 && (
                <li className="opacity-70">…and {applyState.failures.length - 5} more</li>
              )}
            </ul>
          </div>
          <button
            type="button"
            onClick={() => setApplyState({ kind: 'idle' })}
            className="rounded p-0.5 hover:bg-destructive/10"
            aria-label="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {result.columns.length === 0 && totalCount === 0 ? (
        <p className="p-4 text-xs text-muted-foreground">No rows returned.</p>
      ) : (
        <div className="relative flex-1 overflow-hidden">
          {/* Floating apply card — only renders while there are pending
              edits. Bottom-right keeps it out of the user's primary work
              area but always reachable. */}
          {pendingCount > 0 && (
            <div className="pointer-events-none absolute bottom-4 right-4 z-20">
              <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-amber-500/40 bg-popover/95 px-3 py-2 shadow-lg backdrop-blur">
                <span className="text-[11px] text-amber-700 dark:text-amber-400">
                  <span className="font-semibold">{pendingCount}</span> pending change
                  {pendingCount === 1 ? '' : 's'}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={revertPending}
                  disabled={applyState.kind === 'applying'}
                >
                  <RotateCcw className="h-3 w-3" />
                  Revert
                </Button>
                <Button
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setApplyState({ kind: 'previewing' })}
                  disabled={applyState.kind === 'applying'}
                >
                  <Check className="h-3 w-3" />
                  Apply
                </Button>
              </div>
            </div>
          )}
          <AgGridReact
            theme={dbstudioTheme}
            rowData={rowData}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            getRowId={(p) => String((p.data as { __id: number }).__id)}
            onGridReady={(p) => {
              gridApiRef.current = p.api;
            }}
            quickFilterText={quickFilter}
            onCellValueChanged={onCellValueChanged}
            onFilterChanged={onFilterChanged}
            stopEditingWhenCellsLoseFocus
            // Double-click opens the editor (or F2 / Enter on a focused cell).
            // Single-click edit is too easy to trigger accidentally.
            singleClickEdit={false}
            animateRows={false}
            // Tab/Enter behave like spreadsheets — commit and move to the
            // next cell. Enter moves down a row; Tab moves right.
            enterNavigatesVertically
            enterNavigatesVerticallyAfterEdit
            suppressMenuHide
            // Don't show the "no rows" overlay; our parent already handles
            // the empty state above.
            suppressNoRowsOverlay
          />
        </div>
      )}

      {/* Apply pending changes — preview all UPDATEs, then confirm */}
      <Dialog
        open={applyState.kind === 'previewing' || applyState.kind === 'applying'}
        onOpenChange={(o) => {
          if (!o && applyState.kind !== 'applying') setApplyState({ kind: 'idle' });
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Apply pending changes?</DialogTitle>
            <DialogDescription>
              {pendingCount} parameterized UPDATE
              {pendingCount === 1 ? '' : 's'} will run in order. Values are
              bound — never interpolated into the SQL — so injection isn&apos;t
              a concern.
            </DialogDescription>
          </DialogHeader>
          {editable && (
            <div className="max-h-[420px] space-y-2 overflow-y-auto">
              {Array.from(pendingEditsRef.current.entries()).flatMap(([, cols]) =>
                Array.from(cols.values()).map((edit, i) => (
                  <pre
                    key={`${edit.rowId}.${edit.column}.${i}`}
                    className="overflow-x-auto rounded border bg-muted/40 p-3 text-[11px] leading-relaxed"
                  >
                    {pendingUpdatePreviewSql(editable, edit)}
                  </pre>
                )),
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setApplyState({ kind: 'idle' })}
              disabled={applyState.kind === 'applying'}
            >
              Cancel
            </Button>
            <Button onClick={applyPending} disabled={applyState.kind === 'applying'}>
              {applyState.kind === 'applying' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Apply {pendingCount} change{pendingCount === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Insert dialog */}
      <Dialog
        open={insertOpen}
        onOpenChange={(o) => !o && !insertApplying && setInsertOpen(false)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Insert row</DialogTitle>
            <DialogDescription>
              Uncheck columns to let the database fill in their defaults
              (auto-increment PKs, NOW() timestamps, etc.). Required columns
              start checked.
            </DialogDescription>
          </DialogHeader>
          {editable && (
            <div className="space-y-3">
              <div className="max-h-[320px] overflow-y-auto rounded border">
                <table className="w-full text-xs">
                  <tbody>
                    {insertDraft.map((d, i) => (
                      <tr key={d.name} className="border-b last:border-b-0">
                        <td className="w-8 px-2 py-1.5">
                          <input
                            type="checkbox"
                            checked={d.include}
                            onChange={(e) =>
                              setInsertDraft((prev) =>
                                prev.map((p, j) =>
                                  j === i ? { ...p, include: e.target.checked } : p,
                                ),
                              )
                            }
                            aria-label={`Include ${d.name} in insert`}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="font-medium">{d.name}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {d.data_type}
                            {!d.nullable && <span className="ml-1">· NOT NULL</span>}
                            {d.hasDefault && <span className="ml-1">· has default</span>}
                          </div>
                        </td>
                        <td className="w-[55%] px-2 py-1.5">
                          <input
                            type="text"
                            value={d.value}
                            disabled={!d.include}
                            onChange={(e) =>
                              setInsertDraft((prev) =>
                                prev.map((p, j) =>
                                  j === i ? { ...p, value: e.target.value } : p,
                                ),
                              )
                            }
                            placeholder={
                              !d.include
                                ? d.hasDefault
                                  ? '(default)'
                                  : d.nullable
                                    ? '(NULL)'
                                    : ''
                                : d.nullable
                                  ? 'value or empty for NULL'
                                  : 'value'
                            }
                            className="w-full rounded border border-input bg-background px-2 py-1 font-mono text-xs disabled:bg-muted/40 disabled:text-muted-foreground"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details className="rounded border bg-muted/40 p-2 text-[11px]">
                <summary className="cursor-pointer select-none text-muted-foreground">
                  Preview SQL
                </summary>
                <pre className="mt-2 overflow-x-auto leading-relaxed">
                  {insertPreviewSql(editable, insertDraft.filter((d) => d.include))}
                </pre>
              </details>
              {insertError && <p className="text-xs text-destructive">{insertError}</p>}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setInsertOpen(false)}
              disabled={insertApplying}
            >
              Cancel
            </Button>
            <Button onClick={applyInsert} disabled={insertApplying}>
              {insertApplying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Apply INSERT
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={deleteTarget != null}
        onOpenChange={(o) => !o && !deleteApplying && setDeleteTarget(null)}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Delete row?</DialogTitle>
            <DialogDescription>
              This DELETE runs against the live database and can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          {editable && deleteTarget && (
            <div className="space-y-3">
              <pre className="overflow-x-auto rounded border bg-muted/40 p-3 text-[11px] leading-relaxed">
                {deletePreviewSql(editable, deleteTarget)}
              </pre>
              <div className="text-[11px]">
                <Labeled label="Row">
                  <code className="font-mono">
                    {editable.pkColumns
                      .map((col) => `${col}=${renderCell(deleteTarget[col])}`)
                      .join(', ')}
                  </code>
                </Labeled>
              </div>
              {deleteError && <p className="text-xs text-destructive">{deleteError}</p>}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteApplying}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={applyDelete} disabled={deleteApplying}>
              {deleteApplying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              <Trash2 className="h-3.5 w-3.5" />
              Delete row
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- Cell renderer for the trailing delete column -----------------------

function DeleteCellRenderer(
  params: ICellRendererParams & { onDelete: (data: Record<string, unknown>) => void },
) {
  if (!params.data) return null;
  return (
    <button
      type="button"
      onClick={() => params.onDelete(params.data as Record<string, unknown>)}
      className="flex h-full w-full items-center justify-center text-muted-foreground hover:text-destructive"
      title="Delete this row"
      aria-label="Delete row"
    >
      <Trash2 className="h-3 w-3" />
    </button>
  );
}

// ---- Toolbar export menu -----------------------------------------------

function ExportMenu({ onExport }: { onExport: (f: ExportFormat) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-background hover:text-foreground"
        title="Export the currently visible rows"
      >
        <Download className="h-3 w-3" />
        Export
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded-md border bg-popover text-popover-foreground shadow-md">
          <ExportMenuItem onClick={() => { onExport('csv'); setOpen(false); }} label="CSV" hint=".csv" />
          <ExportMenuItem onClick={() => { onExport('json'); setOpen(false); }} label="JSON" hint=".json" />
          <ExportMenuItem onClick={() => { onExport('sql'); setOpen(false); }} label="SQL INSERTs" hint=".sql" />
        </div>
      )}
    </div>
  );
}

function ExportMenuItem({
  onClick,
  label,
  hint,
}: {
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
    >
      <span>{label}</span>
      <span className="text-[10px] text-muted-foreground">{hint}</span>
    </button>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

// ---- Value helpers ------------------------------------------------------

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function countPending(map: Map<string, Map<string, PendingEdit>>): number {
  let n = 0;
  for (const cols of map.values()) n += cols.size;
  return n;
}

/** Type-aware equality for cell values. Drivers decode NUMERIC and similar
 *  high-precision types as strings to preserve scale, but AG Grid's number
 *  editor returns a JS `number` — so a "no-op" reopen-and-blur of a cell
 *  showing "12.8000" comes back as `12.8`, which a naive `===` check
 *  reports as different.
 *
 *  For numeric columns we coerce both sides to `Number` and compare; for
 *  booleans we coerce both sides to bool; everything else falls back to
 *  string comparison so `"5"` vs `5` in a text column still registers as
 *  a real change. */
function valuesEqual(a: unknown, b: unknown, dataType: string): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;

  const t = dataType.toLowerCase();
  if (/(int|serial|bigint|smallint|mediumint|tinyint|numeric|decimal|real|double|float|money)/.test(t)) {
    const aNum = typeof a === 'number' ? a : Number(a);
    const bNum = typeof b === 'number' ? b : Number(b);
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum === bNum;
  }
  if (/(bool)/.test(t)) {
    const aBool = toBoolish(a);
    const bBool = toBoolish(b);
    if (aBool !== null && bBool !== null) return aBool === bBool;
  }
  return String(a) === String(b);
}

function toBoolish(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (s === 'true' || s === '1' || s === 't' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'f' || s === 'no') return false;
  }
  return null;
}

function isNumericType(t: string): boolean {
  const lower = t.toLowerCase();
  return /(int|serial|numeric|decimal|real|double|float|money|bigint|smallint)/.test(lower);
}

function isIntegerType(t: string): boolean {
  const lower = t.toLowerCase();
  return /(int|serial|bigint|smallint|mediumint|tinyint)/.test(lower);
}

function isBoolType(t: string): boolean {
  return /(bool)/.test(t.toLowerCase());
}

/**
 * Coerce the AG Grid editor's output into the JSON value our driver binds.
 *
 * Uses the *column's declared data type* (from the introspected schema),
 * not the JS type of the previous cell value — NUMERIC and TIMESTAMP cells
 * arrive from the driver as strings, so `typeof original` is misleading.
 *
 * - Numeric columns → `number` (the agNumberCellEditor already returns one,
 *   but we re-parse defensively in case a different editor was used)
 * - Boolean columns → `true`/`false`
 * - Empty input on numeric/bool/date/json columns → `null` (those types
 *   can't hold an empty string); on text columns, → `null` if nullable
 *   else `''` (let the DB enforce NOT NULL)
 * - Everything else passes through as-is; the driver hands it to the DB
 *   which is the authority on whether it parses
 */
function coerceCellValue(newValue: unknown, dataType: string, nullable: boolean): unknown {
  const t = dataType.toLowerCase();
  const isNumeric = /(int|serial|bigint|smallint|mediumint|tinyint|numeric|decimal|real|double|float|money)/.test(
    t,
  );
  const isBool = /(bool)/.test(t);
  const isStructured = /(date|time|timestamp|uuid|json|interval)/.test(t);

  // Empty input handling: numerics / bools / dates / json never accept
  // empty-string in their parsers — coerce to NULL regardless of the
  // column's nullability. NOT NULL columns will surface a DB error that
  // tells the user exactly what went wrong.
  if (newValue === null || newValue === undefined || newValue === '') {
    if (isNumeric || isBool || isStructured) return null;
    return nullable ? null : '';
  }

  if (isNumeric) {
    const n = typeof newValue === 'number' ? newValue : Number(newValue);
    if (Number.isFinite(n)) return n;
    // Non-number text in a numeric column: pass through; let the DB's
    // error surface beats truncating silently.
    return newValue;
  }
  if (isBool) {
    if (typeof newValue === 'boolean') return newValue;
    const s = String(newValue).toLowerCase();
    if (s === 'true' || s === '1' || s === 't' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'f' || s === 'no') return false;
    return newValue;
  }
  return newValue;
}

function coerceInsertValue(d: InsertDraft): unknown {
  const t = d.data_type.toLowerCase();
  if (d.value === '') {
    return d.nullable ? null : '';
  }
  if (/(int|serial|bigint|smallint|mediumint|tinyint)/.test(t)) {
    const n = Number(d.value);
    return Number.isFinite(n) ? Math.trunc(n) : d.value;
  }
  if (/(numeric|decimal|real|double|float|money)/.test(t)) {
    const n = Number(d.value);
    return Number.isFinite(n) ? n : d.value;
  }
  if (/(bool)/.test(t)) {
    if (d.value.toLowerCase() === 'true' || d.value === '1') return true;
    if (d.value.toLowerCase() === 'false' || d.value === '0') return false;
  }
  return d.value;
}

// ---- SQL preview strings ------------------------------------------------

function quoteFor(engine: ConnectionProfile['engine'], name: string): string {
  if (engine === 'mysql' || engine === 'mariadb') {
    return `\`${name.replace(/`/g, '``')}\``;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function tableRefFor(editable: EditableConfig): string {
  const engine = editable.profile.engine;
  if (engine === 'mysql' || engine === 'mariadb') {
    if (!editable.schema || editable.schema === editable.profile.database) {
      return quoteFor(engine, editable.table);
    }
    return `${quoteFor(engine, editable.schema)}.${quoteFor(engine, editable.table)}`;
  }
  if (engine === 'sqlite') {
    return quoteFor(engine, editable.table);
  }
  return `${quoteFor(engine, editable.schema)}.${quoteFor(engine, editable.table)}`;
}

function insertPreviewSql(editable: EditableConfig, included: InsertDraft[]): string {
  if (included.length === 0) return '-- nothing to insert';
  const cols = included.map((d) => quoteFor(editable.profile.engine, d.name)).join(', ');
  const placeholders = included.map((_, i) => `$${i + 1}`).join(', ');
  const args = included
    .map((d, i) => {
      const coerced = coerceInsertValue(d);
      const display =
        coerced === null
          ? 'NULL'
          : typeof coerced === 'string'
            ? `'${coerced}'`
            : String(coerced);
      return `-- $${i + 1} = ${display}`;
    })
    .join('\n');
  return `INSERT INTO ${tableRefFor(editable)} (${cols})\nVALUES (${placeholders});\n\n${args}`;
}

function pendingUpdatePreviewSql(editable: EditableConfig, edit: PendingEdit): string {
  const engine = editable.profile.engine;
  const where = edit.pkSnapshot
    .map(([col], i) => `${quoteFor(engine, col)} = $${i + 2}`)
    .join(' AND ');
  const args = edit.pkSnapshot
    .map(([col, val], i) => `-- $${i + 2} = ${renderCell(val)}  -- (${col})`)
    .join('\n');
  const colMeta = editable.tableColumns.find((c) => c.name === edit.column);
  const coerced = coerceCellValue(
    edit.newValue,
    colMeta?.data_type ?? '',
    colMeta?.nullable ?? true,
  );
  const newDisplay = coerced === null ? 'NULL' : renderCell(coerced);
  return `UPDATE ${tableRefFor(editable)}\nSET ${quoteFor(engine, edit.column)} = $1\nWHERE ${where};\n\n-- $1 = ${newDisplay}  -- new value (was: ${renderCell(edit.originalValue)})\n${args}`;
}

function deletePreviewSql(
  editable: EditableConfig,
  row: Record<string, unknown>,
): string {
  const where = editable.pkColumns
    .map((col, i) => `${quoteFor(editable.profile.engine, col)} = $${i + 1}`)
    .join(' AND ');
  const args = editable.pkColumns
    .map((col, i) => `-- $${i + 1} = ${renderCell(row[col])}`)
    .join('\n');
  return `DELETE FROM ${tableRefFor(editable)}\nWHERE ${where};\n\n${args}`;
}

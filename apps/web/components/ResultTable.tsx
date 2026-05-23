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
  ArrowUpRight,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FilterX,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
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
import { cn } from '@/lib/utils';
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
import type { Column as SchemaColumn, ForeignKey } from '@dbstudio/erd';
import { BulkInsertDialog } from '@/components/BulkInsertDialog';

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
  /** FKs declared on this table. Drives the per-cell "jump to referenced
   *  row" affordance in the result grid. Composite FKs are kept here
   *  intact but the in-cell jump only fires for single-column FKs (the
   *  ~95% case); the multi-column case would need a richer UI. */
  foreignKeys: ForeignKey[];
  /** Called after a successful insert or delete so the parent can refetch.
   *  Cell updates patch the grid row directly and don't need a refresh. */
  onChanged?: () => void;
  /** Called when the user clicks a FK cell's jump button. Opens the
   *  referenced table in a new SQL tab filtered by the FK value. Wired
   *  by the SQL workspace where the router is in scope. */
  onNavigateFk?: (target: {
    schema: string;
    table: string;
    column: string;
    value: unknown;
  }) => void;
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

/** What kind of input we should render for a given column's data_type.
 *  Drives both the visual control (number input, date picker, enum select)
 *  and the value coercion at insert time. Detection is dialect-aware:
 *  MySQL/MariaDB enums show up as `enum('a','b','c')` literals so we can
 *  parse the options; Postgres enums show up as the enum type name only
 *  (introspection doesn't fetch the option list yet), so they fall back
 *  to a plain text input. */
type InsertFieldKind =
  | { kind: 'enum'; options: string[] }
  | { kind: 'bool' }
  | { kind: 'int' }
  | { kind: 'number' }
  | { kind: 'date' }
  | { kind: 'time' }
  | { kind: 'datetime' }
  | { kind: 'json' }
  | { kind: 'uuid' }
  | { kind: 'text'; maxLength?: number };

/** Extract the literal options from a MySQL/MariaDB `enum('a','b','c')` or
 *  `set('a','b')` declaration. Tolerates the SQL escape `''` for an
 *  embedded single quote inside a literal. */
function parseEnumOptions(rawType: string): string[] {
  const opts: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawType)) !== null) {
    opts.push((m[1] ?? '').replace(/''/g, "'"));
  }
  return opts;
}

function detectFieldKind(
  dataType: string,
  enumOptions?: string[] | null,
): InsertFieldKind {
  const raw = dataType;
  const t = dataType.toLowerCase().trim();
  // Server-side enum metadata (Postgres user-defined enums) takes priority
  // over textual parsing — for `mood`-typed columns the data_type is just
  // the type name with no inline options to extract.
  if (enumOptions && enumOptions.length > 0) {
    return { kind: 'enum', options: enumOptions };
  }
  if (/^enum\s*\(/i.test(raw)) {
    return { kind: 'enum', options: parseEnumOptions(raw) };
  }
  if (/(^|\s)bool/.test(t)) return { kind: 'bool' };
  // Order matters: timestamp/datetime before date/time so a "timestamp"
  // column doesn't fall through to a date-only picker.
  if (/(timestamp|datetime)/.test(t)) return { kind: 'datetime' };
  if (/^date\b/.test(t)) return { kind: 'date' };
  if (/^time\b/.test(t)) return { kind: 'time' };
  if (/(^|\W)(int|serial|bigserial|smallserial)/.test(t)) return { kind: 'int' };
  if (/(numeric|decimal|real|double|float|money)/.test(t)) return { kind: 'number' };
  if (/(json|jsonb)/.test(t)) return { kind: 'json' };
  if (/uuid/.test(t)) return { kind: 'uuid' };
  const varMatch = t.match(/^(?:character varying|varchar|char)\s*\(\s*(\d+)\s*\)/);
  if (varMatch) return { kind: 'text', maxLength: Number(varMatch[1]) };
  return { kind: 'text' };
}

interface InsertDraft {
  name: string;
  data_type: string;
  nullable: boolean;
  hasDefault: boolean;
  include: boolean;
  value: string;
  kind: InsertFieldKind;
}

function buildInsertDraft(columns: SchemaColumn[]): InsertDraft[] {
  return columns.map((c) => ({
    name: c.name,
    data_type: c.data_type,
    nullable: c.nullable,
    hasDefault: c.default != null,
    include: !c.nullable && c.default == null,
    value: '',
    kind: detectFieldKind(c.data_type, c.enum_options),
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

  /** Map of local-column-name → referenced (schema, table, column), derived
   *  from `editable.foreignKeys`. Drives the in-cell jump affordance.
   *  Composite FKs are omitted — single-column is the ~95% case and the
   *  multi-column case needs a richer UI than a one-click button. */
  const fkTargetsByColumn = useMemo(() => {
    const m = new Map<
      string,
      { schema: string; table: string; column: string }
    >();
    if (!editable) return m;
    for (const fk of editable.foreignKeys) {
      if (fk.columns.length === 1 && fk.references_columns.length === 1) {
        m.set(fk.columns[0]!, {
          schema: fk.references_schema,
          table: fk.references_table,
          column: fk.references_columns[0]!,
        });
      }
    }
    return m;
  }, [editable]);

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

  /** Bulk-delete state. The user picks N rows via the grid's checkbox
   *  column, clicks "Delete N rows", reviews the generated DELETE
   *  statements, and confirms. We loop the existing single-row delete
   *  endpoint — keeps the backend surface tiny at the cost of one round
   *  trip per row, which is fine for the typical 1-20 rows you'd
   *  multi-select interactively. */
  const [selectedRows, setSelectedRows] = useState<Record<string, unknown>[]>([]);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteApplying, setBulkDeleteApplying] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);

  const [bulkInsertOpen, setBulkInsertOpen] = useState(false);

  /** When set, the JSON viewer dialog is open and showing this cell's
   *  parsed value as a collapsible tree. Driven by the per-cell expand
   *  button on json/jsonb columns. */
  const [jsonView, setJsonView] = useState<
    { column: string; value: unknown } | null
  >(null);

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

  /** Loop the single-row delete endpoint for every selected row. Stops at
   *  the first failure (the rest stay selected so the user can see what
   *  succeeded vs what didn't). Successful rows are spliced from the grid
   *  as they complete so progress is visible. */
  const applyBulkDelete = async () => {
    if (!editable || selectedRows.length === 0) return;
    setBulkDeleteError(null);
    setBulkDeleteApplying(true);
    const succeeded: Record<string, unknown>[] = [];
    try {
      for (const row of selectedRows) {
        const pk: Array<[string, unknown]> = editable.pkColumns.map((col) => [
          col,
          row[col],
        ]);
        const affected = await api.deleteRow(editable.profile, {
          schema: editable.schema,
          table: editable.table,
          pk,
        });
        if (affected !== 1) {
          throw {
            code: 'unexpected_rows',
            message: `Expected 1 row affected, got ${affected}.`,
          };
        }
        succeeded.push(row);
        gridApiRef.current?.applyTransaction({ remove: [row] });
      }
      setDisplayedCount((c) => Math.max(0, c - succeeded.length));
      setSelectedRows([]);
      setBulkDeleteOpen(false);
      editable.onChanged?.();
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      const msg = `${err.code ?? 'unknown'} · ${err.message ?? String(e)}`;
      setBulkDeleteError(
        succeeded.length > 0
          ? `${succeeded.length}/${selectedRows.length} succeeded before failure. ${msg}`
          : msg,
      );
      // Splice already-deleted rows out of the in-memory selection so a
      // retry doesn't re-issue them.
      if (succeeded.length > 0) {
        const remaining = selectedRows.filter((r) => !succeeded.includes(r));
        setSelectedRows(remaining);
        setDisplayedCount((c) => Math.max(0, c - succeeded.length));
      }
    } finally {
      setBulkDeleteApplying(false);
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
      const fkTarget = fkTargetsByColumn.get(c.name);
      const json = isJsonType(c.data_type);
      // JSON columns get a viewer button; FK columns get a jump button.
      // A single column rarely both — but if it did, FK wins because
      // the value is just a scalar key, not a real JSON payload.
      const cellRenderer = fkTarget
        ? FkCellRenderer
        : json
          ? JsonCellRenderer
          : undefined;
      const cellRendererParams = fkTarget
        ? { fkTarget, onNavigate: editable?.onNavigateFk }
        : json
          ? {
              onView: (value: unknown) =>
                setJsonView({ column: c.name, value: parseJsonCell(value) }),
            }
          : undefined;
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
        cellRenderer,
        cellRendererParams,
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
  }, [
    result.columns,
    pkColumnNames,
    editable,
    editableReady,
    openDelete,
    fkTargetsByColumn,
  ]);

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
          {editable && editableReady && selectedRows.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setBulkDeleteError(null);
                setBulkDeleteOpen(true);
              }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-destructive hover:bg-destructive/10"
              title={`Delete ${selectedRows.length} selected row${selectedRows.length === 1 ? '' : 's'}`}
            >
              <Trash2 className="h-3 w-3" />
              Delete {selectedRows.length}
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
          {editable && editableReady && (
            <button
              type="button"
              onClick={() => setBulkInsertOpen(true)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-background hover:text-foreground"
              title="Bulk-insert rows from pasted CSV"
            >
              <Upload className="h-3 w-3" />
              Bulk insert
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
            // Multi-row selection with a checkbox column — only on
            // editable result sets, otherwise there's nothing useful the
            // user can do with the selection. `headerCheckbox: true`
            // gives a "select all on this page" toggle.
            rowSelection={
              editable && editableReady
                ? {
                    mode: 'multiRow',
                    checkboxes: true,
                    headerCheckbox: true,
                    enableClickSelection: false,
                  }
                : undefined
            }
            onSelectionChanged={(e) => {
              const rows = e.api
                .getSelectedRows()
                .map((r) => r as Record<string, unknown>);
              setSelectedRows(rows);
            }}
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
                          <InsertFieldInput
                            draft={d}
                            onChange={(next) =>
                              setInsertDraft((prev) =>
                                prev.map((p, j) =>
                                  j === i ? { ...p, value: next } : p,
                                ),
                              )
                            }
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

      {/* JSON cell viewer — expandable tree view of the parsed value. */}
      <Dialog open={jsonView != null} onOpenChange={(o) => !o && setJsonView(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              {jsonView?.column}
            </DialogTitle>
            <DialogDescription>
              JSON value · click any{' '}
              <ChevronRight className="inline h-3 w-3" /> to collapse a
              branch.
            </DialogDescription>
          </DialogHeader>
          {jsonView && (
            <div className="scrollbar-hidden max-h-[60vh] overflow-y-auto rounded border bg-muted/30 p-3 font-mono text-xs">
              <JsonTreeNode value={jsonView.value} depth={0} initiallyOpen />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (!jsonView) return;
                void navigator.clipboard.writeText(
                  JSON.stringify(jsonView.value, null, 2),
                );
              }}
            >
              Copy as JSON
            </Button>
            <Button size="sm" onClick={() => setJsonView(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete preview — shows every DELETE statement that will
          run, then loops the single-row endpoint on apply. */}
      <Dialog
        open={bulkDeleteOpen}
        onOpenChange={(o) => !o && !bulkDeleteApplying && setBulkDeleteOpen(false)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Delete {selectedRows.length} row{selectedRows.length === 1 ? '' : 's'}?
            </DialogTitle>
            <DialogDescription>
              Each statement runs sequentially against the live database. If
              one fails the rest are skipped; rows already deleted stay
              gone. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          {editable && selectedRows.length > 0 && (
            <div className="max-h-[420px] space-y-2 overflow-y-auto">
              {selectedRows.map((row, i) => (
                <pre
                  key={i}
                  className="overflow-x-auto rounded border bg-muted/40 p-3 text-[11px] leading-relaxed"
                >
                  {deletePreviewSql(editable, row)}
                </pre>
              ))}
              {bulkDeleteError && (
                <p className="text-xs text-destructive">{bulkDeleteError}</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              disabled={bulkDeleteApplying}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={applyBulkDelete}
              disabled={bulkDeleteApplying || selectedRows.length === 0}
            >
              {bulkDeleteApplying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Delete {selectedRows.length} row
              {selectedRows.length === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editable && (
        <BulkInsertDialog
          open={bulkInsertOpen}
          onOpenChange={setBulkInsertOpen}
          profile={editable.profile}
          schema={editable.schema}
          table={editable.table}
          columns={editable.tableColumns}
          onChanged={editable.onChanged}
        />
      )}
    </div>
  );
}

// ---- Cell renderer for FK columns ---------------------------------------

/** Renders an FK column value with a hover-revealed jump button. Clicking
 *  the button asks the parent to open the referenced table filtered by
 *  this row's FK value — the typical "what does this foreign-key point at"
 *  workflow without leaving the workspace. NULL values render plainly
 *  with no jump button (nothing meaningful to jump to). */
function FkCellRenderer(
  params: ICellRendererParams & {
    fkTarget: { schema: string; table: string; column: string };
    onNavigate?: (target: {
      schema: string;
      table: string;
      column: string;
      value: unknown;
    }) => void;
  },
) {
  const value = params.value;
  const display = params.valueFormatted ?? renderCell(value);
  const hasValue = value !== null && value !== undefined && value !== '';
  return (
    <div className="group flex h-full items-center gap-1">
      <span
        className={cn(
          'flex-1 truncate',
          value === null && 'italic text-muted-foreground',
        )}
      >
        {display}
      </span>
      {hasValue && params.onNavigate && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            params.onNavigate?.({ ...params.fkTarget, value });
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
          title={`Open ${params.fkTarget.schema}.${params.fkTarget.table} where ${params.fkTarget.column} = ${display}`}
          aria-label="Jump to referenced row"
        >
          <ArrowUpRight className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// ---- JSON tree viewer ---------------------------------------------------

/** Recursive collapsible tree node for the JSON viewer. Objects and
 *  arrays expand to show their children; primitives render inline with a
 *  type-appropriate color. Always renders without external deps so we
 *  don't pull in a 30KB JSON-tree library for a tiny dialog. */
function JsonTreeNode({
  value,
  keyName,
  depth,
  initiallyOpen,
}: {
  value: unknown;
  keyName?: string | number;
  depth: number;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen ?? depth < 2);

  const renderKey = () =>
    keyName !== undefined ? (
      <span className="text-foreground/80">
        {typeof keyName === 'number' ? keyName : `"${keyName}"`}
        <span className="text-muted-foreground">:</span>{' '}
      </span>
    ) : null;

  if (value === null) {
    return (
      <div className="leading-relaxed">
        {renderKey()}
        <span className="text-muted-foreground">null</span>
      </div>
    );
  }
  if (typeof value === 'boolean') {
    return (
      <div className="leading-relaxed">
        {renderKey()}
        <span className="text-sky-600 dark:text-sky-400">{String(value)}</span>
      </div>
    );
  }
  if (typeof value === 'number') {
    return (
      <div className="leading-relaxed">
        {renderKey()}
        <span className="text-amber-600 dark:text-amber-400">{value}</span>
      </div>
    );
  }
  if (typeof value === 'string') {
    return (
      <div className="leading-relaxed">
        {renderKey()}
        <span className="break-all text-emerald-700 dark:text-emerald-400">
          &quot;{value}&quot;
        </span>
      </div>
    );
  }
  if (Array.isArray(value)) {
    const empty = value.length === 0;
    return (
      <div>
        <button
          type="button"
          onClick={() => !empty && setOpen((v) => !v)}
          className="flex items-center gap-1 leading-relaxed hover:text-foreground"
        >
          {!empty ? (
            open ? (
              <ChevronDown className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" />
            )
          ) : (
            <span className="w-3" />
          )}
          {renderKey()}
          <span className="text-muted-foreground">
            [{value.length} item{value.length === 1 ? '' : 's'}]
          </span>
        </button>
        {open && !empty && (
          <div className="ml-3 border-l border-border/60 pl-3">
            {value.map((v, i) => (
              <JsonTreeNode key={i} value={v} keyName={i} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const empty = entries.length === 0;
    return (
      <div>
        <button
          type="button"
          onClick={() => !empty && setOpen((v) => !v)}
          className="flex items-center gap-1 leading-relaxed hover:text-foreground"
        >
          {!empty ? (
            open ? (
              <ChevronDown className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" />
            )
          ) : (
            <span className="w-3" />
          )}
          {renderKey()}
          <span className="text-muted-foreground">
            {`{${entries.length} key${entries.length === 1 ? '' : 's'}}`}
          </span>
        </button>
        {open && !empty && (
          <div className="ml-3 border-l border-border/60 pl-3">
            {entries.map(([k, v]) => (
              <JsonTreeNode key={k} value={v} keyName={k} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }
  // Fallback for anything exotic (functions, symbols) — shouldn't happen
  // for JSON payloads but render gracefully.
  return (
    <div className="leading-relaxed">
      {renderKey()}
      <span className="text-muted-foreground">{String(value)}</span>
    </div>
  );
}

// ---- Cell renderer for JSON / JSONB columns ----------------------------

/** Renders a JSON cell with its stringified preview + a hover-revealed
 *  expand button. Click → opens a collapsible tree dialog. Avoids
 *  reflowing the cell when the JSON is huge; the user always sees a
 *  truncated single-line preview, and reaches for the dialog only when
 *  they want detail. */
function JsonCellRenderer(
  params: ICellRendererParams & { onView: (value: unknown) => void },
) {
  const value = params.value;
  const display = params.valueFormatted ?? renderCell(value);
  const hasValue = value !== null && value !== undefined && value !== '';
  return (
    <div className="group flex h-full items-center gap-1">
      <span
        className={cn(
          'flex-1 truncate',
          value === null && 'italic text-muted-foreground',
        )}
      >
        {display}
      </span>
      {hasValue && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            params.onView(value);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
          title="Expand JSON value"
          aria-label="Expand JSON value"
        >
          <Braces className="h-3 w-3" />
        </button>
      )}
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


/** Type-aware value input for the Insert row dialog. Picks an HTML input
 *  type / control based on the column's parsed `kind`:
 *
 *   - enum   → <select> with the parsed literal options
 *   - bool   → <select> with true / false (plus an empty option for NULL)
 *   - int    → <input type="number" step="1">
 *   - number → <input type="number">
 *   - date / time / datetime → corresponding HTML5 date pickers
 *   - text   → <input type="text"> with maxLength when known
 *
 *  Disabled when the column is excluded (default / NULL will be used).
 *  Validation: HTML5 attributes catch the most common typos; the database
 *  itself remains the authority on whether the value is acceptable. */
function InsertFieldInput({
  draft,
  onChange,
}: {
  draft: InsertDraft;
  onChange: (next: string) => void;
}) {
  const baseClass =
    'w-full rounded border border-input bg-background px-2 py-1 font-mono text-xs disabled:bg-muted/40 disabled:text-muted-foreground';

  const disabled = !draft.include;
  const placeholder = !draft.include
    ? draft.hasDefault
      ? '(default)'
      : draft.nullable
        ? '(NULL)'
        : ''
    : draft.nullable
      ? 'value or empty for NULL'
      : 'value';

  if (draft.kind.kind === 'enum') {
    const opts = draft.kind.options;
    return (
      <select
        value={draft.value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={baseClass}
        title={
          opts.length === 0
            ? 'No options parsed from the type — falling back to free text'
            : `Enum: ${opts.join(', ')}`
        }
      >
        <option value="">
          {draft.nullable || draft.hasDefault ? '(default / NULL)' : '— pick —'}
        </option>
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  if (draft.kind.kind === 'bool') {
    return (
      <select
        value={draft.value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={baseClass}
      >
        <option value="">
          {draft.nullable || draft.hasDefault ? '(default / NULL)' : '— pick —'}
        </option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (draft.kind.kind === 'int' || draft.kind.kind === 'number') {
    return (
      <input
        type="number"
        step={draft.kind.kind === 'int' ? '1' : 'any'}
        value={draft.value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={baseClass}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
    );
  }

  if (
    draft.kind.kind === 'date' ||
    draft.kind.kind === 'time' ||
    draft.kind.kind === 'datetime'
  ) {
    const htmlType =
      draft.kind.kind === 'date'
        ? 'date'
        : draft.kind.kind === 'time'
          ? 'time'
          : 'datetime-local';
    return (
      <input
        type={htmlType}
        value={draft.value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={baseClass}
      />
    );
  }

  return (
    <input
      type="text"
      value={draft.value}
      disabled={disabled}
      maxLength={draft.kind.kind === 'text' ? draft.kind.maxLength : undefined}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={baseClass}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
    />
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

function isJsonType(t: string): boolean {
  return /json/.test(t.toLowerCase());
}

/** Parse a JSON cell into a JS value. The backend may return jsonb as
 *  either an already-decoded object/array or as a JSON string depending
 *  on the driver path. Tolerates both, and returns the original value
 *  unmodified if parsing fails. */
function parseJsonCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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
  if (d.value === '') {
    return d.nullable ? null : '';
  }
  switch (d.kind.kind) {
    case 'int': {
      const n = Number(d.value);
      return Number.isFinite(n) ? Math.trunc(n) : d.value;
    }
    case 'number': {
      const n = Number(d.value);
      return Number.isFinite(n) ? n : d.value;
    }
    case 'bool': {
      const v = d.value.toLowerCase();
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
      return d.value;
    }
    // enum / date / time / datetime / json / uuid / text → string passthrough.
    default:
      return d.value;
  }
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

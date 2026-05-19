import { Handle, Position } from '@xyflow/react';
import clsx from 'clsx';

import type { Column } from './types';
import type { TableNodeData } from './layout';

/** Compact representation of a SQL type for in-node display. Full literal
 *  values (e.g. `enum('alpha','beta','gamma')`) get collapsed to just the
 *  kind so the row stays inside the node box; the full type is still
 *  available in the details drawer. */
function compactType(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  const lower = t.toLowerCase();
  if (lower.startsWith('enum(')) return 'enum';
  if (lower.startsWith('set(')) return 'set';
  // `character varying(255)` -> `varchar(255)`; just shorthand.
  if (lower.startsWith('character varying')) {
    return t.replace(/character varying/i, 'varchar');
  }
  return t;
}

interface TableNodeProps {
  data: TableNodeData;
  selected?: boolean;
}

/**
 * Visual representation of a database table for the ER diagram.
 *
 * Each column row may own one or both handles — a left-side `target` and a
 * right-side `source`. Both are conditional: we only render a handle on a
 * column that actually anchors an edge. Columns with neither incoming nor
 * outgoing FKs render no handles at all, so the canvas isn't littered with
 * floating dots on every row.
 */
export function TableNode({ data, selected }: TableNodeProps) {
  const { table, incomingFkColumns } = data;
  const pkColumns = new Set(table.primary_key?.columns ?? []);
  const fkSourceColumns = new Set<string>();
  for (const fk of table.foreign_keys) {
    for (const c of fk.columns) fkSourceColumns.add(c);
  }
  const fkTargetColumns = new Set<string>(incomingFkColumns);

  return (
    <div
      className={clsx(
        'w-[280px] rounded-md border bg-card text-card-foreground shadow-sm transition-shadow',
        selected ? 'ring-2 ring-ring shadow-md' : 'ring-0',
      )}
    >
      <div className="truncate border-b bg-secondary/60 px-3 py-1.5 text-[11px] font-semibold tracking-wide">
        <span className="text-muted-foreground">{table.schema}.</span>
        <span>{table.name}</span>
      </div>
      <ul className="divide-y text-xs">
        {table.columns.map((col) => (
          <ColumnRow
            key={col.name}
            column={col}
            isPk={pkColumns.has(col.name)}
            isFk={fkSourceColumns.has(col.name)}
            hasIncomingFk={fkTargetColumns.has(col.name)}
            hasOutgoingFk={fkSourceColumns.has(col.name)}
          />
        ))}
      </ul>
    </div>
  );
}

// Handles still need a non-zero hit area for React Flow to anchor edges to,
// but we render them dot-less so unused/used handles look the same and the
// connection lines emerge directly from the row edge.
const HANDLE_HIDDEN =
  '!h-[6px] !w-[6px] !min-h-0 !min-w-0 !rounded-full !border-0 !bg-transparent !opacity-0';

function ColumnRow({
  column,
  isPk,
  isFk,
  hasIncomingFk,
  hasOutgoingFk,
}: {
  column: Column;
  isPk: boolean;
  isFk: boolean;
  hasIncomingFk: boolean;
  hasOutgoingFk: boolean;
}) {
  return (
    <li
      className={clsx(
        'relative flex items-center gap-2 px-3 py-1 font-mono',
        isPk && 'bg-amber-50/70 dark:bg-amber-500/5',
        !isPk && isFk && 'bg-sky-50/60 dark:bg-sky-500/5',
      )}
    >
      {hasIncomingFk && (
        <Handle
          type="target"
          position={Position.Left}
          id={`${column.name}::target`}
          className={HANDLE_HIDDEN}
          isConnectable={false}
        />
      )}

      <span className="flex w-5 shrink-0 items-center justify-center">
        {isPk && <KeyIcon className="h-3 w-3 text-amber-500" title="Primary key" />}
        {!isPk && isFk && <LinkIcon className="h-3 w-3 text-sky-500" title="Foreign key" />}
      </span>

      <span
        className={clsx(
          'min-w-0 flex-1 truncate',
          column.nullable ? 'text-foreground/80' : 'font-semibold',
        )}
        title={column.name}
      >
        {column.name}
      </span>

      {/* Type stays on the same baseline as the name — fixed single line.
          Long literal types (enum('a','b'), character varying(255)) are
          collapsed via `compactType` so the row never overflows the node;
          the full type, default, and comment live in the details drawer
          opened by clicking the table header. */}
      <span
        className="shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground"
        title={column.data_type + (!column.nullable ? ' · NOT NULL' : '')}
      >
        {compactType(column.data_type)}
        {!column.nullable && <span className="ml-1 text-foreground/60">·NN</span>}
      </span>

      {hasOutgoingFk && (
        <Handle
          type="source"
          position={Position.Right}
          id={`${column.name}::source`}
          className={HANDLE_HIDDEN}
          isConnectable={false}
        />
      )}
    </li>
  );
}

function KeyIcon({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <path d="m21 2-9.6 9.6" />
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-3 3" />
      <path d="m18 5 3 3" />
    </svg>
  );
}

function LinkIcon({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
      <line x1="8" x2="16" y1="12" y2="12" />
    </svg>
  );
}

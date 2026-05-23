'use client';

// Right-side drawer that surfaces the full details for a single table from
// the schema diagram — columns (with the long literal types, defaults,
// comments), PK, outgoing FKs, incoming FKs from other tables, and indexes.
//
// The ER node intentionally renders only a compact summary so it fits in a
// ~280px box; everything that doesn't fit in that summary belongs here.

import { useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  X,
  KeyRound,
  Link2,
  ArrowRightFromLine,
  ArrowLeftToLine,
  Table2,
  Plus,
  Pencil,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Schema, Table, ForeignKey } from '@dbstudio/erd';
import type { ConnectionProfile } from '@/lib/types';
import { DdlDialog, type DdlMode } from '@/components/DdlDialog';

interface TableDetailsDrawerProps {
  schema: Schema;
  /** Schema-qualified target of the drawer. When null, the drawer is
   *  closed. The parent owns this state so navigation/close is centralised. */
  selection: { schema: string; table: string } | null;
  onClose: () => void;
  /** "Open in SQL workspace" action from the drawer footer — wired by the
   *  parent so the drawer doesn't need to know about routing. */
  onOpenInSql?: (schema: string, table: string) => void;
  /** Connection profile, threaded through so the DDL dialogs can run
   *  ALTER TABLE statements without the drawer having to import the
   *  whole api surface. When omitted, the per-column edit/drop and the
   *  Add Column action are hidden. */
  profile?: ConnectionProfile;
  /** Fires after a successful DDL apply so the parent can invalidate
   *  the schema cache and refetch. */
  onSchemaChange?: () => void;
}

export function TableDetailsDrawer({
  schema,
  selection,
  onClose,
  onOpenInSql,
  profile,
  onSchemaChange,
}: TableDetailsDrawerProps) {
  const open = selection != null;
  const table = open ? findTable(schema, selection.schema, selection.table) : null;
  const incoming = open && table ? collectIncoming(schema, table) : [];

  /** Active DDL operation. Setting this opens the DdlDialog in the
   *  matching mode. Cleared when the dialog closes (cancel or apply). */
  const [ddl, setDdl] = useState<DdlMode | null>(null);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed right-0 top-0 z-50 flex h-full w-full max-w-[420px] flex-col border-l bg-background shadow-xl',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
            'duration-200',
          )}
        >
          {table ? (
            <>
              <header className="flex items-start justify-between gap-2 border-b px-4 py-3">
                <div className="min-w-0">
                  <DialogPrimitive.Title className="flex items-center gap-2 text-sm font-semibold">
                    <Table2 className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="truncate font-mono">
                      <span className="text-muted-foreground">{table.schema}.</span>
                      <span>{table.name}</span>
                    </span>
                  </DialogPrimitive.Title>
                  {table.comment && (
                    <DialogPrimitive.Description className="mt-1 text-[11px] text-muted-foreground">
                      {table.comment}
                    </DialogPrimitive.Description>
                  )}
                </div>
                <DialogPrimitive.Close className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
              </header>

              <div className="scrollbar-hidden flex-1 overflow-y-auto px-4 py-3">
                <Columns
                  table={table}
                  editable={Boolean(profile)}
                  onAdd={() =>
                    setDdl({ kind: 'add', schema: table.schema, table: table.name })
                  }
                  onRename={(col) =>
                    setDdl({
                      kind: 'rename',
                      schema: table.schema,
                      table: table.name,
                      column: col,
                    })
                  }
                  onDrop={(col) =>
                    setDdl({
                      kind: 'drop',
                      schema: table.schema,
                      table: table.name,
                      column: col,
                    })
                  }
                />
                <PrimaryKeyBlock table={table} />
                <ForeignKeysBlock fks={table.foreign_keys} />
                <IncomingRefsBlock refs={incoming} />
                <IndexesBlock table={table} />
              </div>

              {onOpenInSql && (
                <footer className="border-t bg-muted/30 p-3">
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      onOpenInSql(table.schema, table.name);
                      onClose();
                    }}
                  >
                    Open in SQL workspace
                  </Button>
                </footer>
              )}
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <p className="text-xs text-muted-foreground">
                Table not found in the current schema.
              </p>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>

      {profile && (
        <DdlDialog
          profile={profile}
          mode={ddl}
          onClose={() => setDdl(null)}
          onChanged={() => {
            setDdl(null);
            onSchemaChange?.();
          }}
        />
      )}
    </DialogPrimitive.Root>
  );
}

// --- sections ------------------------------------------------------------

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 mt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground first:mt-0">
      {children}
    </h3>
  );
}

function Columns({
  table,
  editable,
  onAdd,
  onRename,
  onDrop,
}: {
  table: Table;
  editable: boolean;
  onAdd: () => void;
  onRename: (column: string) => void;
  onDrop: (column: string) => void;
}) {
  const pkSet = new Set(table.primary_key?.columns ?? []);
  const fkSet = new Set<string>();
  for (const fk of table.foreign_keys) for (const c of fk.columns) fkSet.add(c);

  return (
    <section>
      <div className="mb-1.5 mt-4 flex items-center justify-between first:mt-0">
        <SectionHeader>Columns ({table.columns.length})</SectionHeader>
        {editable && (
          <button
            type="button"
            onClick={onAdd}
            className="-mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Add a new column"
          >
            <Plus className="h-3 w-3" />
            Add column
          </button>
        )}
      </div>
      <ul className="divide-y rounded border">
        {table.columns.map((col) => (
          <li
            key={col.name}
            className="group flex flex-col gap-0.5 px-2.5 py-1.5"
          >
            <div className="flex items-center gap-1.5">
              {pkSet.has(col.name) ? (
                <KeyRound
                  className="h-3 w-3 shrink-0 text-amber-500"
                  aria-label="Primary key"
                />
              ) : fkSet.has(col.name) ? (
                <Link2
                  className="h-3 w-3 shrink-0 text-sky-500"
                  aria-label="Foreign key"
                />
              ) : (
                <span className="w-3" />
              )}
              <span
                className={cn(
                  'truncate font-mono text-xs',
                  !col.nullable && 'font-semibold',
                )}
              >
                {col.name}
              </span>
              {!col.nullable && (
                <span className="ml-auto rounded bg-muted px-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                  not null
                </span>
              )}
              {editable && (
                <span className="ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => onRename(col.name)}
                    className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                    title="Rename column"
                    aria-label={`Rename ${col.name}`}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDrop(col.name)}
                    className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    title="Drop column"
                    aria-label={`Drop ${col.name}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              )}
            </div>
            <div className="ml-[18px] flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="break-all font-mono text-[10px] text-foreground/80">
                {col.data_type}
              </span>
              {col.default != null && (
                <span className="break-all text-[10px] text-muted-foreground">
                  default <span className="font-mono">{col.default}</span>
                </span>
              )}
            </div>
            {col.comment && (
              <p className="ml-[18px] text-[10px] italic text-muted-foreground">
                {col.comment}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PrimaryKeyBlock({ table }: { table: Table }) {
  const pk = table.primary_key;
  if (!pk || pk.columns.length === 0) return null;
  return (
    <section>
      <SectionHeader>Primary key</SectionHeader>
      <div className="rounded border px-2.5 py-1.5">
        <span className="font-mono text-xs">{pk.columns.join(', ')}</span>
        {pk.name && (
          <span className="ml-2 text-[10px] text-muted-foreground">({pk.name})</span>
        )}
      </div>
    </section>
  );
}

function ForeignKeysBlock({ fks }: { fks: ForeignKey[] }) {
  if (fks.length === 0) return null;
  return (
    <section>
      <SectionHeader>Foreign keys ({fks.length})</SectionHeader>
      <ul className="space-y-1.5">
        {fks.map((fk) => (
          <li key={fk.name} className="rounded border px-2.5 py-1.5">
            <div className="flex items-center gap-1.5 text-xs">
              <ArrowRightFromLine className="h-3 w-3 shrink-0 text-sky-500" />
              <span className="truncate font-mono">{fk.columns.join(', ')}</span>
              <span className="text-muted-foreground">→</span>
              <span className="truncate font-mono">
                {fk.references_schema}.{fk.references_table}
                <span className="text-muted-foreground">
                  ({fk.references_columns.join(', ')})
                </span>
              </span>
            </div>
            {(fk.on_delete || fk.on_update) && (
              <div className="ml-[18px] mt-0.5 flex gap-3 text-[10px] text-muted-foreground">
                {fk.on_delete && <span>on delete {fk.on_delete}</span>}
                {fk.on_update && <span>on update {fk.on_update}</span>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface IncomingRef {
  fromSchema: string;
  fromTable: string;
  fromColumns: string[];
  toColumns: string[];
  name: string;
}

function IncomingRefsBlock({ refs }: { refs: IncomingRef[] }) {
  if (refs.length === 0) return null;
  return (
    <section>
      <SectionHeader>Referenced by ({refs.length})</SectionHeader>
      <ul className="space-y-1.5">
        {refs.map((r) => (
          <li key={`${r.fromSchema}.${r.fromTable}.${r.name}`} className="rounded border px-2.5 py-1.5">
            <div className="flex items-center gap-1.5 text-xs">
              <ArrowLeftToLine className="h-3 w-3 shrink-0 text-emerald-500" />
              <span className="truncate font-mono">
                {r.fromSchema}.{r.fromTable}
                <span className="text-muted-foreground">
                  ({r.fromColumns.join(', ')})
                </span>
              </span>
              <span className="text-muted-foreground">→</span>
              <span className="truncate font-mono">{r.toColumns.join(', ')}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function IndexesBlock({ table }: { table: Table }) {
  // Filter out the PK index — already shown in the Primary key section, no
  // need to repeat it here.
  const indexes = table.indexes.filter((idx) => !idx.primary);
  if (indexes.length === 0) return null;
  return (
    <section>
      <SectionHeader>Indexes ({indexes.length})</SectionHeader>
      <ul className="space-y-1">
        {indexes.map((idx) => (
          <li
            key={idx.name}
            className="flex items-center gap-2 rounded border px-2.5 py-1.5 text-xs"
          >
            <span className="truncate font-mono">{idx.name}</span>
            <span className="truncate text-muted-foreground">
              ({idx.columns.join(', ')})
            </span>
            {idx.unique && (
              <span className="ml-auto rounded bg-muted px-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                unique
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- helpers -------------------------------------------------------------

function findTable(schema: Schema, schemaName: string, tableName: string): Table | null {
  for (const ns of schema.schemas) {
    if (ns.name !== schemaName) continue;
    for (const t of ns.tables) {
      if (t.name === tableName) return t;
    }
  }
  return null;
}

/** Walk every FK in the schema and collect the ones that point at the target
 *  table. Used to populate the "Referenced by" section. */
function collectIncoming(schema: Schema, target: Table): IncomingRef[] {
  const out: IncomingRef[] = [];
  for (const ns of schema.schemas) {
    for (const t of ns.tables) {
      for (const fk of t.foreign_keys) {
        if (
          fk.references_schema === target.schema &&
          fk.references_table === target.name
        ) {
          out.push({
            fromSchema: t.schema,
            fromTable: t.name,
            fromColumns: fk.columns,
            toColumns: fk.references_columns,
            name: fk.name,
          });
        }
      }
    }
  }
  return out;
}

'use client';

// Single dialog for the table-edit DDL operations triggered from the
// TableDetailsDrawer: add column, rename column, drop column. Each
// mode shows a small form, a generated-SQL preview, and an Apply
// button that runs the SQL via the standard runQuery endpoint.

import { useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ConnectionProfile } from '@/lib/types';
import { api } from '@/lib/api';
import {
  buildAddColumn,
  buildDropColumn,
  buildRenameColumn,
} from '@/lib/buildDdl';

export type DdlMode =
  | { kind: 'add'; schema: string; table: string }
  | {
      kind: 'rename';
      schema: string;
      table: string;
      column: string;
    }
  | { kind: 'drop'; schema: string; table: string; column: string };

interface Props {
  profile: ConnectionProfile;
  mode: DdlMode | null;
  onClose: () => void;
  /** Fires after a successful Apply so the parent can invalidate the
   *  schema cache and re-render the drawer with the new table shape. */
  onChanged?: () => void;
}

export function DdlDialog({ profile, mode, onClose, onChanged }: Props) {
  const open = mode != null;

  // Each mode reuses the same dialog, so reset local form state
  // whenever the mode changes. Doing this in an effect keyed off
  // `mode?.kind` keeps the previous form values from bleeding into a
  // freshly-opened add-column dialog.
  const [name, setName] = useState('');
  const [dataType, setDataType] = useState('text');
  const [nullable, setNullable] = useState(true);
  const [defaultValue, setDefaultValue] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    setName('');
    setDataType('text');
    setNullable(true);
    setDefaultValue('');
    setRenameTo(mode?.kind === 'rename' ? mode.column : '');
    setError(null);
    setApplying(false);
    setAcknowledged(false);
  }, [mode?.kind, mode && 'column' in mode ? mode.column : null]);

  const sql = (() => {
    if (!mode) return '';
    if (mode.kind === 'add') {
      if (!name.trim() || !dataType.trim()) return '';
      return buildAddColumn(profile.engine, mode.schema, mode.table, {
        name: name.trim(),
        dataType: dataType.trim(),
        nullable,
        default: defaultValue.trim() || null,
      });
    }
    if (mode.kind === 'rename') {
      if (!renameTo.trim() || renameTo.trim() === mode.column) return '';
      return buildRenameColumn(
        profile.engine,
        mode.schema,
        mode.table,
        mode.column,
        renameTo.trim(),
      );
    }
    return buildDropColumn(profile.engine, mode.schema, mode.table, mode.column);
  })();

  const ready =
    sql.length > 0 && !applying && (mode?.kind !== 'drop' || acknowledged);

  const apply = async () => {
    if (!sql) return;
    setError(null);
    setApplying(true);
    try {
      await api.runQuery(profile, { sql });
      onChanged?.();
      onClose();
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setError(`${err.code ?? 'unknown'} · ${err.message ?? String(e)}`);
    } finally {
      setApplying(false);
    }
  };

  const title =
    mode?.kind === 'add'
      ? 'Add column'
      : mode?.kind === 'rename'
        ? 'Rename column'
        : 'Drop column';
  const destructive = mode?.kind === 'drop';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !applying && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {mode && (
            <DialogDescription>
              <span className="font-mono">
                {mode.schema}.{mode.table}
              </span>
              {'column' in mode && (
                <>
                  {' · '}
                  <span className="font-mono">{mode.column}</span>
                </>
              )}
            </DialogDescription>
          )}
        </DialogHeader>

        {mode?.kind === 'add' && (
          <div className="space-y-3">
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="column_name"
                className="w-full rounded border border-input bg-background px-2 py-1 font-mono text-xs"
                autoFocus
                spellCheck={false}
              />
            </Field>
            <Field label="Type">
              <input
                value={dataType}
                onChange={(e) => setDataType(e.target.value)}
                placeholder="text, int, timestamp, jsonb…"
                className="w-full rounded border border-input bg-background px-2 py-1 font-mono text-xs"
                spellCheck={false}
              />
            </Field>
            <Field label="Default (optional, raw SQL)">
              <input
                value={defaultValue}
                onChange={(e) => setDefaultValue(e.target.value)}
                placeholder="now() · '0' · NULL"
                className="w-full rounded border border-input bg-background px-2 py-1 font-mono text-xs"
                spellCheck={false}
              />
            </Field>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={nullable}
                onChange={(e) => setNullable(e.target.checked)}
              />
              Allow NULL
            </label>
          </div>
        )}

        {mode?.kind === 'rename' && (
          <Field label="New name">
            <input
              value={renameTo}
              onChange={(e) => setRenameTo(e.target.value)}
              className="w-full rounded border border-input bg-background px-2 py-1 font-mono text-xs"
              autoFocus
              spellCheck={false}
            />
          </Field>
        )}

        {mode?.kind === 'drop' && (
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I understand this drops the column and the data in it. Cannot
              be undone.
            </span>
          </label>
        )}

        {sql && (
          <pre className="overflow-x-auto rounded border bg-muted/40 p-3 text-[11px] leading-relaxed">
            {sql}
          </pre>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={applying}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={apply}
            disabled={!ready}
          >
            {applying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : destructive ? (
              <Trash2 className="h-3.5 w-3.5" />
            ) : null}
            {destructive ? 'Drop column' : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

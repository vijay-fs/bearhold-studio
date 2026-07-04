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
import type { ConnectionProfile, DatabaseEngine } from '@/lib/types';
import { api } from '@/lib/api';
import {
  buildAddColumn,
  buildAlterColumnType,
  buildDropColumn,
  buildRenameColumn,
} from '@/lib/buildDdl';
import { ENGINE_TYPES, isPresetType } from '@/lib/engineDataTypes';

export type DdlMode =
  | { kind: 'add'; schema: string; table: string }
  | {
      kind: 'rename';
      schema: string;
      table: string;
      column: string;
    }
  | {
      /** Existing-column editor. Allows changing both name and data
       *  type in a single dialog; emits up to two ALTER statements
       *  on Apply, in the right order so neither one references a
       *  stale identifier. The dialog seeds its fields from the
       *  current column metadata passed in. */
      kind: 'edit';
      schema: string;
      table: string;
      column: string;
      currentType: string;
      nullable: boolean;
      default?: string | null;
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
  const defaultTypeForEngine = engineDefaultType(profile.engine);
  const [name, setName] = useState('');
  const [dataType, setDataType] = useState(defaultTypeForEngine);
  const [nullable, setNullable] = useState(true);
  const [defaultValue, setDefaultValue] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (mode?.kind === 'edit') {
      setName(mode.column);
      setRenameTo(mode.column);
      setDataType(mode.currentType);
      setNullable(mode.nullable);
      setDefaultValue(mode.default ?? '');
    } else {
      setName('');
      setDataType(engineDefaultType(profile.engine));
      setNullable(true);
      setDefaultValue('');
      setRenameTo(mode?.kind === 'rename' ? mode.column : '');
    }
    setError(null);
    setApplying(false);
    setAcknowledged(false);
  }, [
    mode?.kind,
    mode && 'column' in mode ? mode.column : null,
    profile.engine,
  ]);

  // For the edit mode we may need to emit two statements (rename +
  // type change). Build them as an array so the Apply path can fire
  // them sequentially and a failed type-change reports against the
  // current name, not the freshly-renamed one.
  const sqlStatements: string[] = (() => {
    if (!mode) return [];
    if (mode.kind === 'add') {
      if (!name.trim() || !dataType.trim()) return [];
      return [
        buildAddColumn(profile.engine, mode.schema, mode.table, {
          name: name.trim(),
          dataType: dataType.trim(),
          nullable,
          default: defaultValue.trim() || null,
        }),
      ];
    }
    if (mode.kind === 'rename') {
      if (!renameTo.trim() || renameTo.trim() === mode.column) return [];
      return [
        buildRenameColumn(
          profile.engine,
          mode.schema,
          mode.table,
          mode.column,
          renameTo.trim(),
        ),
      ];
    }
    if (mode.kind === 'edit') {
      const out: string[] = [];
      const newType = dataType.trim();
      const newName = renameTo.trim();
      const typeChanged =
        newType.length > 0 &&
        newType.toLowerCase() !== mode.currentType.toLowerCase();
      const nullableChanged = nullable !== mode.nullable;
      const defaultChanged =
        (defaultValue.trim() || null) !== (mode.default ?? null);
      const nameChanged = newName.length > 0 && newName !== mode.column;
      // Type / nullable / default all live on the same per-engine
      // statement for MySQL (MODIFY COLUMN restates everything), so
      // any of them flipping triggers one emit. PG emits a single
      // ALTER COLUMN TYPE; we don't currently surface SET NOT NULL /
      // SET DEFAULT for PG inside `edit` (rename + drop cover the
      // common cases), but the path here will emit type changes
      // safely either way.
      if (typeChanged || nullableChanged || defaultChanged) {
        try {
          out.push(
            buildAlterColumnType(profile.engine, mode.schema, mode.table, {
              oldName: mode.column,
              dataType: newType || mode.currentType,
              nullable,
              default: defaultValue.trim() || null,
            }),
          );
        } catch (e) {
          // SQLite — surface the engine limitation via the error
          // banner instead of generating bad SQL.
          const msg = e instanceof Error ? e.message : String(e);
          return [`-- ${msg}`];
        }
      }
      if (nameChanged) {
        out.push(
          buildRenameColumn(
            profile.engine,
            mode.schema,
            mode.table,
            mode.column,
            newName,
          ),
        );
      }
      return out;
    }
    return [
      buildDropColumn(profile.engine, mode.schema, mode.table, mode.column),
    ];
  })();
  const sql = sqlStatements.join('\n');

  // SQL containing only a `-- ...` comment is the engine-limitation
  // surface (see SQLite branch in `buildAlterColumnType`); treat it
  // as not-ready so the user sees the message but can't Apply it.
  const validStatements = sqlStatements.filter(
    (s) => s.length > 0 && !s.trim().startsWith('--'),
  );
  const blockedByLimitation = sqlStatements.some((s) =>
    s.trim().startsWith('--'),
  );
  const ready =
    validStatements.length > 0 &&
    !applying &&
    !blockedByLimitation &&
    (mode?.kind !== 'drop' || acknowledged);

  const apply = async () => {
    if (validStatements.length === 0) return;
    setError(null);
    setApplying(true);
    try {
      // Edit mode can emit two statements (type change + rename).
      // Run them sequentially so an early failure doesn't leave the
      // table in a half-applied state with no signal to the user.
      for (const stmt of validStatements) {
        await api.runQuery(profile, { sql: stmt });
      }
      // Drop the pool after any successful DDL. Postgres pools cache
      // prepared-statement plans per connection (sqlx is the same);
      // those plans were planned against the OLD column shape and
      // raise `0A000 cached plan must not change result type` on
      // the next SELECT *. Reconnecting clears the pool so the next
      // query is replanned against the new schema. Cheap one-off
      // cost vs. a confusing "run-twice" footgun for the user. We
      // best-effort here — if the reconnect itself fails, the DDL
      // still went through and the user can hit the Reconnect
      // button in the workspace header.
      await api.reconnect(profile).catch(() => {});
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
        : mode?.kind === 'edit'
          ? 'Edit column'
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
              <TypeSelect
                engine={profile.engine}
                value={dataType}
                onChange={setDataType}
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

        {mode?.kind === 'edit' && (
          <div className="space-y-3">
            <Field label="Name">
              <input
                value={renameTo}
                onChange={(e) => setRenameTo(e.target.value)}
                className="w-full rounded border border-input bg-background px-2 py-1 font-mono text-xs"
                autoFocus
                spellCheck={false}
              />
            </Field>
            <Field label="Type">
              <TypeSelect
                engine={profile.engine}
                value={dataType}
                onChange={setDataType}
              />
            </Field>
            <Field label="Default (optional, raw SQL)">
              <input
                value={defaultValue}
                onChange={(e) => setDefaultValue(e.target.value)}
                placeholder="now() · '0' · NULL · (empty to drop default)"
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
            {profile.engine === 'sqlite' && (
              <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
                SQLite cannot ALTER a column&apos;s type in place. Only the
                name can be changed from this dialog.
              </p>
            )}
            {profile.engine === 'mysql' && (
              <p className="text-[10px] text-muted-foreground">
                MySQL&apos;s <code>MODIFY COLUMN</code> restates the full
                column. Nullable + default are re-emitted from the form
                values above; leave them unchanged to preserve.
              </p>
            )}
          </div>
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

/**
 * Engine-aware data type picker. Shows a native <select> grouped by
 * type family for the common case, plus a "Custom…" entry that flips
 * the control to a free-text input so power users can type
 * `varchar(120)` / `numeric(10,4)` / domain types we don't enumerate.
 *
 * The component starts in Custom mode whenever the incoming value
 * doesn't match any preset — that's the case for edit-mode where the
 * current column type might be `varchar(60)` or `enum(...)`, neither
 * of which is in the curated list.
 */
function TypeSelect({
  engine,
  value,
  onChange,
}: {
  engine: DatabaseEngine;
  value: string;
  onChange: (next: string) => void;
}) {
  const groups = ENGINE_TYPES[engine];
  const presetMatches = isPresetType(engine, value);
  const [custom, setCustom] = useState(!presetMatches);

  useEffect(() => {
    // When the parent feeds a fresh value (e.g. opening edit mode
    // for a new column), re-decide whether to render the dropdown
    // or the custom input.
    setCustom(!isPresetType(engine, value));
  }, [engine, value]);

  if (custom) {
    return (
      <div className="flex items-stretch gap-1">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="varchar(120), numeric(10,4), …"
          className="flex-1 rounded border border-input bg-background px-2 py-1 font-mono text-xs"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => {
            const first = groups[0]?.types[0] ?? '';
            setCustom(false);
            onChange(first);
          }}
          className="shrink-0 rounded border border-input px-2 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Switch back to the preset list"
        >
          Presets
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-stretch gap-1">
      <select
        value={value}
        onChange={(e) => {
          if (e.target.value === '__custom__') {
            setCustom(true);
            return;
          }
          onChange(e.target.value);
        }}
        className="flex-1 rounded border border-input bg-background px-2 py-1 font-mono text-xs"
      >
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </optgroup>
        ))}
        <option value="__custom__">Custom…</option>
      </select>
    </div>
  );
}

/** Sensible default type for the Add Column form, per engine. PG goes
 *  with `text`, MySQL with `VARCHAR(255)`, SQLite with `TEXT`. */
function engineDefaultType(engine: DatabaseEngine): string {
  switch (engine) {
    case 'postgres':
      return 'text';
    case 'mysql':
      return 'VARCHAR(255)';
    case 'sqlite':
      return 'TEXT';
    default:
      return 'text';
  }
}

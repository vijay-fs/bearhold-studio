'use client';

// MongoDB document browser — the workspace for Mongo connections.
//
// Layout, top to bottom:
//   - Database/collection picker row
//   - Filter / sort JSON inputs + Find button
//   - Results: paginated document list (Compass-style "cards" with a
//     collapsible JSON tree per document)
//   - Selected document drawer on the right with the full JSON tree
//
// Writes (insert/update/delete) are explicitly out of scope for the
// MVP — they need a separate confirm-and-preview pass and a careful
// $set/$replace decision. They'll come in Phase 2.

import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Database,
  FileJson,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import type { ConnectionProfile, MongoFindResponse } from '@/lib/types';
import { cn } from '@/lib/utils';

const DEFAULT_LIMIT = 20;

type FindState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; data: MongoFindResponse; database: string; collection: string }
  | { kind: 'error'; code: string; message: string };

interface MongoBrowserProps {
  profile: ConnectionProfile;
}

export function MongoBrowser({ profile }: MongoBrowserProps) {
  const [databases, setDatabases] = useState<string[]>([]);
  const [collectionsByDb, setCollectionsByDb] = useState<Record<string, string[]>>({});
  const [database, setDatabase] = useState<string>('');
  const [collection, setCollection] = useState<string>('');
  const [filter, setFilter] = useState('{}');
  const [sort, setSort] = useState('{ "_id": -1 }');
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [skip, setSkip] = useState(0);
  const [find, setFind] = useState<FindState>({ kind: 'idle' });
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [loadingColls, setLoadingColls] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  /** Open the editor dialog with this state. `insert` starts blank;
   *  `edit` is pre-filled with the focused document's JSON. Replace-
   *  one runs on Apply; insert-one runs for the insert variant. */
  const [editor, setEditor] = useState<
    | null
    | { mode: 'insert' }
    | { mode: 'edit'; document: Record<string, unknown> }
  >(null);
  const [pendingDelete, setPendingDelete] = useState<Record<string, unknown> | null>(null);

  // Load databases on mount. Errors here usually mean the connection
  // can't reach Mongo at all — surface them in the workspace rather
  // than letting the user wonder why nothing's listed.
  useEffect(() => {
    let cancelled = false;
    setLoadingDbs(true);
    setInitError(null);
    api.mongo
      .listDatabases(profile)
      .then((dbs) => {
        if (cancelled) return;
        setDatabases(dbs);
        if (dbs.length > 0 && !database) setDatabase(dbs[0]!);
      })
      .catch((e: { code?: string; message?: string }) => {
        if (cancelled) return;
        setInitError(`${e.code ?? 'unknown'} · ${e.message ?? 'failed to list databases'}`);
      })
      .finally(() => !cancelled && setLoadingDbs(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);

  // Lazy-load collections per database, cached so switching back to a
  // database we've already seen is instant.
  useEffect(() => {
    if (!database) return;
    if (collectionsByDb[database]) return;
    let cancelled = false;
    setLoadingColls(true);
    api.mongo
      .listCollections(profile, database)
      .then((colls) => {
        if (cancelled) return;
        setCollectionsByDb((prev) => ({ ...prev, [database]: colls }));
        if (colls.length > 0 && !collection) setCollection(colls[0]!);
      })
      .catch((e: { code?: string; message?: string }) => {
        if (cancelled) return;
        setInitError(`${e.code ?? 'unknown'} · ${e.message ?? 'failed to list collections'}`);
      })
      .finally(() => !cancelled && setLoadingColls(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database, profile.id]);

  const collections = database ? collectionsByDb[database] ?? [] : [];

  /** Reset paging + selection when the collection changes. Otherwise
   *  the user clicks "users" expecting page 1 and sees skip=80 still
   *  applied from the previous collection. */
  useEffect(() => {
    setSkip(0);
    setSelectedIdx(null);
  }, [collection, database]);

  /** Parse a JSON snippet that might be empty (treat as `{}`). Returns
   *  null on parse failure so callers can render a friendly error
   *  instead of throwing. */
  const safeJson = (raw: string): Record<string, unknown> | null => {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const v = JSON.parse(trimmed);
      return typeof v === 'object' && v != null && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  const runFind = async (opts?: { newSkip?: number }) => {
    if (!database || !collection) return;
    const parsedFilter = safeJson(filter);
    const parsedSort = safeJson(sort);
    if (parsedFilter === null) {
      setFind({ kind: 'error', code: 'invalid_filter', message: 'Filter must be a JSON object.' });
      return;
    }
    if (parsedSort === null) {
      setFind({ kind: 'error', code: 'invalid_sort', message: 'Sort must be a JSON object.' });
      return;
    }
    const useSkip = opts?.newSkip ?? skip;
    setFind({ kind: 'loading' });
    setSelectedIdx(null);
    try {
      const data = await api.mongo.find(profile, {
        database,
        collection,
        filter: parsedFilter,
        sort: parsedSort,
        limit,
        skip: useSkip,
      });
      setSkip(useSkip);
      setFind({ kind: 'ok', data, database, collection });
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setFind({
        kind: 'error',
        code: err.code ?? 'unknown',
        message: err.message ?? String(e),
      });
    }
  };

  // Selected doc — recomputed when the user clicks a different row.
  const selectedDoc = useMemo(() => {
    if (find.kind !== 'ok' || selectedIdx == null) return null;
    return find.data.documents[selectedIdx] ?? null;
  }, [find, selectedIdx]);

  if (initError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-5">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" />
            <span className="text-sm font-semibold">Couldn&apos;t reach MongoDB</span>
          </div>
          <p className="mt-1 break-all text-xs text-muted-foreground">{initError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* DB / collection picker + paging info */}
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5">
        <Selector
          label="Database"
          value={database}
          onChange={(v) => {
            setDatabase(v);
            setCollection('');
          }}
          options={databases}
          loading={loadingDbs}
        />
        <Selector
          label="Collection"
          value={collection}
          onChange={setCollection}
          options={collections}
          loading={loadingColls}
        />
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          {find.kind === 'ok' && (
            <>
              <span className="font-mono">
                {find.data.documents.length} doc
                {find.data.documents.length === 1 ? '' : 's'}
              </span>
              <span>·</span>
              <span>~{find.data.approx_total.toLocaleString()} total</span>
              <span>·</span>
              <span className="font-mono">{find.data.elapsed_ms} ms</span>
            </>
          )}
        </div>
      </header>

      {/* Filter / sort / Find button */}
      <div className="flex flex-wrap items-end gap-2 border-b px-4 py-2">
        <JsonField
          label="Filter"
          value={filter}
          onChange={setFilter}
          placeholder='{ "active": true }'
        />
        <JsonField
          label="Sort"
          value={sort}
          onChange={setSort}
          placeholder='{ "createdAt": -1 }'
        />
        <div className="flex flex-col">
          <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Limit
          </label>
          <Input
            type="number"
            min={1}
            max={1000}
            value={limit}
            onChange={(e) => setLimit(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))}
            className="h-8 w-20 font-mono text-xs"
          />
        </div>
        <Button
          size="sm"
          onClick={() => void runFind({ newSkip: 0 })}
          disabled={!collection || find.kind === 'loading'}
        >
          {find.kind === 'loading' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          Find
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void runFind({ newSkip: skip })}
          disabled={!collection || find.kind === 'loading'}
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEditor({ mode: 'insert' })}
          disabled={!collection || find.kind === 'loading'}
          title="Insert a new document"
        >
          <Plus className="h-3 w-3" />
          Insert
        </Button>
      </div>

      {/* Body — document list + selected-doc drawer */}
      <div className="flex min-h-0 flex-1">
        <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
          {find.kind === 'idle' && (
            <p className="p-4 text-xs text-muted-foreground">
              Pick a collection and click <span className="font-medium">Find</span> to load
              documents.
            </p>
          )}
          {find.kind === 'loading' && (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Loading documents...
            </div>
          )}
          {find.kind === 'error' && (
            <div className="rounded border border-destructive/30 bg-destructive/5 p-3">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-4 w-4" />
                <span className="text-sm font-semibold">Find failed</span>
              </div>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                <span className="font-mono">{find.code}</span> · {find.message}
              </p>
            </div>
          )}
          {find.kind === 'ok' && find.data.documents.length === 0 && (
            <p className="p-4 text-xs text-muted-foreground">No documents matched.</p>
          )}
          {find.kind === 'ok' && find.data.documents.length > 0 && (
            <ul className="space-y-2">
              {find.data.documents.map((doc, i) => (
                <DocumentCard
                  key={i}
                  index={i + skip}
                  doc={doc}
                  selected={selectedIdx === i}
                  onSelect={() => setSelectedIdx(i)}
                />
              ))}
            </ul>
          )}
        </div>

        {/* Selected-doc drawer */}
        {selectedDoc && (
          <aside className="hidden w-[420px] shrink-0 border-l bg-muted/20 lg:flex lg:flex-col">
            <header className="flex items-center justify-between border-b px-3 py-2">
              <div className="flex items-center gap-2">
                <FileJson className="h-3.5 w-3.5" />
                <span className="text-xs font-semibold">Document</span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedIdx(null)}
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Close document view"
              >
                ×
              </button>
            </header>
            <div className="scrollbar-thin flex-1 overflow-y-auto p-3 font-mono text-[11px]">
              <JsonTree value={selectedDoc} initiallyOpen depth={0} />
            </div>
            <footer className="flex flex-col gap-2 border-t bg-muted/30 p-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() =>
                  void navigator.clipboard.writeText(JSON.stringify(selectedDoc, null, 2))
                }
              >
                Copy JSON
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => setEditor({ mode: 'edit', document: selectedDoc })}
                >
                  <Pencil className="h-3 w-3" />
                  Edit
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="flex-1"
                  onClick={() => setPendingDelete(selectedDoc)}
                >
                  <Trash2 className="h-3 w-3" />
                  Delete
                </Button>
              </div>
            </footer>
          </aside>
        )}
      </div>

      {/* Footer paging — only shows once we have a result. Disabled
          gracefully at boundaries so the user can't paginate past the
          last page (approx_total is an estimate so we still let them
          step forward when at exactly its boundary). */}
      {find.kind === 'ok' && find.data.documents.length > 0 && (
        <footer className="flex items-center justify-end gap-2 border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
          <span>
            Showing {skip + 1}–{skip + find.data.documents.length}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runFind({ newSkip: Math.max(0, skip - limit) })}
            disabled={skip === 0 || find.kind !== 'ok'}
          >
            ← Prev
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runFind({ newSkip: skip + limit })}
            disabled={find.data.documents.length < limit}
          >
            Next →
          </Button>
        </footer>
      )}

      <DocumentEditorDialog
        profile={profile}
        database={database}
        collection={collection}
        editor={editor}
        onClose={() => setEditor(null)}
        onApplied={() => {
          setEditor(null);
          void runFind({ newSkip: skip });
        }}
      />

      <DeleteConfirmDialog
        profile={profile}
        database={database}
        collection={collection}
        document={pendingDelete}
        onClose={() => setPendingDelete(null)}
        onApplied={() => {
          setPendingDelete(null);
          setSelectedIdx(null);
          void runFind({ newSkip: skip });
        }}
      />
    </div>
  );
}

// ---- write dialogs -------------------------------------------------------

function DocumentEditorDialog({
  profile,
  database,
  collection,
  editor,
  onClose,
  onApplied,
}: {
  profile: ConnectionProfile;
  database: string;
  collection: string;
  editor:
    | null
    | { mode: 'insert' }
    | { mode: 'edit'; document: Record<string, unknown> };
  onClose: () => void;
  onApplied: () => void;
}) {
  const [text, setText] = useState('');
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the textarea whenever the dialog (re)opens. Insert starts
  // with a minimal template; edit gets the document pretty-printed
  // so the user sees what they're editing in full.
  useEffect(() => {
    if (!editor) return;
    setError(null);
    if (editor.mode === 'insert') {
      setText(`{\n  \n}`);
    } else {
      setText(JSON.stringify(editor.document, null, 2));
    }
  }, [editor]);

  if (!editor) return null;
  const isEdit = editor.mode === 'edit';

  const apply = async () => {
    let parsed: Record<string, unknown>;
    try {
      const v = JSON.parse(text);
      if (typeof v !== 'object' || v == null || Array.isArray(v)) {
        throw new Error('top-level value must be an object');
      }
      parsed = v as Record<string, unknown>;
    } catch (e: unknown) {
      setError(`invalid JSON: ${(e as Error).message}`);
      return;
    }

    setApplying(true);
    setError(null);
    try {
      if (isEdit) {
        const modified = await api.mongo.replaceOne(profile, database, collection, parsed);
        if (modified !== 1) {
          setError(`expected 1 row modified, got ${modified}`);
          setApplying(false);
          return;
        }
      } else {
        await api.mongo.insertOne(profile, database, collection, parsed);
      }
      onApplied();
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setError(`${err.code ?? 'unknown'} · ${err.message ?? String(e)}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={editor != null} onOpenChange={(o) => !o && !applying && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? 'Edit document' : 'Insert document'}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono">{database}.{collection}</span>
            {isEdit && ' · the document is replaced wholesale; the existing _id is used as the filter.'}
            {!isEdit && ' · _id is generated server-side if you omit it.'}
          </DialogDescription>
        </DialogHeader>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className="scrollbar-thin h-72 w-full resize-y rounded border border-input bg-background p-3 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={applying}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying}>
            {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {isEdit ? 'Apply replace' : 'Insert document'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteConfirmDialog({
  profile,
  database,
  collection,
  document,
  onClose,
  onApplied,
}: {
  profile: ConnectionProfile;
  database: string;
  collection: string;
  document: Record<string, unknown> | null;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!document) return null;
  const id = document._id;
  const idDisplay = id === undefined ? '(no _id)' : JSON.stringify(id);

  const apply = async () => {
    if (id === undefined) {
      setError('document has no _id — refusing to delete');
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const deleted = await api.mongo.deleteOne(profile, database, collection, id);
      if (deleted !== 1) {
        setError(`expected 1 deleted, got ${deleted}`);
        setApplying(false);
        return;
      }
      onApplied();
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setError(`${err.code ?? 'unknown'} · ${err.message ?? String(e)}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !applying && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete document?</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{database}.{collection}</span> · _id:{' '}
            <code className="font-mono">{idDisplay}</code>
            <br />
            This deletes the document from MongoDB. Can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={applying}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={apply} disabled={applying}>
            {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Delete document
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- helpers --------------------------------------------------------------

function Selector({
  label,
  value,
  onChange,
  options,
  loading,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: string[];
  loading?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="flex items-center gap-1">
        <Database className="h-3 w-3 text-muted-foreground" />
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={loading}
          className="h-7 rounded border border-input bg-background px-1.5 font-mono text-xs"
        >
          {value === '' && <option value="">{loading ? 'loading…' : 'pick one'}</option>}
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function JsonField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex min-w-[200px] flex-1 flex-col">
      <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        className="h-8 w-full rounded border border-input bg-background px-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
      />
    </div>
  );
}

function DocumentCard({
  index,
  doc,
  selected,
  onSelect,
}: {
  index: number;
  doc: Record<string, unknown>;
  selected: boolean;
  onSelect: () => void;
}) {
  // The compact preview shows the first few top-level keys inline —
  // _id always first, then up to 3 others. Mirrors Compass's row
  // collapse so users can scan a long result list quickly.
  const id = formatScalar(doc._id);
  const keys = Object.keys(doc).filter((k) => k !== '_id').slice(0, 3);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'group block w-full rounded border bg-card px-3 py-2 text-left text-xs transition-colors hover:border-foreground/30',
          selected && 'border-primary/60 ring-1 ring-primary/30',
        )}
      >
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            #{index + 1}
          </span>
          <span className="font-mono text-[11px] text-foreground/90">
            <span className="text-muted-foreground">_id:</span> {id}
          </span>
        </div>
        {keys.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
            {keys.map((k) => (
              <span key={k}>
                <span className="text-foreground/70">{k}:</span> {formatScalar(doc[k])}
              </span>
            ))}
            {Object.keys(doc).length > keys.length + 1 && (
              <span className="italic">+{Object.keys(doc).length - keys.length - 1} more</span>
            )}
          </div>
        )}
      </button>
    </li>
  );
}

/** Render a top-level value as a single-line preview. Truncates strings
 *  past ~40 chars, collapses objects/arrays to their type+size shape so
 *  the row stays one line. */
function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') {
    return v.length > 40 ? `"${v.slice(0, 37)}…"` : `"${v}"`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    // Extended-JSON shorthands the user recognises:
    if (typeof obj.$oid === 'string') return `ObjectId(${obj.$oid})`;
    if (typeof obj.$date === 'string') return obj.$date;
    if (typeof obj.$numberLong === 'string') return obj.$numberLong;
    return `Object(${Object.keys(obj).length} keys)`;
  }
  return String(v);
}

/** Recursive collapsible JSON viewer — shares the visual style of the
 *  result-grid's JSON cell viewer but lives here as its own component
 *  so the Mongo workspace stays self-contained. */
function JsonTree({
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
              <JsonTree key={i} value={v} keyName={i} depth={depth + 1} />
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
              <JsonTree key={k} value={v} keyName={k} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="leading-relaxed">
      {renderKey()}
      <span className="text-muted-foreground">{String(value)}</span>
    </div>
  );
}

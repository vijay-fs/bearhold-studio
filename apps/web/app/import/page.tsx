'use client';

// Import workspace.
//
// Flow:
//   1. Pick a source file via the native open dialog.
//   2. Rust `detect_dump_format` sniffs magic bytes; UI shows what
//      it thinks it is + gives the user a chance to override.
//   3. Pick target connection (filtered to matching engine).
//   4. If the tool bundle isn't installed → ToolInstallPrompt.
//   5. Options form (transaction wrap, stop-on-error, etc).
//   6. Run — stderr streams into the log, cancel kills the child,
//      success invalidates the target's schema cache so the sidebar
//      picks up the new tables.

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  Check,
  FileText,
  FolderOpen,
  Loader2,
  StopCircle,
  Upload,
} from 'lucide-react';

import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { ToolInstallPrompt } from '@/components/ToolInstallPrompt';
import { useConnections } from '@/store/connections';
import { useSchemaCache } from '@/store/schemaCache';
import { useToolCache } from '@/store/toolCache';
import { api } from '@/lib/api';
import { ENGINE_LABELS, type ConnectionProfile } from '@/lib/types';
import {
  bundleKeyForEngine,
  formatBytes,
  type DumpFormat,
  type DumpProbe,
  type ImportProgress,
} from '@/lib/tools';

const SUPPORTED_ENGINES = new Set(['postgres', 'mysql', 'sqlite']);

type RunState =
  | { kind: 'idle' }
  | { kind: 'running'; jobId: string; startedAt: number }
  | { kind: 'ok'; elapsedMs: number }
  | { kind: 'error'; message: string };

function ImportPageInner() {
  const profiles = useConnections((s) => s.profiles);
  const invalidateSchema = useSchemaCache((s) => s.invalidate);
  const refreshTools = useToolCache((s) => s.refresh);
  const searchParams = useSearchParams();
  const initialId = searchParams.get('cid') ?? '';

  const [probe, setProbe] = useState<DumpProbe | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [format, setFormat] = useState<DumpFormat | null>(null);
  const [targetId, setTargetId] = useState(initialId);

  useEffect(() => {
    void refreshTools();
  }, [refreshTools]);

  const target = profiles.find((p) => p.id === targetId);
  const engineForFormat = engineForDumpFormat(format);

  const bundleKey = engineForFormat ? bundleKeyForEngine(engineForFormat) : '';
  const bundle = useToolCache((s) =>
    bundleKey ? s.bundles.find((b) => b.bundle_key === bundleKey) : undefined,
  );
  const toolReady = bundle?.installed ?? false;

  const pickFile = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const chosen = await open({
      title: 'Import from…',
      multiple: false,
      directory: false,
      filters: [
        {
          name: 'Database dumps',
          extensions: ['sql', 'dump', 'tar', 'sqlite', 'db', 'jsonl', 'rdb'],
        },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!chosen || typeof chosen !== 'string') return;
    setProbeError(null);
    setProbe(null);
    try {
      const result = await api.detectDumpFormat(chosen);
      setProbe(result);
      setFormat(result.format);
      // Pre-select a target connection that matches the detected
      // engine — usually the only supported one.
      const engine = engineForDumpFormat(result.format);
      if (engine && !target) {
        const guess = profiles.find((p) => p.engine === engine);
        if (guess) setTargetId(guess.id);
      }
    } catch (e: unknown) {
      const err = e as { message?: string };
      setProbeError(err.message ?? String(e));
    }
  };

  return (
    <AppShell>
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Upload className="h-5 w-5" />
            Import database
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Load a dump into a target connection. Format is auto-detected
            from the file&apos;s magic bytes; you can override before
            running.
          </p>
        </header>

        <section>
          <FieldLabel>Source file</FieldLabel>
          <Button variant="outline" onClick={pickFile} className="justify-start">
            <FolderOpen className="h-3.5 w-3.5" />
            <span className="truncate">
              {probe ? probe.path : 'Choose file…'}
            </span>
          </Button>
          {probe && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <FileText className="h-3 w-3" />
                {formatBytes(probe.size_bytes)}
              </span>
              <span>{probe.description}</span>
            </div>
          )}
          {probeError && (
            <div className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{probeError}</span>
            </div>
          )}
        </section>

        {probe && (
          <section>
            <FieldLabel>Detected format</FieldLabel>
            <FormatOverride value={format} onChange={setFormat} />
          </section>
        )}

        <section>
          <FieldLabel>Target connection</FieldLabel>
          <ConnectionPicker
            value={targetId}
            onChange={setTargetId}
            profiles={profiles}
            filterEngine={engineForFormat ?? null}
          />
        </section>

        {target &&
          engineForFormat &&
          target.engine !== engineForFormat && (
            <EngineMismatch
              detected={engineForFormat}
              target={target.engine}
            />
          )}

        {target && bundleKey && !toolReady && (
          <ToolInstallPrompt
            bundleKey={bundleKey}
            title={`${ENGINE_LABELS[target.engine]} tools needed`}
            onInstalled={() => void refreshTools()}
          />
        )}

        {target &&
          format &&
          toolReady &&
          engineForFormat === target.engine && (
            <ImportRunner
              target={target}
              probe={probe!}
              format={format}
              onDone={() => invalidateSchema(target.id)}
            />
          )}
      </div>
    </AppShell>
  );
}

// --- Sub-components -----------------------------------------------

function ImportRunner({
  target,
  probe,
  format,
  onDone,
}: {
  target: ConnectionProfile;
  probe: DumpProbe;
  format: DumpFormat;
  onDone: () => void;
}) {
  const [singleTx, setSingleTx] = useState(true);
  const [dropBeforeCreate, setDropBeforeCreate] = useState(false);
  const [noOwner, setNoOwner] = useState(true);
  const [stopOnError, setStopOnError] = useState(true);

  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (run.kind !== 'running') return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const off = await listen<ImportProgress>(
        'dbstudio://import/progress',
        (e) => {
          const payload = e.payload;
          if (payload.job_id !== run.jobId) return;
          if (payload.kind === 'stderr') {
            setLog((prev) => appendCapped(prev, payload.line, 500));
          }
        },
      );
      if (cancelled) off();
      else unlisten = off;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [run.kind, run.kind === 'running' ? run.jobId : null]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log.length]);

  const start = async () => {
    setLog([]);
    const started = Date.now();
    setRun({ kind: 'running', jobId: 'pending', startedAt: started });
    try {
      await api.startImport({
        profile: target,
        source_path: probe.path,
        format,
        single_transaction: singleTx,
        drop_before_create: dropBeforeCreate,
        no_owner: noOwner,
        parallel_jobs: null,
        stop_on_error: stopOnError,
      });
      setRun({ kind: 'ok', elapsedMs: Date.now() - started });
      onDone();
    } catch (e: unknown) {
      const err = e as { message?: string };
      setRun({ kind: 'error', message: err?.message ?? String(e) });
    }
  };

  const cancel = async () => {
    if (run.kind !== 'running') return;
    await api.cancelImport(run.jobId).catch(() => false);
    setRun({ kind: 'error', message: 'Cancelled by user.' });
  };

  const isPg = target.engine === 'postgres';
  const isCustomPg =
    isPg && (format === 'pg_custom' || format === 'pg_tar');

  return (
    <div className="space-y-5">
      <fieldset className="space-y-2 rounded border p-3">
        <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Options
        </legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={singleTx}
            onChange={(e) => setSingleTx(e.target.checked)}
          />
          Wrap in a single transaction (rollback on any error)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={stopOnError}
            onChange={(e) => setStopOnError(e.target.checked)}
          />
          Stop on first error
        </label>
        {isCustomPg && (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={dropBeforeCreate}
                onChange={(e) => setDropBeforeCreate(e.target.checked)}
              />
              Drop matching objects before recreating (<code>--clean --if-exists</code>)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={noOwner}
                onChange={(e) => setNoOwner(e.target.checked)}
              />
              Skip ownership + privileges (<code>--no-owner --no-privileges</code>)
            </label>
          </>
        )}
      </fieldset>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          {run.kind === 'running' && (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Importing…</span>
            </>
          )}
          {run.kind === 'ok' && (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-600" />
              <span>
                Done in {(run.elapsedMs / 1000).toFixed(1)}s. Schema cache invalidated.
              </span>
            </>
          )}
          {run.kind === 'error' && (
            <>
              <AlertCircle className="h-3.5 w-3.5 text-destructive" />
              <span className="text-destructive">{run.message}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {run.kind === 'running' ? (
            <Button variant="destructive" size="sm" onClick={cancel}>
              <StopCircle className="h-3.5 w-3.5" />
              Cancel
            </Button>
          ) : (
            <Button size="sm" onClick={start}>
              <Upload className="h-3.5 w-3.5" />
              Start import
            </Button>
          )}
        </div>
      </div>

      {log.length > 0 && (
        <div
          ref={logRef}
          className="scrollbar-thin max-h-64 overflow-auto rounded border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed"
        >
          {log.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap">{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function FormatOverride({
  value,
  onChange,
}: {
  value: DumpFormat | null;
  onChange: (f: DumpFormat) => void;
}) {
  const options: { value: DumpFormat; label: string }[] = [
    { value: 'pg_custom', label: 'PostgreSQL custom (pg_restore)' },
    { value: 'pg_tar', label: 'PostgreSQL tar (pg_restore)' },
    { value: 'pg_plain', label: 'PostgreSQL plain SQL (psql)' },
    { value: 'mysql_plain', label: 'MySQL plain SQL (mysql)' },
    { value: 'sqlite_file', label: 'SQLite database file' },
    { value: 'sqlite_plain', label: 'SQLite plain SQL (sqlite3)' },
  ];
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value as DumpFormat)}
      className="w-full rounded border bg-background px-2 py-1.5 text-sm"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function ConnectionPicker({
  value,
  onChange,
  profiles,
  filterEngine,
}: {
  value: string;
  onChange: (id: string) => void;
  profiles: ConnectionProfile[];
  filterEngine: string | null;
}) {
  const options: ComboboxOption[] = useMemo(
    () =>
      profiles
        .filter((p) => SUPPORTED_ENGINES.has(p.engine))
        .filter((p) => !filterEngine || p.engine === filterEngine)
        .map((p) => ({
          value: p.id,
          label: p.name,
          hint: ENGINE_LABELS[p.engine],
          keywords: [p.engine, p.host, p.database].filter(Boolean) as string[],
        })),
    [profiles, filterEngine],
  );
  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={options}
      placeholder="— pick a connection —"
      emptyLabel={filterEngine ? `No ${filterEngine} connections` : 'No connections'}
    />
  );
}

function EngineMismatch({
  detected,
  target,
}: {
  detected: string;
  target: string;
}) {
  return (
    <div className="rounded border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-200">
      Dump looks like <span className="font-medium">{ENGINE_LABELS[detected as never] ?? detected}</span>{' '}
      but the target is{' '}
      <span className="font-medium">{ENGINE_LABELS[target as never] ?? target}</span>.
      Pick a matching target or override the format above if the detection
      was wrong.
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}

function engineForDumpFormat(f: DumpFormat | null): string | null {
  if (!f) return null;
  switch (f) {
    case 'pg_custom':
    case 'pg_tar':
    case 'pg_plain':
      return 'postgres';
    case 'mysql_plain':
      return 'mysql';
    case 'sqlite_file':
    case 'sqlite_plain':
      return 'sqlite';
    case 'mongo_bson_dir':
    case 'jsonl':
      return 'mongodb';
    case 'redis_rdb':
      return 'redis';
    default:
      return null;
  }
}

function appendCapped(prev: string[], line: string, cap: number): string[] {
  const next = [...prev, line];
  if (next.length > cap) next.splice(0, next.length - cap);
  return next;
}

export default function ImportPage() {
  return (
    <Suspense fallback={null}>
      <ImportPageInner />
    </Suspense>
  );
}

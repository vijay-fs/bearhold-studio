'use client';

// Export workspace.
//
// Flow:
//   1. Pick a source connection (Combobox).
//   2. If the engine's tool bundle isn't installed → show
//      ToolInstallPrompt and short-circuit until it lands.
//   3. Format + options form (engine-appropriate).
//   4. Pick destination via native save dialog.
//   5. Run — stream stderr into a scrollable log, byte-count into the
//      progress badge, Cancel button kills the child.
//   6. On success, show the destination path + "Reveal in Finder"
//      link.
//
// The whole run stays inside a single component instance: we don't
// route away, so the sessionStorage progress persistence isn't needed.

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  Check,
  Download,
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
import { useToolCache } from '@/store/toolCache';
import { api } from '@/lib/api';
import { ENGINE_LABELS, type ConnectionProfile } from '@/lib/types';
import {
  bundleKeyForEngine,
  formatBytes,
  type ExportFormat,
  type ExportProgress,
} from '@/lib/tools';

// Engines this page supports today. NoSQL + others show a "coming soon"
// note rather than a broken form.
const SUPPORTED_ENGINES = new Set(['postgres', 'mysql', 'sqlite']);

type RunState =
  | { kind: 'idle' }
  | { kind: 'running'; jobId: string; startedAt: number }
  | { kind: 'ok'; outputPath: string; bytes: number; elapsedMs: number }
  | { kind: 'error'; message: string };

function ExportPageInner() {
  const profiles = useConnections((s) => s.profiles);
  const refreshTools = useToolCache((s) => s.refresh);
  const applyToolProgress = useToolCache((s) => s.applyProgress);
  const searchParams = useSearchParams();

  // Deep-linked source id (e.g. from a connection card or the palette).
  const initialId = searchParams.get('cid') ?? '';
  const [sourceId, setSourceId] = useState(initialId);
  const source = profiles.find((p) => p.id === sourceId);

  useEffect(() => {
    void refreshTools();
  }, [refreshTools]);

  // Once installed, the tool cache surfaces bundle.installed = true —
  // gate the workflow on that.
  const bundleKey = source ? bundleKeyForEngine(source.engine) : '';
  const bundle = useToolCache((s) =>
    bundleKey ? s.bundles.find((b) => b.bundle_key === bundleKey) : undefined,
  );
  // Ready = bundle downloaded OR every tool found on system PATH.
  // Most macOS/Linux users have pg_dump / mysqldump already, so we
  // skip the download prompt entirely for them.
  const toolReady = bundle?.ready ?? false;
  const engineSupported = source ? SUPPORTED_ENGINES.has(source.engine) : false;
  // SQLite file-copy needs no external tool, so we short-circuit
  // the install gate for that specific case below.

  return (
    <AppShell>
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Download className="h-5 w-5" />
            Export database
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Dump a source database to a portable file. Uses <code>pg_dump</code>
            &nbsp;/&nbsp;<code>mysqldump</code>&nbsp;/&nbsp;<code>sqlite3</code>{' '}
            under the hood.
          </p>
        </header>

        <section>
          <FieldLabel>Source connection</FieldLabel>
          <ConnectionPicker
            value={sourceId}
            onChange={setSourceId}
            profiles={profiles}
          />
        </section>

        {source && !engineSupported && (
          <NotSupported engine={source.engine} />
        )}

        {/* Tool status is always rendered when a source is picked:
            green "ready" panel when the tools are already available
            (bundle installed OR on system PATH), or the download +
            install-hint prompt when they're not. Keeping the panel
            visible in the ready case gives the user confidence about
            which binary the run will actually use. */}
        {source && engineSupported && bundleKey && (
          <ToolInstallPrompt
            bundleKey={bundleKey}
            title={`${ENGINE_LABELS[source.engine]} tools`}
            subtitle={
              toolReady
                ? undefined
                : `Bearhold needs ${bundle?.display_name ?? 'these tools'} to dump this database.`
            }
            onInstalled={() => {
              void refreshTools();
              applyToolProgress({
                bundle_key: bundleKey,
                phase: 'done',
              });
            }}
          />
        )}

        {source && engineSupported && toolReady && (
          <ExportRunner source={source} />
        )}
      </div>
    </AppShell>
  );
}

// --- Sub-components -----------------------------------------------

function ExportRunner({ source }: { source: ConnectionProfile }) {
  const [format, setFormat] = useState<ExportFormat>(
    defaultFormatFor(source.engine),
  );
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [includeSchema, setIncludeSchema] = useState(true);
  const [includeData, setIncludeData] = useState(true);
  const [dropBeforeCreate, setDropBeforeCreate] = useState(false);
  const [singleTx, setSingleTx] = useState(true);
  const [noOwner, setNoOwner] = useState(true);
  const [tablesRaw, setTablesRaw] = useState('');

  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  const [log, setLog] = useState<string[]>([]);
  const [bytesWritten, setBytesWritten] = useState(0);
  // Ref mirror of `bytesWritten`. The `start` async function runs
  // for the whole duration of the export; its closure captures the
  // state variable at call time and never sees updates from the
  // event listener. Reading `bytesWrittenRef.current` in the final
  // `setRun({ kind: 'ok', ...})` step is the fix — the ref is always
  // the latest value.
  const bytesWrittenRef = useRef(0);
  useEffect(() => {
    bytesWrittenRef.current = bytesWritten;
  }, [bytesWritten]);
  const logRef = useRef<HTMLDivElement>(null);

  const pickDest = async () => {
    // tauri-plugin-dialog. `save` returns null on cancel; we don't
    // touch state in that case so the user can retry cleanly.
    const { save } = await import('@tauri-apps/plugin-dialog');
    const suggestedName = suggestedFileName(source, format);
    const chosen = await save({
      defaultPath: suggestedName,
      title: 'Export destination',
      filters: filterFor(format),
    });
    if (chosen) setOutputPath(chosen);
  };

  // Wire progress events for the current job. Reset when the job id
  // changes so a re-run starts with a clean log.
  useEffect(() => {
    if (run.kind !== 'running') return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const off = await listen<ExportProgress>(
        'dbstudio://export/progress',
        (e) => {
          const payload = e.payload;
          if (payload.job_id !== run.jobId) return;
          if (payload.kind === 'stderr') {
            setLog((prev) => appendCapped(prev, payload.line, 500));
          } else {
            setBytesWritten(payload.written);
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

  // Auto-scroll the log to the bottom when new lines arrive.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log.length]);

  const start = async () => {
    if (!outputPath) return;
    setLog([]);
    setBytesWritten(0);
    bytesWrittenRef.current = 0;
    const startedAt = Date.now();
    setRun({ kind: 'running', jobId: 'pending', startedAt });
    try {
      const tables = tablesRaw
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      const result = await api.startExport({
        profile: source,
        output_path: outputPath,
        format,
        include_schema: includeSchema,
        include_data: includeData,
        tables,
        drop_before_create: dropBeforeCreate,
        no_owner: noOwner,
        single_transaction: singleTx,
        parallel_jobs: null,
      });
      // Read the latest byte count from the ref (state closure is
      // stale). Also fall back to a live stat of the output file so
      // even engines that don't emit the final progress event show
      // the real size — this is what fixed the "Wrote 0 B" bug on
      // SQLite exports.
      let finalBytes = bytesWrittenRef.current;
      if (finalBytes === 0) {
        finalBytes = await statFileSize(result.output_path);
      }
      setRun({
        kind: 'ok',
        outputPath: result.output_path,
        bytes: finalBytes,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (e: unknown) {
      const err = e as { message?: string };
      setRun({ kind: 'error', message: err?.message ?? String(e) });
    }
  };

  const cancel = async () => {
    if (run.kind !== 'running') return;
    await api.cancelExport(run.jobId).catch(() => false);
    setRun({ kind: 'error', message: 'Cancelled by user.' });
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormatSelect engine={source.engine} value={format} onChange={setFormat} />
        <DestinationPicker value={outputPath} onPick={pickDest} />
      </div>

      <fieldset className="space-y-2 rounded border p-3">
        <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Content
        </legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeSchema}
            onChange={(e) => setIncludeSchema(e.target.checked)}
          />
          Schema (CREATE TABLE, indexes, sequences)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeData}
            onChange={(e) => setIncludeData(e.target.checked)}
          />
          Data
        </label>
        <label className="mt-1 flex flex-col gap-1 text-sm">
          <span>
            Restrict to tables{' '}
            <span className="text-[11px] text-muted-foreground">
              (space or comma-separated; leave empty for whole DB)
            </span>
          </span>
          <input
            type="text"
            value={tablesRaw}
            onChange={(e) => setTablesRaw(e.target.value)}
            placeholder="public.users public.orders"
            className="rounded border bg-background px-2 py-1 font-mono text-[12px]"
          />
        </label>
      </fieldset>

      {(source.engine === 'postgres' || source.engine === 'mysql') && (
        <fieldset className="space-y-2 rounded border p-3">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Advanced
          </legend>
          {source.engine === 'postgres' && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={dropBeforeCreate}
                  onChange={(e) => setDropBeforeCreate(e.target.checked)}
                />
                Drop before create (<code>--clean --if-exists</code>)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={noOwner}
                  onChange={(e) => setNoOwner(e.target.checked)}
                />
                Strip ownership + privileges (<code>--no-owner --no-privileges</code>)
              </label>
            </>
          )}
          {source.engine === 'mysql' && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={singleTx}
                onChange={(e) => setSingleTx(e.target.checked)}
              />
              Single transaction (recommended for InnoDB)
            </label>
          )}
        </fieldset>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          {run.kind === 'running' && (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Writing {formatBytes(bytesWritten)}…</span>
            </>
          )}
          {run.kind === 'ok' && (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-600" />
              <span>
                Wrote {formatBytes(run.bytes)} in {(run.elapsedMs / 1000).toFixed(1)}s ·{' '}
                <span className="font-mono">{run.outputPath}</span>
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
            <Button
              size="sm"
              onClick={start}
              disabled={!outputPath}
            >
              <Upload className="h-3.5 w-3.5" />
              Start export
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

function FormatSelect({
  engine,
  value,
  onChange,
}: {
  engine: string;
  value: ExportFormat;
  onChange: (f: ExportFormat) => void;
}) {
  const options = useMemo(() => formatsFor(engine), [engine]);
  return (
    <label className="flex flex-col gap-1">
      <FieldLabel>Format</FieldLabel>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ExportFormat)}
        className="rounded border bg-background px-2 py-1.5 text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function DestinationPicker({
  value,
  onPick,
}: {
  value: string | null;
  onPick: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <FieldLabel>Destination</FieldLabel>
      <Button
        variant="outline"
        size="sm"
        onClick={onPick}
        className="justify-start"
      >
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="truncate">
          {value ?? 'Choose file…'}
        </span>
      </Button>
    </div>
  );
}

function ConnectionPicker({
  value,
  onChange,
  profiles,
}: {
  value: string;
  onChange: (id: string) => void;
  profiles: ConnectionProfile[];
}) {
  const options: ComboboxOption[] = profiles
    .filter((p) => SUPPORTED_ENGINES.has(p.engine))
    .map((p) => ({
      value: p.id,
      label: p.name,
      hint: ENGINE_LABELS[p.engine],
      keywords: [p.engine, p.host, p.database].filter(Boolean) as string[],
    }));
  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={options}
      placeholder="— pick a connection —"
      emptyLabel="No supported connections."
    />
  );
}

function NotSupported({ engine }: { engine: string }) {
  return (
    <div className="rounded border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-200">
      Export from <span className="font-medium">{ENGINE_LABELS[engine as never] ?? engine}</span>{' '}
      isn&apos;t wired up yet. Postgres, MySQL, and SQLite are supported today.
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}

// --- Helpers ------------------------------------------------------

function defaultFormatFor(engine: string): ExportFormat {
  switch (engine) {
    case 'postgres':
      return 'pg_custom';
    case 'mysql':
      return 'mysql_plain';
    case 'sqlite':
      return 'sqlite_file_copy';
    default:
      return 'pg_custom';
  }
}

function formatsFor(engine: string): { value: ExportFormat; label: string }[] {
  switch (engine) {
    case 'postgres':
      return [
        { value: 'pg_custom', label: 'Custom (.dump) — best for pg_restore' },
        { value: 'pg_plain', label: 'Plain SQL (.sql)' },
        { value: 'pg_tar', label: 'Tar archive (.tar)' },
      ];
    case 'mysql':
      return [{ value: 'mysql_plain', label: 'Plain SQL (.sql)' }];
    case 'sqlite':
      return [
        { value: 'sqlite_file_copy', label: 'File copy (.sqlite)' },
        { value: 'sqlite_plain', label: 'Plain SQL (.sql)' },
      ];
    default:
      return [];
  }
}

function filterFor(format: ExportFormat): { name: string; extensions: string[] }[] {
  switch (format) {
    case 'pg_custom':
      return [{ name: 'PostgreSQL custom dump', extensions: ['dump'] }];
    case 'pg_tar':
      return [{ name: 'PostgreSQL tar dump', extensions: ['tar'] }];
    case 'pg_plain':
    case 'mysql_plain':
    case 'sqlite_plain':
      return [{ name: 'SQL', extensions: ['sql'] }];
    case 'sqlite_file_copy':
      return [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }];
  }
}

function suggestedFileName(
  profile: ConnectionProfile,
  format: ExportFormat,
): string {
  const stamp = new Date()
    .toISOString()
    .slice(0, 10);
  const ext =
    format === 'pg_custom' ? 'dump'
    : format === 'pg_tar' ? 'tar'
    : format === 'sqlite_file_copy' ? 'sqlite'
    : 'sql';
  const safeName = profile.name.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  const db = profile.database ? `_${profile.database}` : '';
  return `${safeName}${db}_${stamp}.${ext}`;
}

function appendCapped(prev: string[], line: string, cap: number): string[] {
  const next = [...prev, line];
  if (next.length > cap) next.splice(0, next.length - cap);
  return next;
}

/** Byte-size of the output file on disk, via a lightweight Rust
 *  fs::metadata call. Errors are swallowed to 0 — we treat "can't
 *  stat" as "we don't know" and let the caller decide what to
 *  render. */
async function statFileSize(path: string): Promise<number> {
  try {
    return await api.fileSize(path);
  } catch {
    return 0;
  }
}

export default function ExportPage() {
  return (
    <Suspense fallback={null}>
      <ExportPageInner />
    </Suspense>
  );
}

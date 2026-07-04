'use client';

// The "Download & Install (18 MB)" prompt.
//
// Renders when a page (Export, Import, Settings/Tools) needs a native
// tool bundle that isn't installed yet. Owns:
//   - a listener for `dbstudio://tool/progress` while the install runs
//   - the download-progress bar
//   - error state
//
// Callers pass the bundle they need. The component fetches its status
// from `useToolCache` — that store is the source of truth so an
// install started here also updates the Tools settings page and vice
// versa.

import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useToolCache } from '@/store/toolCache';
import { formatBytes, type ToolProgress } from '@/lib/tools';
import { cn } from '@/lib/utils';

interface ToolInstallPromptProps {
  /** Bundle key from the manifest — 'postgres' | 'mysql' | ... */
  bundleKey: string;
  /** Called after a successful install so the parent workflow can
   *  advance (e.g. show the Export options form). */
  onInstalled?: () => void;
  /** Optional headline override — defaults to "Postgres tools
   *  needed" etc based on the bundle's display_name. */
  title?: string;
  /** Short explainer for the user. Defaults to a generic line. */
  subtitle?: string;
  className?: string;
}

export function ToolInstallPrompt({
  bundleKey,
  onInstalled,
  title,
  subtitle,
  className,
}: ToolInstallPromptProps) {
  const bundle = useToolCache((s) =>
    s.bundles.find((b) => b.bundle_key === bundleKey),
  );
  const refresh = useToolCache((s) => s.refresh);
  const install = useToolCache((s) => s.install);
  const applyProgress = useToolCache((s) => s.applyProgress);
  const progress = useToolCache((s) => s.progress[bundleKey] ?? null);

  const [status, setStatus] = useState<
    'idle' | 'installing' | 'error'
  >('idle');
  const [error, setError] = useState<string | null>(null);

  // First mount: kick a status refresh so `bundle` is populated. Cheap
  // and idempotent thanks to the store.
  useEffect(() => {
    if (!bundle) void refresh();
  }, [bundle, refresh]);

  // Progress event bridge: the Rust downloader emits
  // `dbstudio://tool/progress`; we translate it into store updates
  // for the active install. Only mounted while `installing` so we
  // don't attach a listener when idle.
  useEffect(() => {
    if (status !== 'installing') return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const off = await listen<ToolProgress>('dbstudio://tool/progress', (e) => {
        if (e.payload.bundle_key !== bundleKey) return;
        applyProgress(e.payload);
      });
      if (cancelled) off();
      else unlisten = off;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [status, bundleKey, applyProgress]);

  const onInstall = async () => {
    setStatus('installing');
    setError(null);
    try {
      await install(bundleKey);
      setStatus('idle');
      onInstalled?.();
    } catch (e: unknown) {
      const err = e as { message?: string };
      setError(err.message ?? String(e));
      setStatus('error');
    }
  };

  if (!bundle) {
    return (
      <div
        className={cn(
          'rounded-lg border bg-card p-6 text-sm text-muted-foreground',
          className,
        )}
      >
        <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Loading tool
        bundle metadata…
      </div>
    );
  }

  if (bundle.installed) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm',
          className,
        )}
      >
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        <span>
          <span className="font-medium">{bundle.display_name}</span>
          <span className="text-muted-foreground">
            {' '}
            v{bundle.tool_version} · installed
          </span>
        </span>
      </div>
    );
  }

  const percent =
    progress?.phase === 'downloading' && progress.total > 0
      ? Math.round((progress.downloaded / progress.total) * 100)
      : null;

  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-5',
        status === 'error' && 'border-destructive/40',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Download className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold">
            {title ?? `${bundle.display_name} needed`}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {subtitle ??
              `We'll download the ${bundle.display_name.toLowerCase()} into your Bearhold data directory (${formatBytes(
                bundle.download_size_bytes,
              )}) so exports and imports for this engine can run.`}
          </p>
        </div>
      </div>

      {status === 'installing' && (
        <div className="mt-4 space-y-1.5">
          <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{
                width: percent != null ? `${percent}%` : '20%',
              }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {progressLabel(progress, bundle.download_size_bytes)}
          </p>
        </div>
      )}

      {status === 'error' && (
        <div className="mt-3 flex items-start gap-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" onClick={onInstall} disabled={status === 'installing'}>
          {status === 'installing' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {status === 'installing'
            ? 'Installing…'
            : `Download & install (${formatBytes(bundle.download_size_bytes)})`}
        </Button>
        {bundle.download_url && (
          <span
            className="max-w-md truncate text-[10px] text-muted-foreground"
            title={bundle.download_url}
          >
            from {new URL(bundle.download_url).hostname}
          </span>
        )}
      </div>
    </div>
  );
}

function progressLabel(
  progress: ToolProgress | null,
  totalBytesHint: number | null,
): string {
  if (!progress) return 'Preparing…';
  if (progress.phase === 'downloading') {
    const total = progress.total || totalBytesHint || 0;
    return `Downloading ${formatBytes(progress.downloaded)} / ${formatBytes(total)}`;
  }
  if (progress.phase === 'verifying') return 'Verifying SHA-256…';
  if (progress.phase === 'extracting') return 'Extracting archive…';
  return 'Finalising…';
}

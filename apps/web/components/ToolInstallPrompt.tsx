'use client';

// Tool-bundle status + install prompt.
//
// Three rendering states, resolved in this order:
//
//   1. `bundle.ready` — installed from the bundle cache OR every tool
//      was found on the system PATH. Renders a compact green
//      "using X from Y" panel with no CTA. The workflow can proceed.
//
//   2. `bundle.download_available` — the manifest has a real hosted
//      URL. Shows the "Download & install (18 MB)" button and,
//      while running, a progress bar fed by
//      `dbstudio://tool/progress`.
//
//   3. Otherwise — the manifest URL is still a placeholder OR no
//      asset exists for this platform. Instead of a broken network
//      call we surface the OS-specific install one-liner
//      (`brew install libpq`, `apt-get install postgresql-client`, …)
//      with a copy button.
//
// The store is the source of truth so an install started here also
// updates the Tools settings page, the Export page, etc.

import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Terminal,
} from 'lucide-react';

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

  const [status, setStatus] = useState<'idle' | 'installing' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bundle) void refresh();
  }, [bundle, refresh]);

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

  // ---- State 1: ready (either bundle installed OR system PATH) ----

  if (bundle.ready) {
    // Prefer the system-path label when available — that's what most
    // users will recognise ("Using /usr/local/opt/libpq/bin/pg_dump").
    // Fall back to the bundle version string when we downloaded it.
    const firstTool = bundle.tools[0];
    const sourceLabel = bundle.system_available
      ? firstTool?.system_path
        ? `Using system tools · ${firstTool.system_path}`
        : 'Using system tools on PATH'
      : `Using downloaded bundle · v${bundle.tool_version}`;
    return (
      <div
        className={cn(
          'flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm',
          className,
        )}
      >
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {bundle.display_name}
            <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
              Ready
            </span>
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {sourceLabel}
          </p>
        </div>
      </div>
    );
  }

  // ---- State 3: download unavailable — show install hint ---------
  // We check this BEFORE state 2 (download button) because when the
  // manifest is a placeholder we should never render a broken CTA.

  if (!bundle.download_available) {
    return (
      <div
        className={cn('rounded-lg border bg-card p-5', className)}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-300">
            <Terminal className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">
              {title ?? `${bundle.display_name} needed`}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {subtitle ??
                `Install ${bundle.display_name.toLowerCase()} with your OS package manager. Bearhold picks them up from PATH automatically.`}
            </p>
          </div>
        </div>

        {bundle.install_hint && (
          <InstallHintBlock hint={bundle.install_hint} onDone={() => void refresh()} />
        )}

        {!bundle.install_hint && (
          <p className="mt-4 rounded border border-dashed p-3 text-[11px] text-muted-foreground">
            No install hint for your OS. Install the {bundle.display_name}{' '}
            manually — Bearhold picks up any binary named{' '}
            <code className="rounded bg-muted px-1 py-0.5">
              {bundle.tools[0]?.name ?? 'the tool'}
            </code>{' '}
            on PATH.
          </p>
        )}

        <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-accent"
          >
            <Loader2 className="h-3 w-3" /> Re-check
          </button>
          <span>after installing, Bearhold will detect it on next check.</span>
        </div>
      </div>
    );
  }

  // ---- State 2: download available -------------------------------

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
              `We'll download ${bundle.display_name} into your Bearhold data directory (${formatBytes(
                bundle.download_size_bytes,
              )}).`}
          </p>
        </div>
      </div>

      {status === 'installing' && (
        <div className="mt-4 space-y-1.5">
          <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: percent != null ? `${percent}%` : '20%' }}
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

      <div className="mt-4 flex items-center gap-3">
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
        {bundle.download_host && (
          <span className="text-[10px] text-muted-foreground">
            from {bundle.download_host}
          </span>
        )}
      </div>

      {/* If the hosted download exists but the user prefers their own
          install, still surface the OS-native option. Shown collapsed
          so it doesn't compete with the primary CTA above. */}
      {bundle.install_hint && (
        <details className="mt-4 rounded border bg-muted/30 p-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Prefer to install it yourself?
          </summary>
          <InstallHintBlock hint={bundle.install_hint} onDone={() => void refresh()} />
        </details>
      )}
    </div>
  );
}

function InstallHintBlock({
  hint,
  onDone,
}: {
  hint: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const looksLikeUrl = hint.includes('http://') || hint.includes('https://');
  const url = looksLikeUrl
    ? hint.match(/https?:\/\/\S+/)?.[0] ?? null
    : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* silent */
    }
  };

  return (
    <div className="mt-4 flex items-center gap-2 rounded border bg-background p-2 font-mono text-[12px]">
      <span className="text-muted-foreground/60">$</span>
      <code className="flex-1 truncate">{hint}</code>
      <button
        type="button"
        onClick={copy}
        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent"
        title="Copy to clipboard"
      >
        {copied ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
        {copied ? 'Copied' : 'Copy'}
      </button>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent"
          onClick={onDone}
        >
          <ExternalLink className="h-3 w-3" />
          Open
        </a>
      )}
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

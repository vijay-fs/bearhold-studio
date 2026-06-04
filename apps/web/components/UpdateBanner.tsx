'use client';

// Small banner that announces a new desktop build is available and
// drives the install flow. Lives in AppShell so it's visible
// regardless of which page the user is on. The check itself fires
// once on mount with a short delay so it doesn't compete with the
// first paint; subsequent checks happen on a 6-hour interval, which
// matches what most desktop apps use.

import { useEffect, useState } from 'react';
import { Download, Loader2, Sparkles, X } from 'lucide-react';

import { checkForUpdate, downloadAndInstall, type UpdateInfo } from '@/lib/updater';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type State =
  | { kind: 'idle' }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'installing'; downloaded: number; total: number | undefined }
  | { kind: 'error'; message: string };

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 5_000;

export function UpdateBanner() {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const info = await checkForUpdate();
      if (cancelled) return;
      if (info.available) {
        setState((prev) =>
          // Don't trample an in-progress install with a fresh check.
          prev.kind === 'installing' ? prev : { kind: 'available', info },
        );
      }
    };
    const initial = window.setTimeout(run, FIRST_CHECK_DELAY_MS);
    const periodic = window.setInterval(run, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(periodic);
    };
  }, []);

  if (state.kind === 'idle') return null;
  if (
    state.kind === 'available' &&
    state.info.version &&
    state.info.version === dismissedVersion
  ) {
    return null;
  }

  const install = async () => {
    setState({ kind: 'installing', downloaded: 0, total: undefined });
    try {
      await downloadAndInstall((downloaded, total) =>
        setState({ kind: 'installing', downloaded, total }),
      );
      // Plugin calls `relaunch()` after install, so this point is
      // generally unreachable. Defensive reset in case the platform
      // returns without restarting.
      setState({ kind: 'idle' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ kind: 'error', message: msg });
    }
  };

  const dismiss = () => {
    if (state.kind === 'available' && state.info.version) {
      setDismissedVersion(state.info.version);
    }
    setState({ kind: 'idle' });
  };

  return (
    <div
      className={cn(
        'flex items-center gap-3 border-b bg-sky-50 px-4 py-2 text-[12px] dark:bg-sky-950/40',
        state.kind === 'error' && 'bg-destructive/10',
      )}
    >
      {state.kind === 'available' && (
        <>
          <Sparkles className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-300" />
          <div className="min-w-0 flex-1 truncate">
            Bearhold Studio <span className="font-mono">{state.info.version}</span>
            {' is available.'}
          </div>
          <Button size="sm" onClick={install}>
            <Download className="h-3 w-3" />
            Install &amp; restart
          </Button>
          <button
            type="button"
            onClick={dismiss}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Dismiss update"
          >
            <X className="h-3 w-3" />
          </button>
        </>
      )}
      {state.kind === 'installing' && (
        <>
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-600 dark:text-sky-300" />
          <div className="min-w-0 flex-1">
            Downloading update…
            {state.total ? (
              <span className="ml-2 font-mono text-muted-foreground">
                {formatBytes(state.downloaded)} / {formatBytes(state.total)}
              </span>
            ) : (
              <span className="ml-2 font-mono text-muted-foreground">
                {formatBytes(state.downloaded)}
              </span>
            )}
          </div>
        </>
      )}
      {state.kind === 'error' && (
        <>
          <span className="font-medium text-destructive">Update failed</span>
          <span className="truncate text-muted-foreground">{state.message}</span>
          <button
            type="button"
            onClick={dismiss}
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

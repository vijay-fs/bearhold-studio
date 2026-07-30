'use client';

// Redis keyspace browser. Two-pane layout: left rail lists keys
// returned by SCAN (paginated via the server-returned cursor), right
// pane shows a type-aware viewer for whichever key is focused.
//
// Each Redis type gets its own viewer:
//   - string       → readonly textarea
//   - list         → ordered <ol> with index
//   - set          → unordered list of members
//   - hash         → 2-col table (field / value)
//   - sorted set   → 2-col table (member / score), sorted ascending
//   - stream       → placeholder (not in MVP)
//
// Writes (set value, set TTL) come in a future pass; this MVP is
// read + delete only.

import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Database,
  Hash,
  Key as KeyIcon,
  List,
  Loader2,
  RefreshCw,
  Search,
  Sigma,
  Square,
  Trash2,
  Type as TypeIcon,
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
import type {
  ConnectionProfile,
  RedisKeyDetails,
  RedisKeyEntry,
  RedisValue,
} from '@/lib/types';
import { cn } from '@/lib/utils';

interface RedisBrowserProps {
  profile: ConnectionProfile;
}

type DetailsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; data: RedisKeyDetails }
  | { kind: 'error'; code: string; message: string };

export function RedisBrowser({ profile }: RedisBrowserProps) {
  const [pattern, setPattern] = useState('*');
  const [pendingPattern, setPendingPattern] = useState('*');
  const [keys, setKeys] = useState<RedisKeyEntry[]>([]);
  const [cursor, setCursor] = useState<number>(0);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [details, setDetails] = useState<DetailsState>({ kind: 'idle' });
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  /** Reset the keyspace listing and walk SCAN from the beginning under
   *  the current MATCH pattern. Called on pattern change, mount, and
   *  the Refresh button. */
  const restartScan = async (matchPattern: string) => {
    setScanning(true);
    setScanError(null);
    setKeys([]);
    setCursor(0);
    try {
      const resp = await api.redis.scan(profile, {
        cursor: 0,
        match_pattern: matchPattern,
      });
      setKeys(resp.keys);
      setCursor(resp.next_cursor);
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setScanError(`${err.code ?? 'unknown'} · ${err.message ?? String(e)}`);
    } finally {
      setScanning(false);
    }
  };

  const loadMore = async () => {
    if (cursor === 0) return;
    setScanning(true);
    setScanError(null);
    try {
      const resp = await api.redis.scan(profile, {
        cursor,
        match_pattern: pattern,
      });
      // Append + dedupe — Redis SCAN can return the same key on
      // different iterations under heavy mutation.
      setKeys((prev) => {
        const seen = new Set(prev.map((k) => k.key));
        const next = [...prev];
        for (const k of resp.keys) {
          if (!seen.has(k.key)) next.push(k);
        }
        return next;
      });
      setCursor(resp.next_cursor);
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setScanError(`${err.code ?? 'unknown'} · ${err.message ?? String(e)}`);
    } finally {
      setScanning(false);
    }
  };

  // Initial scan on mount.
  useEffect(() => {
    void restartScan('*');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);

  // Fetch details whenever the selection changes.
  useEffect(() => {
    if (!selectedKey) {
      setDetails({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setDetails({ kind: 'loading' });
    api.redis
      .keyDetails(profile, selectedKey)
      .then((data) => {
        if (cancelled) return;
        setDetails({ kind: 'ok', data });
      })
      .catch((e: { code?: string; message?: string }) => {
        if (cancelled) return;
        setDetails({
          kind: 'error',
          code: e.code ?? 'unknown',
          message: e.message ?? 'failed to load key',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedKey, profile.id]);

  const submitPattern = (e: React.FormEvent) => {
    e.preventDefault();
    const next = pendingPattern.trim() || '*';
    setPattern(next);
    void restartScan(next);
  };

  const doDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.redis.delete(profile, pendingDelete);
      // Drop from the keyspace list + clear the right pane if the
      // selection just disappeared.
      setKeys((prev) => prev.filter((k) => k.key !== pendingDelete));
      if (selectedKey === pendingDelete) setSelectedKey(null);
      setPendingDelete(null);
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setScanError(`delete failed · ${err.code ?? 'unknown'} · ${err.message ?? String(e)}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full">
      {/* Left rail — pattern + key list */}
      <aside className="flex w-[320px] shrink-0 flex-col border-r">
        <form onSubmit={submitPattern} className="flex items-center gap-2 border-b px-3 py-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={pendingPattern}
              onChange={(e) => setPendingPattern(e.target.value)}
              placeholder="* or prefix:*"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="h-7 pl-7 font-mono text-xs"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={scanning}
            title="Apply MATCH pattern (Redis glob)"
          >
            {scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
        </form>

        <div className="border-b px-3 py-1.5 text-[10px] text-muted-foreground">
          {keys.length} key{keys.length === 1 ? '' : 's'} loaded
          {cursor !== 0 && ' · scan in progress'}
        </div>

        {scanError && (
          <div className="border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
            <AlertCircle className="mr-1 inline h-3 w-3" />
            {scanError}
          </div>
        )}

        <ul className="scrollbar-thin flex-1 overflow-y-auto">
          {keys.map((k) => (
            <li key={k.key}>
              <button
                type="button"
                onClick={() => setSelectedKey(k.key)}
                className={cn(
                  'flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-xs',
                  selectedKey === k.key
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                )}
              >
                <TypeBadge type={k.type_name} />
                <span className="flex-1 truncate font-mono">{k.key}</span>
                {k.ttl_seconds != null && k.ttl_seconds > 0 && (
                  <span
                    className="shrink-0 text-[9px] text-muted-foreground"
                    title={`Expires in ${k.ttl_seconds}s`}
                  >
                    {formatTtl(k.ttl_seconds)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>

        <footer className="border-t p-2">
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => void loadMore()}
            disabled={scanning || cursor === 0}
          >
            {cursor === 0
              ? keys.length === 0
                ? 'No keys'
                : 'End of keyspace'
              : scanning
                ? 'Loading…'
                : 'Load more'}
          </Button>
        </footer>
      </aside>

      {/* Right pane — details for the selected key */}
      <main className="scrollbar-thin flex-1 overflow-y-auto">
        {!selectedKey && (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
            <p>Pick a key on the left to view its value.</p>
          </div>
        )}
        {selectedKey && details.kind === 'loading' && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            Loading {selectedKey}...
          </div>
        )}
        {selectedKey && details.kind === 'error' && (
          <div className="p-5">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span className="text-sm font-semibold">Couldn&apos;t load key</span>
            </div>
            <p className="mt-1 break-all text-xs text-muted-foreground">
              <span className="font-mono">{details.code}</span> · {details.message}
            </p>
          </div>
        )}
        {selectedKey && details.kind === 'ok' && (
          <KeyDetailsView
            profile={profile}
            details={details.data}
            onDelete={() => setPendingDelete(details.data.key)}
            onRenamed={(newKey) => {
              setSelectedKey(newKey);
              void restartScan(pattern);
            }}
            onRefresh={() => {
              // Re-fetch by re-setting the selection. The useEffect
              // above does the heavy lifting.
              const k = selectedKey;
              setSelectedKey(null);
              setTimeout(() => setSelectedKey(k), 0);
            }}
          />
        )}
      </main>

      {/* Delete confirm dialog — keys with valuable data should require
          an explicit acknowledgement. */}
      <Dialog
        open={pendingDelete != null}
        onOpenChange={(o) => !o && !deleting && setPendingDelete(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete key?</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{pendingDelete}</span> will be removed
              from Redis. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={doDelete} disabled={deleting}>
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Delete key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- key details view --------------------------------------------------

function KeyDetailsView({
  profile,
  details,
  onDelete,
  onRenamed,
  onRefresh,
}: {
  profile: ConnectionProfile;
  details: RedisKeyDetails;
  onDelete: () => void;
  onRenamed: (newKey: string) => void;
  onRefresh: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [renameTo, setRenameTo] = useState(details.key);
  const [editingTtl, setEditingTtl] = useState(false);
  const [ttlInput, setTtlInput] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (op: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setActionError(null);
    try {
      await op();
      after?.();
    } catch (e) {
      const err = e as { message?: string };
      setActionError(err.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const hasExpiry =
    details.ttl_seconds != null && details.ttl_seconds !== -1 && details.ttl_seconds !== -2;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-3 border-b px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <TypeBadge type={details.type_name} large />
            {renaming ? (
              <form
                className="flex flex-1 items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const to = renameTo.trim();
                  if (!to || to === details.key) {
                    setRenaming(false);
                    return;
                  }
                  void run(
                    () => api.redis.rename(profile, details.key, to),
                    () => {
                      setRenaming(false);
                      onRenamed(to);
                    },
                  );
                }}
              >
                <input
                  value={renameTo}
                  onChange={(e) => setRenameTo(e.target.value)}
                  autoFocus
                  spellCheck={false}
                  className="w-full rounded border border-input bg-background px-2 py-0.5 font-mono text-sm"
                />
                <Button size="sm" type="submit" disabled={busy}>
                  Rename
                </Button>
                <Button size="sm" type="button" variant="ghost" onClick={() => setRenaming(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <button
                type="button"
                title="Rename key"
                onClick={() => {
                  setRenameTo(details.key);
                  setRenaming(true);
                }}
                className="truncate text-left font-mono text-sm font-semibold hover:underline"
              >
                {details.key}
              </button>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {editingTtl ? (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const secs = Number(ttlInput);
                  if (!Number.isFinite(secs) || secs <= 0) return;
                  void run(
                    () => api.redis.setTtl(profile, details.key, Math.floor(secs)),
                    () => {
                      setEditingTtl(false);
                      onRefresh();
                    },
                  );
                }}
              >
                <input
                  value={ttlInput}
                  onChange={(e) => setTtlInput(e.target.value)}
                  autoFocus
                  placeholder="seconds"
                  inputMode="numeric"
                  className="w-24 rounded border border-input bg-background px-1.5 py-0.5 font-mono"
                />
                <button type="submit" disabled={busy} className="hover:text-foreground">
                  set
                </button>
                <button type="button" onClick={() => setEditingTtl(false)} className="hover:text-foreground">
                  cancel
                </button>
              </form>
            ) : (
              <>
                {details.ttl_seconds === -2 ? (
                  <span className="text-destructive">key missing</span>
                ) : hasExpiry ? (
                  <span>expires in {formatTtl(details.ttl_seconds!)}</span>
                ) : (
                  <span>no expiry</span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setTtlInput(hasExpiry ? String(details.ttl_seconds) : '');
                    setEditingTtl(true);
                  }}
                  className="hover:text-foreground hover:underline"
                >
                  set TTL
                </button>
                {hasExpiry && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => api.redis.setTtl(profile, details.key, null), onRefresh)}
                    className="hover:text-foreground hover:underline"
                  >
                    remove expiry
                  </button>
                )}
              </>
            )}
            <span>·</span>
            <span>type {details.type_name}</span>
            <span>·</span>
            <span>{describeSize(details.value)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={onRefresh}>
            <RefreshCw className="h-3 w-3" />
            Reload
          </Button>
          <Button size="sm" variant="destructive" onClick={onDelete}>
            <Trash2 className="h-3 w-3" />
            Delete
          </Button>
        </div>
      </header>

      {actionError && (
        <p className="border-b bg-destructive/5 px-4 py-1.5 text-xs text-destructive">{actionError}</p>
      )}

      <div className="flex-1 overflow-auto p-4">
        <ValueView
          value={details.value}
          onSaveString={(next) =>
            void run(() => api.redis.setString(profile, details.key, next), onRefresh)
          }
          busy={busy}
        />
      </div>
    </div>
  );
}

function ValueView({
  value,
  onSaveString,
  busy,
}: {
  value: RedisValue;
  onSaveString: (next: string) => void;
  busy: boolean;
}) {
  if (value.kind === 'none') {
    return <p className="text-xs text-muted-foreground">Key has no value (it may have just expired).</p>;
  }
  if (value.kind === 'string') {
    return <StringEditor initial={value.value} onSave={onSaveString} busy={busy} />;
  }
  if (value.kind === 'list') {
    return (
      <div className="space-y-2">
        {value.items.length < value.total && (
          <TruncationNote shown={value.items.length} total={value.total} />
        )}
        <ol className="space-y-1 rounded border">
          {value.items.map((item, i) => (
            <li
              key={i}
              className="flex gap-3 border-b px-3 py-1.5 font-mono text-xs last:border-b-0"
            >
              <span className="w-10 shrink-0 text-right text-muted-foreground">{i}</span>
              <span className="flex-1 break-all">{item}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (value.kind === 'set') {
    return (
      <div className="space-y-2">
        {value.members.length < value.total && (
          <TruncationNote shown={value.members.length} total={value.total} />
        )}
        <ul className="space-y-1 rounded border">
          {value.members.map((m, i) => (
            <li
              key={i}
              className="border-b px-3 py-1.5 font-mono text-xs last:border-b-0 break-all"
            >
              {m}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (value.kind === 'hash') {
    const entries = Object.entries(value.fields);
    return (
      <div className="overflow-hidden rounded border">
        <table className="w-full text-xs">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-1.5 font-medium text-muted-foreground">Field</th>
              <th className="px-3 py-1.5 font-medium text-muted-foreground">Value</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k} className="border-b last:border-b-0">
                <td className="break-all px-3 py-1.5 font-mono">{k}</td>
                <td className="break-all px-3 py-1.5 font-mono text-foreground/90">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (value.kind === 'sorted_set') {
    return (
      <div className="space-y-2">
        {value.items.length < value.total && (
          <TruncationNote shown={value.items.length} total={value.total} />
        )}
        <div className="overflow-hidden rounded border">
          <table className="w-full text-xs">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="px-3 py-1.5 font-medium text-muted-foreground">Member</th>
                <th className="w-32 px-3 py-1.5 text-right font-medium text-muted-foreground">
                  Score
                </th>
              </tr>
            </thead>
            <tbody>
              {value.items.map(([member, score], i) => (
                <tr key={i} className="border-b last:border-b-0">
                  <td className="break-all px-3 py-1.5 font-mono">{member}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-amber-600 dark:text-amber-400">
                    {score}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  if (value.kind === 'stream') {
    return (
      <div className="space-y-2">
        {value.entries.length < value.total && (
          <TruncationNote shown={value.entries.length} total={value.total} />
        )}
        <div className="scrollbar-thin max-h-80 overflow-auto rounded border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/80 text-left backdrop-blur">
              <tr>
                <th className="px-3 py-1.5 font-medium">Entry ID</th>
                <th className="px-3 py-1.5 font-medium">Fields</th>
              </tr>
            </thead>
            <tbody>
              {value.entries.map(([id, fields]) => (
                <tr key={id} className="border-t align-top">
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted-foreground">
                    {id}
                  </td>
                  <td className="px-3 py-1.5 font-mono">
                    {pairUp(fields).map(([f, v], i) => (
                      <div key={i}>
                        <span className="text-muted-foreground">{f}:</span> {v}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Unknown value type: <span className="font-mono">{value.type_name}</span>
    </p>
  );
}

function TruncationNote({ shown, total }: { shown: number; total: number }) {
  return (
    <p className="text-[10px] text-amber-600 dark:text-amber-400">
      Showing first {shown.toLocaleString()} of {total.toLocaleString()} — values
      past this aren&apos;t loaded in the MVP.
    </p>
  );
}

/** Editable string value with an explicit Save — silent live writes to
 *  a production Redis are exactly the surprise nobody wants. */
function StringEditor({
  initial,
  onSave,
  busy,
}: {
  initial: string;
  onSave: (next: string) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);
  const dirty = draft !== initial;
  return (
    <div className="flex h-full flex-col gap-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="scrollbar-thin min-h-[200px] w-full flex-1 resize-none rounded border border-input bg-background p-3 font-mono text-xs"
      />
      {dirty && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => onSave(draft)} disabled={busy}>
            Save value
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(initial)} disabled={busy}>
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}

// ---- helpers -----------------------------------------------------------

/** Flat [field, value, field, value, ...] → [[field, value], ...]. */
function pairUp(flat: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out.push([flat[i]!, flat[i + 1]!]);
  }
  return out;
}

function TypeBadge({ type, large }: { type: string; large?: boolean }) {
  // The `unknown` slot is guaranteed to exist (see TYPE_CONFIG below)
  // so a non-null assertion is safe and avoids TS's strict-mode
  // narrowing from the optional index access.
  const conf = TYPE_CONFIG[type] ?? TYPE_CONFIG.unknown!;
  const Icon = conf.icon;
  const labelOnly = (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 font-mono',
        large ? 'text-[10px]' : 'text-[9px]',
        conf.classes,
      )}
      title={`Redis type: ${type}`}
    >
      <Icon className={large ? 'h-3 w-3' : 'h-2.5 w-2.5'} />
      {conf.short}
    </span>
  );
  return labelOnly;
}

const TYPE_CONFIG: Record<
  string,
  {
    icon: typeof KeyIcon;
    short: string;
    classes: string;
  }
> = {
  string: {
    icon: TypeIcon,
    short: 'STR',
    classes: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  },
  list: {
    icon: List,
    short: 'LIST',
    classes: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  },
  set: {
    icon: Square,
    short: 'SET',
    classes: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300',
  },
  hash: {
    icon: Hash,
    short: 'HASH',
    classes: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  },
  zset: {
    icon: Sigma,
    short: 'ZSET',
    classes: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  },
  stream: {
    icon: Database,
    short: 'STR',
    classes: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
  },
  unknown: {
    icon: KeyIcon,
    short: '?',
    classes: 'bg-muted text-muted-foreground',
  },
  none: {
    icon: KeyIcon,
    short: '∅',
    classes: 'bg-muted text-muted-foreground',
  },
};

/** Format TTL in seconds as a compact human string ("3h", "12d"). */
function formatTtl(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Describe the "size" of a Redis value for the metadata row. The
 *  exact label depends on type — strings get character count, lists
 *  get length, hashes get field count, etc. */
function describeSize(value: RedisValue): string {
  switch (value.kind) {
    case 'string':
      return `${value.value.length} chars`;
    case 'list':
      return `${value.total} item${value.total === 1 ? '' : 's'}`;
    case 'set':
      return `${value.total} member${value.total === 1 ? '' : 's'}`;
    case 'hash':
      return `${value.total} field${value.total === 1 ? '' : 's'}`;
    case 'sorted_set':
      return `${value.total} entr${value.total === 1 ? 'y' : 'ies'}`;
    case 'stream':
      return 'stream';
    case 'unknown':
      return value.type_name;
    case 'none':
      return 'missing';
  }
}

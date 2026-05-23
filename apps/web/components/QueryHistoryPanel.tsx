'use client';

import { useMemo, useState } from 'react';
import { CheckCircle2, XCircle, Trash2, Play, Copy, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useQueryHistory, type QueryHistoryEntry } from '@/store/queryHistory';

interface Props {
  connectionId: string;
  /** Replace the editor buffer with this SQL. */
  onLoad: (sql: string) => void;
  /** Replace the editor buffer AND run the query immediately. */
  onRerun: (sql: string) => void;
}

type StatusFilter = 'all' | 'ok' | 'error';
type RangeFilter = 'all' | '1h' | '24h' | '7d';

const RANGE_MS: Record<RangeFilter, number | null> = {
  all: null,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

export function QueryHistoryPanel({ connectionId, onLoad, onRerun }: Props) {
  const allEntries = useQueryHistory((s) => s.entries);
  const remove = useQueryHistory((s) => s.remove);
  const clear = useQueryHistory((s) => s.clear);

  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [range, setRange] = useState<RangeFilter>('all');

  const forConn = useMemo(
    () => allEntries.filter((e) => e.connectionId === connectionId),
    [allEntries, connectionId],
  );

  const entries = useMemo(() => {
    const rangeMs = RANGE_MS[range];
    const cutoff = rangeMs != null ? Date.now() - rangeMs : null;
    const needle = filter.trim().toLowerCase();
    return forConn.filter((e) => {
      if (status !== 'all' && e.status !== status) return false;
      if (cutoff != null && e.timestamp < cutoff) return false;
      if (needle && !e.sql.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [forConn, filter, status, range]);

  if (forConn.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="text-xs text-muted-foreground">
          No queries yet. Run something with <kbd className="rounded border px-1">Cmd</kbd>{' '}
          + <kbd className="rounded border px-1">Enter</kbd>.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter history..."
            className="h-7 pl-7 text-xs"
          />
        </div>
        <FilterChip
          value={status}
          onChange={(v) => setStatus(v as StatusFilter)}
          options={[
            { value: 'all', label: 'All' },
            { value: 'ok', label: 'Success' },
            { value: 'error', label: 'Errors' },
          ]}
        />
        <FilterChip
          value={range}
          onChange={(v) => setRange(v as RangeFilter)}
          options={[
            { value: 'all', label: 'All time' },
            { value: '1h', label: 'Past hour' },
            { value: '24h', label: 'Past 24h' },
            { value: '7d', label: 'Past week' },
          ]}
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
          onClick={() => {
            if (confirm('Clear all history for this connection?')) clear(connectionId);
          }}
        >
          Clear
        </Button>
      </div>

      {entries.length === 0 ? (
        <p className="p-4 text-xs text-muted-foreground">No matches.</p>
      ) : (
        <ul className="scrollbar-hidden flex-1 divide-y overflow-y-auto">
          {entries.map((entry) => (
            <HistoryRow
              key={entry.id}
              entry={entry}
              onLoad={onLoad}
              onRerun={onRerun}
              onDelete={() => remove(entry.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryRow({
  entry,
  onLoad,
  onRerun,
  onDelete,
}: {
  entry: QueryHistoryEntry;
  onLoad: (sql: string) => void;
  onRerun: (sql: string) => void;
  onDelete: () => void;
}) {
  const preview = entry.sql
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(0, 2)
    .join(' ⏎ ')
    .slice(0, 180);

  const meta =
    entry.status === 'ok'
      ? entry.rowsReturned != null
        ? `${entry.rowsReturned} row${entry.rowsReturned === 1 ? '' : 's'}${
            entry.truncated ? ' (truncated)' : ''
          }`
        : entry.rowsAffected != null
          ? `${entry.rowsAffected} affected`
          : 'ok'
      : (entry.errorCode ?? 'error');

  return (
    <li className="group cursor-pointer px-3 py-2 hover:bg-accent/50" onClick={() => onLoad(entry.sql)}>
      <div className="flex items-start gap-2">
        {entry.status === 'ok' ? (
          <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
        ) : (
          <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
        )}
        <div className="min-w-0 flex-1">
          <code className="block truncate font-mono text-xs">{preview}</code>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>{formatTimestamp(entry.timestamp)}</span>
            <span>·</span>
            <span>{entry.elapsedMs} ms</span>
            <span>·</span>
            <span className={entry.status === 'error' ? 'text-destructive' : ''}>{meta}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <IconBtn
            title="Copy SQL"
            onClick={(e) => {
              e.stopPropagation();
              void navigator.clipboard.writeText(entry.sql);
            }}
          >
            <Copy className="h-3 w-3" />
          </IconBtn>
          <IconBtn
            title="Re-run"
            onClick={(e) => {
              e.stopPropagation();
              onRerun(entry.sql);
            }}
          >
            <Play className="h-3 w-3" />
          </IconBtn>
          <IconBtn
            title="Delete from history"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="h-3 w-3" />
          </IconBtn>
        </div>
      </div>
    </li>
  );
}

function IconBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
    >
      {children}
    </button>
  );
}

/** Tiny native <select> styled to match the toolbar input. Renders as a
 *  segmented-control-looking chip so the row stays compact and the
 *  current value is always visible. */
function FilterChip({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 rounded border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function formatTimestamp(ts: number): string {
  const now = Date.now();
  const diffMs = now - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const d = new Date(ts);
  return d.toLocaleString();
}

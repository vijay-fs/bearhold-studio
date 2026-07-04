'use client';

// Root dashboard.
//
// This is the first surface a user sees when they open Bearhold — the
// old marketing landing was showing "Phase 1 in development" copy that
// no longer reflects reality. Now the page is work-oriented:
//   - Pinned + recent connections, one click into each workspace
//   - Recent SQL runs across connections, click to re-open in the editor
//   - Saved snippets across connections
//   - Quick actions (add connection, open palette, diff, data diff)
//   - First-run empty state that funnels the user to Add Connection
//
// The whole thing is a client component because it reads Zustand state
// (connections, history, snippets). Everything renders instantly from
// localStorage — no network hop before the user sees content.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Database,
  Plus,
  Command,
  GitCompare,
  Rows3,
  Pin,
  Clock,
  Sparkles,
  ArrowRight,
  History,
  Bookmark,
} from 'lucide-react';

import { useConnections } from '@/store/connections';
import { useQueryHistory } from '@/store/queryHistory';
import { useSnippets } from '@/store/snippets';
import { ENGINE_LABELS, type ConnectionProfile, type DatabaseEngine } from '@/lib/types';
import { cn } from '@/lib/utils';
import { shortcutLabel } from '@/lib/platform';
import { loadSqlInWorkspace } from '@/lib/openTable';
import { CommandPalette } from '@/components/CommandPalette';
import { KeyboardShortcutsDialog } from '@/components/KeyboardShortcutsDialog';

// One-line engine tint. Kept small so the ENGINE_LABELS colour map
// doesn't sprawl. Falls back to muted for the long-tail engines.
const ENGINE_ACCENT: Partial<Record<DatabaseEngine, string>> = {
  postgres: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-500/30',
  mysql: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/30',
  sqlite: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30',
  mongodb: 'bg-green-500/10 text-green-700 dark:text-green-300 ring-green-500/30',
  redis: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-500/30',
};

const ENGINE_ROUTE: Partial<Record<DatabaseEngine, string>> = {
  postgres: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  mongodb: 'mongo',
  redis: 'redis',
};

function routeFor(engine: DatabaseEngine): string {
  return ENGINE_ROUTE[engine] ?? 'sql';
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

export default function HomePage() {
  const profiles = useConnections((s) => s.profiles);
  const meta = useConnections((s) => s.meta);
  const historyEntries = useQueryHistory((s) => s.entries);
  const snippets = useSnippets((s) => s.entries);
  const router = useRouter();

  const orderedConnections = useMemo(() => {
    return [...profiles].sort((a, b) => {
      const ap = meta[a.id]?.pinned ? 1 : 0;
      const bp = meta[b.id]?.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      const au = meta[a.id]?.lastUsedAt ?? 0;
      const bu = meta[b.id]?.lastUsedAt ?? 0;
      if (au !== bu) return bu - au;
      return a.name.localeCompare(b.name);
    });
  }, [profiles, meta]);

  const recentHistory = useMemo(
    () => historyEntries.slice(0, 5),
    [historyEntries],
  );
  const recentSnippets = useMemo(() => {
    return [...snippets]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 5);
  }, [snippets]);

  const connectionsById = useMemo(() => {
    const map = new Map<string, ConnectionProfile>();
    for (const p of profiles) map.set(p.id, p);
    return map;
  }, [profiles]);

  const isEmpty = profiles.length === 0;

  return (
    <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/20">
      {/* Global command palette. Bound to Cmd+K on macOS and Ctrl+K
          elsewhere. Mounted at the root so it works even before the
          user opens any connection — the sidebar shell isn't rendered
          here, but the palette is still the fastest way to jump into
          a workspace or run a saved snippet. */}
      <CommandPalette />
      <KeyboardShortcutsDialog />
      <div className="mx-auto w-full max-w-6xl px-6 py-10 sm:py-14">
        <TopBar hasConnections={!isEmpty} />

        {isEmpty ? (
          <EmptyState />
        ) : (
          <div className="mt-10 space-y-10">
            <ConnectionsSection connections={orderedConnections} meta={meta} />
            <div className="grid gap-6 lg:grid-cols-2">
              <RecentQueriesSection
                entries={recentHistory}
                connectionsById={connectionsById}
                onOpen={(profile, sql) => {
                  // History load, no auto-run — the user might want to
                  // tweak before re-running against production.
                  loadSqlInWorkspace(router, profile, sql, false);
                }}
              />
              <SnippetsSection
                entries={recentSnippets}
                connectionsById={connectionsById}
                onOpen={(profile, sql) => {
                  loadSqlInWorkspace(router, profile, sql, false);
                }}
              />
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

/** Renders a keyboard shortcut label that matches the host OS: ⌘K on
 *  macOS, Ctrl+K everywhere else. Uses a mount effect to avoid an
 *  SSR/CSR label mismatch — the initial render (pre-hydration) shows
 *  the neutral Ctrl label; after mount it swaps to the real one. */
function PlatformShortcut({ keys }: { keys: string[] }) {
  const [label, setLabel] = useState<string>(() => `Ctrl+${keys.join('+')}`);
  useEffect(() => {
    setLabel(shortcutLabel(...keys));
  }, [keys.join('+')]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <kbd className="rounded bg-background px-1 py-0.5 font-mono text-[10px] ring-1 ring-border">
      {label}
    </kbd>
  );
}

// --- Sections ---------------------------------------------------------

function TopBar({ hasConnections }: { hasConnections: boolean }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      {/* Logo + title also link to `/` so the behaviour is symmetric
          with the sidebar shell header — no matter where the user is
          in the app, clicking the wordmark brings them home. */}
      <Link href="/" className="group flex items-center gap-3" aria-label="Go to dashboard">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20 transition group-hover:bg-primary/15">
          <Database className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight group-hover:underline group-hover:decoration-primary/40 group-hover:underline-offset-4">
            Bearhold Studio
          </h1>
          <p className="text-xs text-muted-foreground">
            Cross-platform database studio · Postgres · MySQL · SQLite · MongoDB · Redis
          </p>
        </div>
      </Link>
      {hasConnections && (
        <div className="flex items-center gap-2">
          <Link
            href="/connections?new=1"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            New connection
          </Link>
          <Link
            href="/connections"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            All connections
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
    </header>
  );
}

function EmptyState() {
  return (
    <div className="mt-16 grid gap-8 lg:grid-cols-[1.2fr_1fr] lg:items-center">
      <div>
        <div className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary ring-1 ring-primary/20">
          <Sparkles className="h-3 w-3" />
          Get started
        </div>
        <h2 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">
          Add your first connection.
        </h2>
        <p className="mt-4 max-w-xl text-base text-muted-foreground">
          Everything runs locally on your machine — connection details,
          query history, and saved snippets never leave this device.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/connections?new=1"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            New connection
          </Link>
          <Link
            href="/connections"
            className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Import from TablePlus / .pgpass
          </Link>
        </div>
      </div>
      <div className="rounded-2xl border bg-card p-6 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          What&apos;s inside
        </p>
        <ul className="mt-4 space-y-3 text-sm">
          <FeatureRow icon={<Rows3 className="h-4 w-4" />} label="Result grid with inline edit, drag-select, and FK navigation" />
          <FeatureRow icon={<GitCompare className="h-4 w-4" />} label="Schema and data diff between two connections" />
          <FeatureRow icon={<Command className="h-4 w-4" />} label="Command palette (Cmd+K) and multi-tab SQL editor" />
          <FeatureRow icon={<History className="h-4 w-4" />} label="Query history and per-connection saved snippets" />
        </ul>
      </div>
    </div>
  );
}

function FeatureRow({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded bg-muted text-muted-foreground">
        {icon}
      </span>
      <span className="text-muted-foreground">{label}</span>
    </li>
  );
}

function ConnectionsSection({
  connections,
  meta,
}: {
  connections: ConnectionProfile[];
  meta: Record<string, { pinned?: boolean; lastUsedAt?: number }>;
}) {
  return (
    <section>
      <SectionHeader
        title="Connections"
        subtitle={`${connections.length} total · pinned first`}
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {connections.map((c) => (
          <ConnectionCard key={c.id} profile={c} meta={meta[c.id] ?? {}} />
        ))}
        <NewConnectionCard />
        <QuickActionsCard />
      </div>
    </section>
  );
}

function ConnectionCard({
  profile,
  meta,
}: {
  profile: ConnectionProfile;
  meta: { pinned?: boolean; lastUsedAt?: number };
}) {
  const route = routeFor(profile.engine);
  const accent = ENGINE_ACCENT[profile.engine] ?? 'bg-muted text-muted-foreground ring-border';
  const host =
    profile.engine === 'sqlite'
      ? profile.file_path ?? 'local file'
      : `${profile.host}${profile.port ? `:${profile.port}` : ''}`;
  return (
    <Link
      href={`/${route}?cid=${profile.id}`}
      className="group relative flex flex-col justify-between rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary/40 hover:shadow-md"
    >
      <div>
        <div className="mb-3 flex items-start justify-between gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1',
              accent,
            )}
          >
            <Database className="h-3 w-3" />
            {ENGINE_LABELS[profile.engine]}
          </span>
          {meta.pinned && (
            <Pin className="h-3.5 w-3.5 fill-primary text-primary" aria-label="pinned" />
          )}
        </div>
        <h3 className="line-clamp-1 text-base font-semibold">{profile.name}</h3>
        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
          {profile.database ? `${host} · ${profile.database}` : host}
        </p>
      </div>
      <div className="mt-4 flex items-center justify-between text-[11px] text-muted-foreground">
        {meta.lastUsedAt ? (
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatRelative(meta.lastUsedAt)}
          </span>
        ) : (
          <span className="text-muted-foreground/60">never opened</span>
        )}
        <ArrowRight className="h-3.5 w-3.5 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
      </div>
    </Link>
  );
}

function NewConnectionCard() {
  return (
    <Link
      href="/connections?new=1"
      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-center text-muted-foreground transition hover:border-primary/40 hover:bg-accent/40 hover:text-foreground"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Plus className="h-4 w-4" />
      </span>
      <span className="text-sm font-medium">New connection</span>
      <span className="text-[11px]">Postgres, MySQL, SQLite, MongoDB, Redis</span>
    </Link>
  );
}

function QuickActionsCard() {
  return (
    <div className="rounded-xl border bg-muted/30 p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Quick actions
      </p>
      <div className="space-y-2 text-sm">
        <QuickLink href="/diff" icon={<GitCompare className="h-3.5 w-3.5" />} label="Schema diff" />
        <QuickLink href="/data-diff" icon={<Rows3 className="h-3.5 w-3.5" />} label="Data diff" />
        <QuickLink href="/connections" icon={<Database className="h-3.5 w-3.5" />} label="Manage connections" />
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-background text-foreground/80 ring-1 ring-border">
            <Command className="h-3 w-3" />
          </span>
          <span className="text-xs">
            Press <PlatformShortcut keys={['K']} /> for the palette
          </span>
        </div>
      </div>
    </div>
  );
}

function QuickLink({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-background"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="font-medium">{label}</span>
    </Link>
  );
}

function RecentQueriesSection({
  entries,
  connectionsById,
  onOpen,
}: {
  entries: ReturnType<typeof useQueryHistory.getState>['entries'];
  connectionsById: Map<string, ConnectionProfile>;
  onOpen: (profile: ConnectionProfile, sql: string) => void;
}) {
  return (
    <section className="rounded-xl border bg-card p-5">
      <SectionHeader
        title="Recent queries"
        subtitle="Across all connections · click to load into the editor"
        icon={<History className="h-4 w-4" />}
      />
      {entries.length === 0 ? (
        <p className="mt-4 rounded border border-dashed p-6 text-center text-xs text-muted-foreground">
          No queries yet. Run something to see it here.
        </p>
      ) : (
        <ul className="mt-3 space-y-1">
          {entries.map((h) => {
            const profile = connectionsById.get(h.connectionId);
            if (!profile) return null;
            return (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => onOpen(profile, h.sql)}
                  className="group flex w-full items-start gap-3 rounded-md p-2 text-left hover:bg-accent/50"
                >
                  <span
                    className={cn(
                      'mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full',
                      h.status === 'ok' ? 'bg-emerald-500' : 'bg-destructive',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-1 font-mono text-[12px] text-foreground/90">
                      {h.sql.replace(/\s+/g, ' ').trim()}
                    </p>
                    <p className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="font-medium">{profile.name}</span>
                      <span>·</span>
                      <span>{formatRelative(h.timestamp)}</span>
                      {typeof h.elapsedMs === 'number' && (
                        <>
                          <span>·</span>
                          <span>{Math.round(h.elapsedMs)}ms</span>
                        </>
                      )}
                    </p>
                  </div>
                  <ArrowRight className="mt-1 h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SnippetsSection({
  entries,
  connectionsById,
  onOpen,
}: {
  entries: ReturnType<typeof useSnippets.getState>['entries'];
  connectionsById: Map<string, ConnectionProfile>;
  onOpen: (profile: ConnectionProfile, sql: string) => void;
}) {
  return (
    <section className="rounded-xl border bg-card p-5">
      <SectionHeader
        title="Saved snippets"
        subtitle="Click to load into the snippet's connection"
        icon={<Bookmark className="h-4 w-4" />}
      />
      {entries.length === 0 ? (
        <p className="mt-4 rounded border border-dashed p-6 text-center text-xs text-muted-foreground">
          No snippets yet. Save a query from the SQL editor to reuse it later.
        </p>
      ) : (
        <ul className="mt-3 space-y-1">
          {entries.map((s) => {
            const profile = connectionsById.get(s.connectionId);
            if (!profile) return null;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onOpen(profile, s.sql)}
                  className="group flex w-full items-start gap-3 rounded-md p-2 text-left hover:bg-accent/50"
                >
                  <Bookmark className="mt-1 h-3 w-3 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-1 text-[13px] font-medium">{s.name}</p>
                    <p className="mt-0.5 line-clamp-1 font-mono text-[11px] text-muted-foreground">
                      {s.sql.replace(/\s+/g, ' ').trim()}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {profile.name} · {formatRelative(s.updatedAt ?? s.createdAt)}
                    </p>
                  </div>
                  <ArrowRight className="mt-1 h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SectionHeader({
  title,
  subtitle,
  icon,
  right,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          {icon && <span className="text-muted-foreground">{icon}</span>}
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </h2>
        </div>
        {subtitle && <p className="mt-1 text-xs text-muted-foreground/80">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

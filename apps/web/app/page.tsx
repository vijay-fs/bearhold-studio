'use client';

// Root dashboard — redesigned for a work-oriented desktop app.
//
// Layout (top to bottom):
//   1. Greeting bar — time-of-day salutation + at-a-glance stats
//      (connections, queries this week). Sets tone; also carries
//      the always-visible "New connection" action.
//   2. Resume card (if there's activity) — big affordance for the
//      last-opened connection so a returning user is one click into
//      their previous session. Also links straight to the last
//      query they ran on that connection.
//   3. Pinned connections — a visually distinct strip if any exist.
//   4. Other connections grid — cleaner cards with a coloured engine
//      accent stripe.
//   5. Activity panel — recent queries + saved snippets share a
//      tabbed panel so they don't consume double vertical space.
//   6. Utility rail — schema diff / data diff / export / import.
//
// First run has its own warmer empty state without the noise above.

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
  Download,
  Upload,
  Activity,
  Zap,
  ChevronRight,
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

// Colour system:
//   - `accent` is used for tinted badges + soft backgrounds
//   - `stripe` colours the left-edge accent bar on connection cards
//   - `dot` is the small marker used in list rows
// Kept in one map so a future theme tweak lands in one place.
const ENGINE_STYLE: Partial<
  Record<
    DatabaseEngine,
    { accent: string; stripe: string; dot: string; label: string }
  >
> = {
  postgres: {
    accent: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-500/30',
    stripe: 'from-sky-400/60 to-sky-500/10',
    dot: 'bg-sky-500',
    label: 'text-sky-700 dark:text-sky-300',
  },
  mysql: {
    accent: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/30',
    stripe: 'from-amber-400/60 to-amber-500/10',
    dot: 'bg-amber-500',
    label: 'text-amber-700 dark:text-amber-300',
  },
  sqlite: {
    accent: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30',
    stripe: 'from-emerald-400/60 to-emerald-500/10',
    dot: 'bg-emerald-500',
    label: 'text-emerald-700 dark:text-emerald-300',
  },
  mongodb: {
    accent: 'bg-green-500/10 text-green-700 dark:text-green-300 ring-green-500/30',
    stripe: 'from-green-400/60 to-green-500/10',
    dot: 'bg-green-500',
    label: 'text-green-700 dark:text-green-300',
  },
  redis: {
    accent: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-500/30',
    stripe: 'from-rose-400/60 to-rose-500/10',
    dot: 'bg-rose-500',
    label: 'text-rose-700 dark:text-rose-300',
  },
};

const ENGINE_ROUTE: Partial<Record<DatabaseEngine, string>> = {
  postgres: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  mongodb: 'mongo',
  redis: 'redis',
};

function styleFor(engine: DatabaseEngine) {
  return (
    ENGINE_STYLE[engine] ?? {
      accent: 'bg-muted text-muted-foreground ring-border',
      stripe: 'from-muted-foreground/40 to-muted-foreground/10',
      dot: 'bg-muted-foreground',
      label: 'text-muted-foreground',
    }
  );
}

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

/** Time-of-day greeting. Recomputed on the client after mount so
 *  Tokyo and NYC users see the correct salutation even under the
 *  same static build. */
function greetingFor(hour: number): string {
  if (hour < 5) return 'Working late';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 22) return 'Good evening';
  return 'Burning the midnight oil';
}

// --- Page --------------------------------------------------------

export default function HomePage() {
  const profiles = useConnections((s) => s.profiles);
  const meta = useConnections((s) => s.meta);
  const historyEntries = useQueryHistory((s) => s.entries);
  const snippets = useSnippets((s) => s.entries);
  const router = useRouter();

  // Sort connections by pinned → last-used → alpha. Cheap, runs
  // once per store update.
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

  const pinned = useMemo(
    () => orderedConnections.filter((p) => meta[p.id]?.pinned),
    [orderedConnections, meta],
  );
  const others = useMemo(
    () => orderedConnections.filter((p) => !meta[p.id]?.pinned),
    [orderedConnections, meta],
  );

  // 50 is enough for scanning; the History and Snippets pages own
  // full search/filter. Scrolls within the ActivityPanel's fixed
  // height so the page footer stays put.
  const recentHistory = useMemo(() => historyEntries.slice(0, 50), [historyEntries]);
  const recentSnippets = useMemo(() => {
    return [...snippets]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 50);
  }, [snippets]);

  const connectionsById = useMemo(() => {
    const map = new Map<string, ConnectionProfile>();
    for (const p of profiles) map.set(p.id, p);
    return map;
  }, [profiles]);

  // Resume target: whichever connection has the most-recent lastUsedAt.
  const resumeTarget = useMemo(() => {
    const withUse = orderedConnections
      .filter((p) => meta[p.id]?.lastUsedAt)
      .sort(
        (a, b) => (meta[b.id]?.lastUsedAt ?? 0) - (meta[a.id]?.lastUsedAt ?? 0),
      );
    return withUse[0] ?? null;
  }, [orderedConnections, meta]);
  const resumeLastQuery = useMemo(() => {
    if (!resumeTarget) return null;
    return (
      historyEntries.find((h) => h.connectionId === resumeTarget.id) ?? null
    );
  }, [historyEntries, resumeTarget]);

  // Stats: connections total + query count in the last 7 days. Cheap
  // linear scan over `entries` — capped at 500 anyway.
  const queriesLast7d = useMemo(() => {
    const cutoff = Date.now() - 7 * 86_400_000;
    return historyEntries.filter((h) => h.timestamp >= cutoff).length;
  }, [historyEntries]);

  const isEmpty = profiles.length === 0;

  return (
    <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/20">
      <CommandPalette />
      <KeyboardShortcutsDialog />
      <div className="mx-auto w-full max-w-6xl px-6 py-10 sm:py-14">
        <GreetingBar
          isEmpty={isEmpty}
          connectionsCount={profiles.length}
          queriesLast7d={queriesLast7d}
          snippetsCount={snippets.length}
        />

        {isEmpty ? (
          <EmptyState />
        ) : (
          <div className="mt-10 space-y-10">
            {resumeTarget && (
              <ResumeCard
                profile={resumeTarget}
                lastQuery={resumeLastQuery}
                lastUsedAt={meta[resumeTarget.id]?.lastUsedAt}
              />
            )}

            {pinned.length > 0 && (
              <ConnectionSection
                title="Pinned"
                subtitle={`${pinned.length} kept at the top of your list`}
                icon={<Pin className="h-3.5 w-3.5" />}
              >
                <ConnectionGrid connections={pinned} meta={meta} />
              </ConnectionSection>
            )}

            {others.length > 0 && (
              <ConnectionSection
                title={pinned.length > 0 ? 'Other connections' : 'Connections'}
                subtitle={`${others.length} total`}
                icon={<Database className="h-3.5 w-3.5" />}
                right={
                  <Link
                    href="/connections"
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    Manage all
                    <ChevronRight className="h-3 w-3" />
                  </Link>
                }
              >
                <ConnectionGrid connections={others} meta={meta} />
              </ConnectionSection>
            )}

            {/* Activity + Tools stack full-width. Activity is a
                tabbed panel with a fixed-height scrollable body so
                the page's total height stays predictable no matter
                how much history the user has accumulated; Tools is
                a wide 4-across tile row on md+ so every tool is one
                click without stealing dashboard height. */}
            <ActivityPanel
              historyEntries={recentHistory}
              snippetEntries={recentSnippets}
              connectionsById={connectionsById}
              onOpenQuery={(profile, sql) =>
                loadSqlInWorkspace(router, profile, sql, false)
              }
              onOpenSnippet={(profile, sql) =>
                loadSqlInWorkspace(router, profile, sql, false)
              }
            />
            <UtilityRail />
          </div>
        )}
      </div>
    </main>
  );
}

// --- Greeting bar + stats ---------------------------------------

function GreetingBar({
  isEmpty,
  connectionsCount,
  queriesLast7d,
  snippetsCount,
}: {
  isEmpty: boolean;
  connectionsCount: number;
  queriesLast7d: number;
  snippetsCount: number;
}) {
  const [greeting, setGreeting] = useState('Welcome back');
  useEffect(() => {
    setGreeting(greetingFor(new Date().getHours()));
  }, []);

  return (
    <header className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
      <Link href="/" className="group flex items-center gap-3" aria-label="Go to dashboard">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5 ring-1 ring-primary/20 transition group-hover:from-primary/20">
          <Database className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {greeting}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Bearhold Studio
          </h1>
        </div>
      </Link>
      <div className="flex flex-wrap items-center gap-4">
        {!isEmpty && (
          <div className="hidden items-center gap-3 sm:flex">
            <StatPill
              icon={<Database className="h-3 w-3" />}
              label="Connections"
              value={connectionsCount}
            />
            <StatPill
              icon={<Activity className="h-3 w-3" />}
              label="Queries (7d)"
              value={queriesLast7d}
            />
            <StatPill
              icon={<Bookmark className="h-3 w-3" />}
              label="Snippets"
              value={snippetsCount}
            />
          </div>
        )}
        <Link
          href="/connections/new"
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90"
        >
          <Plus className="h-3.5 w-3.5" />
          New connection
        </Link>
      </div>
    </header>
  );
}

function StatPill({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card/60 px-3 py-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

// --- Resume card -------------------------------------------------

function ResumeCard({
  profile,
  lastQuery,
  lastUsedAt,
}: {
  profile: ConnectionProfile;
  lastQuery: { id: string; sql: string; timestamp: number } | null;
  lastUsedAt: number | undefined;
}) {
  const style = styleFor(profile.engine);
  const route = routeFor(profile.engine);
  return (
    <section
      className={cn(
        'relative overflow-hidden rounded-2xl border bg-card p-5 shadow-sm',
      )}
    >
      <div
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-1 bg-gradient-to-b',
          style.stripe,
        )}
      />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Zap className="h-3.5 w-3.5 text-primary" />
            <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">
              Resume where you left off
            </p>
          </div>
          <div className="mt-3 flex items-baseline gap-3">
            <h2 className="truncate text-xl font-semibold tracking-tight">
              {profile.name}
            </h2>
            <span className={cn('text-[11px] font-medium', style.label)}>
              {ENGINE_LABELS[profile.engine]}
            </span>
            {lastUsedAt && (
              <span className="text-[11px] text-muted-foreground">
                · {formatRelative(lastUsedAt)}
              </span>
            )}
          </div>
          {lastQuery && (
            <p className="mt-2 line-clamp-1 font-mono text-[12px] text-muted-foreground">
              {lastQuery.sql.replace(/\s+/g, ' ').trim()}
            </p>
          )}
        </div>
        <Link
          href={`/${route}?cid=${profile.id}`}
          className="shrink-0 rounded-lg bg-foreground px-3.5 py-2 text-sm font-medium text-background shadow-sm transition hover:opacity-90"
        >
          Open
          <ArrowRight className="ml-1 inline h-3.5 w-3.5" />
        </Link>
      </div>
    </section>
  );
}

// --- Connections -------------------------------------------------

function ConnectionSection({
  title,
  subtitle,
  icon,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {icon}
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 text-xs text-muted-foreground/80">{subtitle}</p>
          )}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function ConnectionGrid({
  connections,
  meta,
}: {
  connections: ConnectionProfile[];
  meta: Record<string, { pinned?: boolean; lastUsedAt?: number }>;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {connections.map((c) => (
        <ConnectionCard key={c.id} profile={c} meta={meta[c.id] ?? {}} />
      ))}
    </div>
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
  const style = styleFor(profile.engine);
  const host =
    profile.engine === 'sqlite'
      ? profile.file_path ?? 'local file'
      : `${profile.host}${profile.port ? `:${profile.port}` : ''}`;
  return (
    <Link
      href={`/${route}?cid=${profile.id}`}
      className="group relative flex flex-col overflow-hidden rounded-xl border bg-card p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >
      {/* Left accent bar — the engine's colour. The rest of the card
          stays neutral so a wall of cards doesn't turn into a
          rainbow. */}
      <span
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-gradient-to-b transition group-hover:w-1',
          style.stripe,
        )}
      />

      <div className="mb-3 flex items-start justify-between gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1',
            style.accent,
          )}
        >
          {ENGINE_LABELS[profile.engine]}
        </span>
        {meta.pinned && <Pin className="h-3 w-3 fill-primary text-primary" />}
      </div>

      <h3 className="line-clamp-1 text-[15px] font-semibold">{profile.name}</h3>
      <p className="mt-0.5 line-clamp-1 font-mono text-[11px] text-muted-foreground">
        {host}
      </p>
      {profile.database && (
        <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground/80">
          {profile.database}
        </p>
      )}

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

// --- Activity panel (tabbed) ------------------------------------

function ActivityPanel({
  historyEntries,
  snippetEntries,
  connectionsById,
  onOpenQuery,
  onOpenSnippet,
}: {
  historyEntries: ReturnType<typeof useQueryHistory.getState>['entries'];
  snippetEntries: ReturnType<typeof useSnippets.getState>['entries'];
  connectionsById: Map<string, ConnectionProfile>;
  onOpenQuery: (profile: ConnectionProfile, sql: string) => void;
  onOpenSnippet: (profile: ConnectionProfile, sql: string) => void;
}) {
  const [tab, setTab] = useState<'queries' | 'snippets'>('queries');
  return (
    <section className="rounded-2xl border bg-card p-5 shadow-sm">
      <div className="mb-4 flex items-end justify-between">
        <div className="flex items-baseline gap-4">
          <TabButton
            active={tab === 'queries'}
            onClick={() => setTab('queries')}
            icon={<History className="h-3.5 w-3.5" />}
            label="Recent queries"
            count={historyEntries.length}
          />
          <TabButton
            active={tab === 'snippets'}
            onClick={() => setTab('snippets')}
            icon={<Bookmark className="h-3.5 w-3.5" />}
            label="Saved snippets"
            count={snippetEntries.length}
          />
        </div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
          click to load
        </p>
      </div>

      {/* Fixed-height scroll container so a user with 300 queries in
          history doesn't push the page's footer off the screen. The
          scroll bar uses the app-wide thin style so it doesn't dominate
          the rounded card. h-[22rem] ~ 352px — roughly 8 visible rows,
          which is the sweet spot for scanning without over-scrolling.*/}
      <div className="scrollbar-thin -mx-2 h-[22rem] overflow-y-auto px-2">
        {tab === 'queries' ? (
          historyEntries.length === 0 ? (
            <EmptyRow label="No queries yet. Run one to see it here." />
          ) : (
            <ul className="space-y-0.5">
              {historyEntries.map((h) => {
                const profile = connectionsById.get(h.connectionId);
                if (!profile) return null;
                const style = styleFor(profile.engine);
                return (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => onOpenQuery(profile, h.sql)}
                      className="group flex w-full items-start gap-3 rounded-lg p-2 text-left hover:bg-accent/50"
                    >
                      <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', style.dot)} />
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 font-mono text-[12px] text-foreground/90">
                          {h.sql.replace(/\s+/g, ' ').trim()}
                        </p>
                        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span className="font-medium">{profile.name}</span>
                          <Dot />
                          <span>{formatRelative(h.timestamp)}</span>
                          {typeof h.elapsedMs === 'number' && (
                            <>
                              <Dot />
                              <span>{Math.round(h.elapsedMs)}ms</span>
                            </>
                          )}
                          {h.status === 'error' && (
                            <>
                              <Dot />
                              <span className="text-destructive">failed</span>
                            </>
                          )}
                        </div>
                      </div>
                      <ArrowRight className="mt-1 h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : snippetEntries.length === 0 ? (
          <EmptyRow label="No snippets yet. Save one from the SQL editor." />
        ) : (
          <ul className="space-y-0.5">
            {snippetEntries.map((s) => {
              const profile = connectionsById.get(s.connectionId);
              if (!profile) return null;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onOpenSnippet(profile, s.sql)}
                    className="group flex w-full items-start gap-3 rounded-lg p-2 text-left hover:bg-accent/50"
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
      </div>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-center gap-2 border-b-2 pb-2 text-sm transition',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      <span
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md transition',
          active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span className="font-semibold">{label}</span>
      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
        {count}
      </span>
    </button>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
      {label}
    </p>
  );
}

function Dot() {
  return <span className="text-muted-foreground/40">·</span>;
}

// --- Utility rail -----------------------------------------------

function UtilityRail() {
  return (
    <section className="rounded-2xl border bg-card p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Tools
        </h2>
        <div className="flex items-center gap-1.5 rounded-md bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
          <Command className="h-3 w-3" />
          <span>Command palette</span>
          <PlatformShortcut keys={['K']} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <ToolTile
          href="/compare"
          icon={<GitCompare className="h-4 w-4" />}
          label="Compare"
          description="Schema + data diff, apply generated SQL"
        />
        <ToolTile
          href="/export"
          icon={<Download className="h-4 w-4" />}
          label="Export"
          description="pg_dump / mysqldump"
        />
        <ToolTile
          href="/import"
          icon={<Upload className="h-4 w-4" />}
          label="Import"
          description="Restore a dump"
        />
      </div>
    </section>
  );
}

function ToolTile({
  href,
  icon,
  label,
  description,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 rounded-xl border bg-background p-3 transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition group-hover:bg-primary/15">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold">{label}</p>
        <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
          {description}
        </p>
      </div>
      <ArrowRight className="mt-2 h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
    </Link>
  );
}

// --- Empty state ------------------------------------------------

function EmptyState() {
  return (
    <div className="mt-12 grid gap-10 lg:grid-cols-[1.25fr_1fr] lg:items-center">
      <div>
        <div className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary ring-1 ring-primary/20">
          <Sparkles className="h-3 w-3" />
          Get started
        </div>
        <h2 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">
          Connect your first database.
        </h2>
        <p className="mt-4 max-w-xl text-base text-muted-foreground">
          Everything runs locally on your machine — connection details, query
          history, and saved snippets never leave this device.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/connections/new"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            New connection
          </Link>
          <Link
            href="/connections"
            className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Import from TablePlus / .pgpass
          </Link>
        </div>
      </div>
      <div className="rounded-2xl border bg-card p-6 shadow-sm">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          What&apos;s inside
        </p>
        <ul className="mt-4 space-y-3 text-sm">
          <FeatureRow
            icon={<Rows3 className="h-4 w-4" />}
            label="Result grid with inline edit, drag-select, and FK navigation"
          />
          <FeatureRow
            icon={<GitCompare className="h-4 w-4" />}
            label="Schema and data diff between two connections"
          />
          <FeatureRow
            icon={<Command className="h-4 w-4" />}
            label="Command palette (⌘K) and multi-tab SQL editor"
          />
          <FeatureRow
            icon={<Download className="h-4 w-4" />}
            label="Export / import via pg_dump, mysqldump, and friends"
          />
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

// --- Platform shortcut kbd --------------------------------------

/** Renders a keyboard shortcut label that matches the host OS: ⌘K on
 *  macOS, Ctrl+K everywhere else. Uses a mount effect to avoid an
 *  SSR/CSR label mismatch — the initial render shows a neutral label
 *  that swaps after mount. */
function PlatformShortcut({ keys }: { keys: string[] }) {
  const [label, setLabel] = useState<string>(() => `Ctrl+${keys.join('+')}`);
  useEffect(() => {
    setLabel(shortcutLabel(...keys));
  }, [keys.join('+')]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <kbd className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-border">
      {label}
    </kbd>
  );
}

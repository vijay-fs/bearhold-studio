'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import {
  Database,
  Plus,
  Workflow,
  Pencil,
  Trash2,
  Table2,
  Search,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  History,
  Bookmark,
  Sun,
  Moon,
  Pin,
  PinOff,
  GitCompare,
} from 'lucide-react';

import { useConnections } from '@/store/connections';
import { useSchemaCache } from '@/store/schemaCache';
import { ENGINE_LABELS, type ConnectionProfile } from '@/lib/types';
import { openTableInSql } from '@/lib/openTable';
import { cn } from '@/lib/utils';
import { readTheme, setTheme, type Theme } from '@/lib/theme';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CommandPalette } from '@/components/CommandPalette';
import { KeyboardShortcutsDialog } from '@/components/KeyboardShortcutsDialog';

export function AppShell({ children }: { children: React.ReactNode }) {
  const profiles = useConnections((s) => s.profiles);
  const meta = useConnections((s) => s.meta);
  const remove = useConnections((s) => s.remove);
  const markUsed = useConnections((s) => s.markUsed);
  const togglePinned = useConnections((s) => s.togglePinned);
  const pathname = usePathname();
  const router = useRouter();

  // Bump lastUsedAt whenever the route lands on a connection page. One
  // effect here covers every sub-page (sql/schema/history/snippets/edit)
  // so each individual page doesn't have to remember to do it.
  useEffect(() => {
    const m = pathname?.match(/^\/connections\/([^/]+)(\/|$)/);
    const cid = m?.[1];
    if (cid && profiles.some((p) => p.id === cid)) {
      markUsed(cid);
    }
  }, [pathname, profiles, markUsed]);

  // Sort: pinned connections first (most-recently-used among pinned at
  // the top), then unpinned by lastUsedAt, then anything else
  // alphabetically. Stable across renders because we sort a fresh copy
  // each time profile/meta change.
  const sortedProfiles = useMemo(() => {
    const copy = [...profiles];
    copy.sort((a, b) => {
      const ma = meta[a.id];
      const mb = meta[b.id];
      if (Boolean(ma?.pinned) !== Boolean(mb?.pinned)) {
        return ma?.pinned ? -1 : 1;
      }
      const la = ma?.lastUsedAt ?? 0;
      const lb = mb?.lastUsedAt ?? 0;
      if (la !== lb) return lb - la;
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [profiles, meta]);

  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(
    null,
  );

  const askDelete = (id: string, name: string) => {
    setPendingDelete({ id, name });
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { id } = pendingDelete;
    try {
      const { api } = await import('@/lib/api');
      await api.deleteSecrets(id);
    } catch {
      // Best-effort secret cleanup — profile delete still proceeds.
    }
    remove(id);
    setPendingDelete(null);
    if (pathname?.startsWith(`/connections/${id}`)) {
      router.push('/connections' as Route);
    }
  };

  return (
    <div className="grid h-screen grid-cols-[260px_1fr] bg-background">
      <aside className="flex flex-col border-r bg-secondary/30">
        <div className="flex items-center gap-2 border-b px-5 py-3.5">
          <Database className="h-5 w-5 text-primary" />
          <span className="text-sm font-semibold tracking-tight">dbstudio</span>
        </div>

        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Connections
          </span>
          <Link
            href="/connections/new"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            aria-label="Add connection"
          >
            <Plus className="h-3.5 w-3.5" />
          </Link>
        </div>

        <nav className="scrollbar-hidden flex-1 overflow-y-auto px-2 pb-4">
          {profiles.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No connections yet. Click + to add one.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {sortedProfiles.map((p) => {
                // Default connection click lands in the engine's
                // primary workspace — SQL editor for SQL engines,
                // document browser for MongoDB, key/value browser for
                // Redis. NoSQL engines don't have a SQL editor at all
                // so we route them straight to the workspace that
                // matches their semantics.
                const defaultPath =
                  p.engine === 'mongodb'
                    ? 'mongo'
                    : p.engine === 'redis'
                      ? 'redis'
                      : 'sql';
                const href = `/connections/${p.id}/${defaultPath}` as Route;
                const active = pathname?.startsWith(`/connections/${p.id}`);
                return (
                  <li key={p.id}>
                    <div
                      className={cn(
                        'group flex items-center gap-1 rounded-md pl-3 pr-1 text-xs',
                        active
                          ? 'bg-background font-medium text-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      <Link
                        href={href}
                        className="flex min-w-0 flex-1 items-center gap-2 py-1.5"
                      >
                        <Database className="h-3.5 w-3.5 shrink-0" />
                        <span className="flex-1 truncate">{p.name}</span>
                        {meta[p.id]?.pinned && (
                          <Pin
                            className="h-2.5 w-2.5 shrink-0 text-muted-foreground"
                            aria-label="Pinned"
                          />
                        )}
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                          {ENGINE_LABELS[p.engine]}
                        </span>
                      </Link>
                      <ConnectionMenu
                        profileId={p.id}
                        engine={p.engine}
                        onDelete={() => askDelete(p.id, p.name)}
                        active={Boolean(active)}
                        pinned={Boolean(meta[p.id]?.pinned)}
                        onTogglePin={() => togglePinned(p.id)}
                      />
                    </div>
                    {/* TableNav is SQL-shaped (introspects tables /
                        columns) — Mongo/Redis don't surface tables via
                        the SQL Driver trait, and their workspaces have
                        their own native navigation, so skip rendering
                        it for those engines. */}
                    {active && p.engine !== 'mongodb' && p.engine !== 'redis' && (
                      <div className="mt-1 ml-7">
                        <TableNav profile={p} pathname={pathname ?? ''} router={router} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <div className="border-t px-2 py-1.5">
          <Link
            href={'/diff' as Route}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs',
              pathname === '/diff'
                ? 'bg-background font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <GitCompare className="h-3.5 w-3.5 shrink-0" />
            <span>Schema diff</span>
          </Link>
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-5 py-2.5 text-[10px] text-muted-foreground">
          <span>Phase 1 · local-only · unsigned build</span>
          <ThemeToggle />
        </div>
      </aside>

      <main className="scrollbar-hidden flex min-h-0 flex-col overflow-y-auto">
        {children}
      </main>

      <Dialog
        open={pendingDelete != null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete connection</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{pendingDelete?.name}</span>{' '}
              will be removed from this device. Its saved password and any SSH credentials
              in the OS keychain are also deleted. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete connection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CommandPalette />
      <KeyboardShortcutsDialog />
    </div>
  );
}

/** Per-connection kebab menu. Holds the "rare" actions — Schema, History,
 *  Snippets, Edit, Delete — so the sidebar row stays clean for the common
 *  click-to-open-SQL flow. Each item navigates via <Link>-equivalent
 *  prefetched anchor; Delete is destructive and goes through the parent's
 *  confirm dialog. */
/** Footer-level theme switch. Reads the current theme on mount (after
 *  the no-flash script has already set `.dark` if appropriate) and
 *  drives `setTheme` to flip the class + persist on click. Stays as a
 *  small icon-only button so it doesn't crowd the build-info line. */
function ThemeToggle() {
  const [theme, setLocalTheme] = useState<Theme>('light');
  useEffect(() => {
    setLocalTheme(readTheme());
  }, []);
  const flip = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setLocalTheme(next);
  };
  return (
    <button
      type="button"
      onClick={flip}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className="rounded p-1 hover:bg-accent hover:text-foreground"
    >
      {theme === 'dark' ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
    </button>
  );
}

function ConnectionMenu({
  profileId,
  engine,
  onDelete,
  active,
  pinned,
  onTogglePin,
}: {
  profileId: string;
  engine: ConnectionProfile['engine'];
  onDelete: () => void;
  active: boolean;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  // Schema / History / Snippets are SQL-only concepts. Mongo and Redis
  // don't have introspectable relational schemas, don't accumulate
  // query history (they aren't queries), and don't host saved SQL
  // snippets. Hide those entries on non-SQL connections so the user
  // can't navigate into pages that would just error out.
  const sqlOnly = engine !== 'mongodb' && engine !== 'redis';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Connection options"
        className={cn(
          'shrink-0 rounded p-1 text-muted-foreground transition-opacity',
          'hover:bg-accent hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring',
          // Always visible on the active row; hover-reveal otherwise so
          // idle connections in the list stay visually quiet.
          active
            ? 'opacity-80 hover:opacity-100'
            : 'opacity-0 group-hover:opacity-80 focus:opacity-100',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      {/* Open downward from the kebab and right-align so the menu stays
          fully inside the 260px sidebar column. `side="right"` would push
          it into the main content area and cover the SQL workspace's tab
          bar — exactly what we want to avoid. */}
      <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
        <DropdownMenuItem onSelect={onTogglePin}>
          {pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
          {pinned ? 'Unpin' : 'Pin to top'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {sqlOnly && (
          <>
            <DropdownMenuItem asChild>
              <Link href={`/connections/${profileId}/schema` as Route}>
                <Workflow className="h-3 w-3" />
                Schema
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/connections/${profileId}/history` as Route}>
                <History className="h-3 w-3" />
                History
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/connections/${profileId}/snippets` as Route}>
                <Bookmark className="h-3 w-3" />
                Saved snippets
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem asChild>
          <Link href={`/connections/${profileId}/edit` as Route}>
            <Pencil className="h-3 w-3" />
            Edit
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem destructive onSelect={onDelete}>
          <Trash2 className="h-3 w-3" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Filterable table list for the active connection. Lazy-loads the schema
 * the first time the user opens the connection in the sidebar; afterwards
 * the cached value is reused. Click a table → jump to the table browser
 * route. Schema-qualifies the label only when the table isn't in the
 * connection's default schema (`public` / `main` / the active DB) so the
 * common case stays uncluttered.
 */
function TableNav({
  profile,
  pathname,
  router,
}: {
  profile: ConnectionProfile;
  pathname: string;
  router: { push: (href: Route) => void };
}) {
  void pathname;
  const schema = useSchemaCache((s) => s.entries[profile.id]?.schema);
  const loadSchema = useSchemaCache((s) => s.load);
  const inFlight = useSchemaCache((s) => Boolean(s.inFlight[profile.id]));
  const [filter, setFilter] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Fire one fetch attempt when the panel opens with no cached schema.
  // We don't aggressively re-fetch — the schema page or the SQL workspace
  // will pull a fresh copy when the user gets there.
  useEffect(() => {
    if (schema || inFlight) return;
    setLoadError(null);
    void loadSchema(profile).catch((e: unknown) => {
      const err = e as { code?: string; message?: string };
      setLoadError(err.code ?? err.message ?? 'load failed');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);

  const defaultSchema = useMemo(() => {
    if (profile.engine === 'mysql' || profile.engine === 'mariadb') return profile.database;
    if (profile.engine === 'sqlite') return 'main';
    return 'public';
  }, [profile.engine, profile.database]);

  // Flat list of every table in the connection, sorted alphabetically.
  // Tables outside the connection's default schema get a `schema.` prefix
  // in the displayed label so the user can tell which they're looking at.
  const tables = useMemo(() => {
    if (!schema) return [] as Array<{ schemaName: string; name: string; qualified: boolean }>;
    const flat: Array<{ schemaName: string; name: string; qualified: boolean }> = [];
    for (const ns of schema.schemas) {
      for (const t of ns.tables) {
        flat.push({
          schemaName: ns.name,
          name: t.name,
          qualified: ns.name.toLowerCase() !== defaultSchema.toLowerCase(),
        });
      }
    }
    return flat.sort((a, b) => a.name.localeCompare(b.name));
  }, [schema, defaultSchema]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return tables;
    return tables.filter(
      (t) =>
        t.name.toLowerCase().includes(needle) ||
        t.schemaName.toLowerCase().includes(needle),
    );
  }, [tables, filter]);

  // Outer collapse — the whole Tables section folds away (search + list)
  // behind a header toggle. Default expanded so the user sees their
  // tables; clicking the header collapses the entire block to a single
  // line that's easy to scroll past when working with many connections.
  const [outerCollapsed, setOuterCollapsed] = useState(false);

  if (loadError && !schema) {
    return (
      <div className="px-2 py-1 text-[10px] text-muted-foreground">
        <span className="font-mono text-destructive">{loadError}</span> — open the
        Schema page to retry.
      </div>
    );
  }
  if (!schema && inFlight) {
    return (
      <div className="px-2 py-1 text-[10px] text-muted-foreground">Loading tables…</div>
    );
  }
  if (!schema) return null;
  if (tables.length === 0) {
    return <div className="px-2 py-1 text-[10px] text-muted-foreground">No tables.</div>;
  }

  return (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={() => setOuterCollapsed((v) => !v)}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[9px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent/30 hover:text-foreground"
        title={outerCollapsed ? 'Expand tables' : 'Collapse tables'}
      >
        {outerCollapsed ? (
          <ChevronRight className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0" />
        )}
        <span>Tables</span>
        <span className="ml-auto pr-1 font-normal text-muted-foreground/70">
          {tables.length}
        </span>
      </button>
      {outerCollapsed ? null : (
        <>
          <div className="relative px-2">
            <Search className="absolute left-3.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              className="h-6 w-full rounded border border-input bg-background pl-6 pr-2 text-[10px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <ul className="scrollbar-thin max-h-[44vh] space-y-0 overflow-y-auto px-1 pt-1">
            {filtered.length === 0 ? (
              <li className="px-1.5 py-1 text-[10px] text-muted-foreground">
                No matches.
              </li>
            ) : (
              filtered.map((t) => (
                <li key={`${t.schemaName}.${t.name}`}>
                  <button
                    type="button"
                    onClick={() => openTableInSql(router, profile, t.schemaName, t.name)}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px]',
                      'text-muted-foreground hover:bg-accent/30 hover:text-foreground',
                    )}
                    title={`Open ${t.schemaName}.${t.name} in a new query tab`}
                  >
                    <Table2 className="h-3 w-3 shrink-0 opacity-70" />
                    <span className="truncate">
                      {t.qualified && (
                        <span className="text-muted-foreground/70">
                          {t.schemaName}.
                        </span>
                      )}
                      {t.name}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </>
      )}
    </div>
  );
}

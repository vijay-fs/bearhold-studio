'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
  Copy,
  FileCode,
  Info,
  AlertTriangle,
  Wrench,
  Download,
  Upload,
  ScrollText,
} from 'lucide-react';

import { useConnections } from '@/store/connections';
import { useSchemaCache } from '@/store/schemaCache';
import { useGridPrefs } from '@/store/gridPrefs';
import { ENGINE_LABELS, type ConnectionProfile } from '@/lib/types';
import { openTableInSql, buildSelectStarSql } from '@/lib/openTable';
import {
  buildCreateTableDdl,
  buildTruncateSql,
  buildDropTableSql,
} from '@/lib/createTableDdl';
import { api } from '@/lib/api';
import { TableDetailsDrawer } from '@/components/TableDetailsDrawer';
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
import { UpdateBanner } from '@/components/UpdateBanner';

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
    // After the static-export refactor the connection id lives in
    // the `?cid=` search param rather than a path segment. Read it
    // from the URL directly since usePathname() doesn't include
    // query strings.
    const url =
      typeof window !== 'undefined' ? new URL(window.location.href) : null;
    const cid = url?.searchParams.get('cid') ?? null;
    if (cid && profiles.some((p) => p.id === cid)) {
      markUsed(cid);
    }
  }, [pathname, profiles, markUsed]);

  // Global Cmd/Ctrl+A guard. Without this, the webview's default
  // behaviour is "select every piece of text on the page" — which
  // in a desktop app looks broken (the entire sidebar, headers,
  // labels, etc. all highlight). Native macOS apps only do
  // select-all inside the current edit context.
  //
  // We allow the native default in real editable contexts (text
  // inputs, textareas, contenteditable nodes, Monaco's editor) and
  // inside the result grid (which installs its own onKeyDown to do
  // a row select-all and stops propagation before we see the
  // event). Everywhere else, we preventDefault so the browser's
  // built-in "select all DOM text" doesn't fire.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'a') return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName?.toLowerCase();
      // Genuine edit contexts get their native select-all.
      if (tag === 'input' || tag === 'textarea' || t.isContentEditable) return;
      // Monaco intercepts Cmd+A internally; if focus is in it, the
      // browser event is what Monaco listens to — don't preventDefault.
      if (t.closest('.monaco-editor')) return;
      // The grid's wrapper stopped propagation already if it handled
      // this; arriving here means we're outside the grid. Block the
      // page-wide selection.
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

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
    // The deleted connection's id may live in `?cid=`; if the
    // current page is scoped to it, bounce back to the list.
    const url =
      typeof window !== 'undefined' ? new URL(window.location.href) : null;
    if (url?.searchParams.get('cid') === id) {
      router.push('/connections' as Route);
    }
  };

  return (
    <div className="grid h-screen grid-cols-[260px_1fr] bg-background">
      <aside className="flex flex-col border-r bg-secondary/30">
        {/* Header logo doubles as a "home" link — clicking it takes
            you back to the dashboard root, matching how nearly every
            other desktop app's logo behaves. */}
        <Link
          href="/"
          className="flex items-center gap-2 border-b px-5 py-3.5 transition hover:bg-accent/40"
          aria-label="Go to dashboard"
        >
          {/* Source PNG is white-stroked on transparent. We need it
              to read against both backgrounds: in light mode the
              white strokes vanish on a light background, so we
              invert (filter: invert(1)) — that flips the pixels to
              dark and they show. In dark mode we leave it alone, so
              the strokes stay white against the dark background.
              The `dark:invert-0` cancels the default `invert` only
              under the .dark theme. */}
          <img
            src="/app-icon.png"
            alt=""
            className="h-5 w-5 invert dark:invert-0"
          />
          <span className="text-sm font-semibold tracking-tight">Bearhold Studio</span>
        </Link>

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
                // document browser for MongoDB, key/value browser
                // for Redis. NoSQL engines don't have a SQL editor
                // at all so we route them straight to the workspace
                // that matches their semantics.
                const defaultPath =
                  p.engine === 'mongodb'
                    ? '/mongo'
                    : p.engine === 'redis'
                      ? '/redis'
                      : '/sql';
                const href = `${defaultPath}?cid=${p.id}` as Route;
                // "Active" is now a search-param check rather than a
                // path prefix. usePathname() doesn't include query
                // strings, so we read the URL directly each render
                // (cheap, no observability needed for an idle UI).
                const currentCid =
                  typeof window !== 'undefined'
                    ? new URL(window.location.href).searchParams.get('cid')
                    : null;
                const active = currentCid === p.id;
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

        <div className="space-y-0.5 border-t px-2 py-1.5">
          <SidebarUtilityLink
            href={'/compare' as Route}
            label="Compare"
            icon={<GitCompare className="h-3.5 w-3.5 shrink-0" />}
            active={pathname === '/compare' || pathname === '/diff' || pathname === '/data-diff'}
          />
          <SidebarUtilityLink
            href={'/export' as Route}
            label="Export"
            icon={<Download className="h-3.5 w-3.5 shrink-0" />}
            active={pathname === '/export'}
          />
          <SidebarUtilityLink
            href={'/import' as Route}
            label="Import"
            icon={<Upload className="h-3.5 w-3.5 shrink-0" />}
            active={pathname === '/import'}
          />
          <SidebarUtilityLink
            href={'/migrations' as Route}
            label="Migrations"
            icon={<ScrollText className="h-3.5 w-3.5 shrink-0" />}
            active={pathname === '/migrations'}
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-5 py-2.5 text-[10px] text-muted-foreground">
          <span>Phase 1 · local-only · unsigned build</span>
          <ThemeToggle />
        </div>
      </aside>

      <main className="scrollbar-hidden flex min-h-0 flex-col overflow-y-auto">
        <UpdateBanner />
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
              <Link href={`/schema?cid=${profileId}` as Route}>
                <Workflow className="h-3 w-3" />
                Schema
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/history?cid=${profileId}` as Route}>
                <History className="h-3 w-3" />
                History
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/snippets?cid=${profileId}` as Route}>
                <Bookmark className="h-3 w-3" />
                Saved snippets
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem asChild>
          <Link href={`/edit?cid=${profileId}` as Route}>
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
    if (profile.engine === 'mysql') return profile.database;
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

  // Right-click context menu state. `pos` is the menu's top-left in
  // viewport coordinates (we use position:fixed so it floats above
  // the sidebar without affecting layout). `tableRef` identifies the
  // row the user right-clicked on; all menu actions act on it.
  const rowLimit = useGridPrefs((s) => s.rowLimit);
  const reloadSchema = useSchemaCache((s) => s.load);
  const [menu, setMenu] = useState<
    { x: number; y: number; schema: string; name: string } | null
  >(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [detailsTarget, setDetailsTarget] =
    useState<{ schema: string; table: string } | null>(null);
  const [destructive, setDestructive] = useState<
    | { kind: 'truncate' | 'drop'; schema: string; name: string; sql: string }
    | null
  >(null);
  const [destructiveBusy, setDestructiveBusy] = useState(false);
  const [destructiveError, setDestructiveError] = useState<string | null>(null);

  // Dismiss the context menu on any outside click / Escape. We attach
  // to `document` because the menu can outlive the sidebar element it
  // was anchored to (e.g. user scrolls the sidebar). React's
  // `e.stopPropagation()` on the menu can't block a native document
  // listener, so we filter via ref containment instead — only close
  // when the click target is genuinely outside the menu DOM.
  useEffect(() => {
    if (!menu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const findTable = (schemaName: string, tableName: string) => {
    if (!schema) return null;
    const ns = schema.schemas.find((s) => s.name === schemaName);
    return ns?.tables.find((t) => t.name === tableName) ?? null;
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).catch(() => {});
  };

  const handleMenuAction = async (
    action:
      | 'open'
      | 'describe'
      | 'copy-select'
      | 'copy-create'
      | 'copy-name'
      | 'alter'
      | 'truncate'
      | 'drop',
    schemaName: string,
    tableName: string,
  ) => {
    setMenu(null);
    if (action === 'open') {
      openTableInSql(router, profile, schemaName, tableName, rowLimit);
      return;
    }
    if (action === 'describe') {
      setDetailsTarget({ schema: schemaName, table: tableName });
      return;
    }
    if (action === 'copy-select') {
      copy(buildSelectStarSql(profile.engine, schemaName, tableName, rowLimit));
      return;
    }
    if (action === 'copy-name') {
      const qualified =
        profile.engine === 'sqlite' || !schemaName
          ? tableName
          : `${schemaName}.${tableName}`;
      copy(qualified);
      return;
    }
    if (action === 'copy-create') {
      const t = findTable(schemaName, tableName);
      if (t) copy(buildCreateTableDdl(profile.engine, t));
      return;
    }
    if (action === 'alter') {
      // The Table Details drawer is the natural surface for ALTER
      // operations — it exposes Add Column / Edit / Drop per-column
      // already, plus full schema introspection for context.
      setDetailsTarget({ schema: schemaName, table: tableName });
      return;
    }
    if (action === 'truncate' || action === 'drop') {
      const t = findTable(schemaName, tableName);
      if (!t) return;
      const sql =
        action === 'truncate'
          ? buildTruncateSql(profile.engine, t)
          : buildDropTableSql(profile.engine, t);
      setDestructiveError(null);
      setDestructive({ kind: action, schema: schemaName, name: tableName, sql });
      return;
    }
  };

  const runDestructive = async () => {
    if (!destructive) return;
    setDestructiveBusy(true);
    setDestructiveError(null);
    try {
      await api.runQuery(profile, {
        sql: destructive.sql,
        query_id: crypto.randomUUID(),
      });
      // DROP TABLE removes the table from the catalog (and any
      // sidebar entry needs to disappear). TRUNCATE doesn't change
      // the schema shape, but the row-count surfacing elsewhere
      // might be stale; cheaper to refetch unconditionally. Force
      // because the cache otherwise hands back the pre-op entry.
      await reloadSchema(profile, true).catch(() => {});
      setDestructive(null);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setDestructiveError(err.message ?? err.code ?? 'failed');
    } finally {
      setDestructiveBusy(false);
    }
  };

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
                    onClick={() =>
                      handleMenuAction('open', t.schemaName, t.name)
                    }
                    onDoubleClick={() =>
                      handleMenuAction('open', t.schemaName, t.name)
                    }
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({
                        x: e.clientX,
                        y: e.clientY,
                        schema: t.schemaName,
                        name: t.name,
                      });
                    }}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px]',
                      'text-muted-foreground hover:bg-accent/30 hover:text-foreground',
                    )}
                    title={`Open ${t.schemaName}.${t.name} — right-click for more`}
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

      {/* Right-click context menu. Rendered as a position:fixed
          panel so it floats above the sidebar / pages without
          shifting layout. Dismissed on outside-click + Escape via
          the effect above. */}
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          style={{ top: menu.y, left: menu.x }}
          className="fixed z-50 min-w-[200px] rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
        >
          <ContextMenuItem
            icon={<Table2 className="h-3 w-3" />}
            label="Open"
            onSelect={() => handleMenuAction('open', menu.schema, menu.name)}
          />
          <ContextMenuItem
            icon={<Info className="h-3 w-3" />}
            label="Describe"
            onSelect={() => handleMenuAction('describe', menu.schema, menu.name)}
          />
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<Copy className="h-3 w-3" />}
            label="Copy SELECT *"
            onSelect={() => handleMenuAction('copy-select', menu.schema, menu.name)}
          />
          <ContextMenuItem
            icon={<FileCode className="h-3 w-3" />}
            label="Copy CREATE TABLE"
            onSelect={() => handleMenuAction('copy-create', menu.schema, menu.name)}
          />
          <ContextMenuItem
            icon={<Copy className="h-3 w-3" />}
            label="Copy qualified name"
            onSelect={() => handleMenuAction('copy-name', menu.schema, menu.name)}
          />
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<Wrench className="h-3 w-3" />}
            label="Alter table…"
            onSelect={() => handleMenuAction('alter', menu.schema, menu.name)}
          />
          <ContextMenuItem
            icon={<AlertTriangle className="h-3 w-3" />}
            label="Truncate…"
            destructive
            onSelect={() => handleMenuAction('truncate', menu.schema, menu.name)}
          />
          <ContextMenuItem
            icon={<Trash2 className="h-3 w-3" />}
            label="Drop table…"
            destructive
            onSelect={() => handleMenuAction('drop', menu.schema, menu.name)}
          />
        </div>
      )}

      {/* Describe / Alter — the table details drawer covers both. */}
      {schema && (
        <TableDetailsDrawer
          schema={schema}
          selection={detailsTarget}
          onClose={() => setDetailsTarget(null)}
          onOpenInSql={(s, n) => {
            setDetailsTarget(null);
            openTableInSql(router, profile, s, n, rowLimit);
          }}
          profile={profile}
          onSchemaChange={() => {
            // Force a fresh fetch — `load(profile)` short-circuits to
            // the cached entry by default, so without `force` the
            // drawer keeps showing the pre-ALTER column list.
            void reloadSchema(profile, true).catch(() => {});
          }}
        />
      )}

      {/* Truncate / Drop confirmation. Renders the exact SQL so
          the user can read what's about to execute — destructive
          actions get a typing-confirm gate on the table name. */}
      <Dialog
        open={destructive != null}
        onOpenChange={(o) => {
          if (!o && !destructiveBusy) {
            setDestructive(null);
            setDestructiveError(null);
          }
        }}
      >
        <DialogContent>
          {destructive && (
            <DestructiveConfirm
              kind={destructive.kind}
              tableLabel={
                destructive.schema && profile.engine !== 'sqlite'
                  ? `${destructive.schema}.${destructive.name}`
                  : destructive.name
              }
              sql={destructive.sql}
              busy={destructiveBusy}
              error={destructiveError}
              onCancel={() => {
                setDestructive(null);
                setDestructiveError(null);
              }}
              onConfirm={runDestructive}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ContextMenuItem({
  icon,
  label,
  onSelect,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 px-2 py-1 text-left text-[11px]',
        'hover:bg-accent hover:text-accent-foreground',
        destructive && 'text-destructive hover:bg-destructive/10 hover:text-destructive',
      )}
    >
      <span className="shrink-0 opacity-80">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function ContextMenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}

/**
 * Destructive confirmation panel for TRUNCATE / DROP. Renders the
 * exact SQL we're about to send (so the user can verify the
 * dialect-specific statement) and gates the Confirm button behind
 * the user typing the table name — protects against the misclick
 * case where the menu lands on the wrong row.
 */
function DestructiveConfirm({
  kind,
  tableLabel,
  sql,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  kind: 'truncate' | 'drop';
  tableLabel: string;
  sql: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const verbLabel = kind === 'truncate' ? 'Truncate' : 'Drop';
  const verbHint =
    kind === 'truncate'
      ? 'Empties every row. The table definition stays.'
      : 'Removes the table and every row inside it. This cannot be undone.';
  const matches = typed === tableLabel;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {verbLabel} {tableLabel}?
        </DialogTitle>
        <DialogDescription>{verbHint}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <pre className="overflow-x-auto rounded border bg-muted/40 px-3 py-2 font-mono text-[11px]">
          {sql}
        </pre>
        <div>
          <label className="text-[11px] text-muted-foreground">
            Type{' '}
            <span className="font-mono text-foreground">{tableLabel}</span>{' '}
            to confirm.
          </label>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            autoFocus
            className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-ring"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        {error && (
          <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
            {error}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={onConfirm}
          disabled={!matches || busy}
        >
          {busy ? `${verbLabel}ing…` : verbLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Shared row style for the sidebar's utility section (schema/data
 *  diff, export, import). Kept in one place so a style tweak lands
 *  in every row without a copy-paste pass. */
function SidebarUtilityLink({
  href,
  label,
  icon,
  active,
}: {
  href: Route;
  label: string;
  icon: React.ReactNode;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs',
        active
          ? 'bg-background font-medium text-foreground shadow-sm'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

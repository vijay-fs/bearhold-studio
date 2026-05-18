'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import {
  Database,
  Plus,
  Workflow,
  Terminal as TerminalIcon,
  Pencil,
  Trash2,
  Table2,
  Search,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

import { useConnections } from '@/store/connections';
import { useSchemaCache } from '@/store/schemaCache';
import { ENGINE_LABELS, type ConnectionProfile } from '@/lib/types';
import { openTableInSql } from '@/lib/openTable';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CommandPalette } from '@/components/CommandPalette';

export function AppShell({ children }: { children: React.ReactNode }) {
  const profiles = useConnections((s) => s.profiles);
  const remove = useConnections((s) => s.remove);
  const pathname = usePathname();
  const router = useRouter();

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

        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {profiles.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No connections yet. Click + to add one.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {profiles.map((p) => {
                const href = `/connections/${p.id}/schema` as Route;
                const active = pathname?.startsWith(`/connections/${p.id}`);
                return (
                  <li key={p.id}>
                    <Link
                      href={href}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs',
                        active
                          ? 'bg-background font-medium text-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      <Database className="h-3.5 w-3.5 shrink-0" />
                      <span className="flex-1 truncate">{p.name}</span>
                      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                        {ENGINE_LABELS[p.engine]}
                      </span>
                    </Link>
                    {active && (
                      <ul className="mt-0.5 ml-7 space-y-0.5">
                        <SubNavLink
                          href={`/connections/${p.id}/schema` as Route}
                          icon={<Workflow className="h-3 w-3" />}
                          label="Schema"
                          active={pathname === `/connections/${p.id}/schema`}
                        />
                        <SubNavLink
                          href={`/connections/${p.id}/sql` as Route}
                          icon={<TerminalIcon className="h-3 w-3" />}
                          label="SQL"
                          active={pathname === `/connections/${p.id}/sql`}
                        />
                        <SubNavLink
                          href={`/connections/${p.id}/edit` as Route}
                          icon={<Pencil className="h-3 w-3" />}
                          label="Edit"
                          active={pathname === `/connections/${p.id}/edit`}
                        />
                        <li>
                          <button
                            type="button"
                            onClick={() => askDelete(p.id, p.name)}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3" />
                            <span>Delete</span>
                          </button>
                        </li>
                        <li className="pt-1">
                          <TableNav profile={p} pathname={pathname ?? ''} router={router} />
                        </li>
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <div className="border-t px-5 py-2.5 text-[10px] text-muted-foreground">
          Phase 1 · local-only · unsigned build
        </div>
      </aside>

      <main className="flex min-h-0 flex-col overflow-y-auto">{children}</main>

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
    </div>
  );
}

function SubNavLink({
  href,
  icon,
  label,
  active,
}: {
  href: Route;
  icon: React.ReactNode;
  label: string;
  active: boolean;
}) {
  return (
    <li>
      <Link
        href={href}
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1 text-[11px]',
          active
            ? 'text-foreground font-medium'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {icon}
        <span>{label}</span>
      </Link>
    </li>
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
          <ul className="max-h-[44vh] space-y-0 overflow-y-auto px-1 pt-1">
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

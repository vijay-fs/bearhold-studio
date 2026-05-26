'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import type { Route } from 'next';
import { Command } from 'cmdk';
import {
  Database,
  Plus,
  Workflow,
  Terminal as TerminalIcon,
  Pencil,
  CheckCircle2,
  XCircle,
  Table2,
  Bookmark,
} from 'lucide-react';

import { useConnections } from '@/store/connections';
import { useQueryHistory } from '@/store/queryHistory';
import { useSchemaCache } from '@/store/schemaCache';
import { useSnippets } from '@/store/snippets';
import { ENGINE_LABELS } from '@/lib/types';
import { openTableInSql } from '@/lib/openTable';

/**
 * Global Cmd+K (Ctrl+K on non-mac) command palette. Mounted once at the
 * AppShell so the listener catches the keystroke anywhere in the app.
 *
 * Sections (in order, filtered by the user's typing):
 *  - Actions          — global, e.g. "Add connection"
 *  - Connections      — jump to schema/SQL/edit for any saved profile
 *  - Recent queries   — load into the current SQL workspace
 *
 * Recent queries are scoped to the connection the user is currently viewing
 * (derived from the URL), since loading a query is only useful in that
 * connection's editor. Selecting a recent query navigates to its SQL page
 * AND signals the editor to replace its buffer.
 */
export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const rawProfiles = useConnections((s) => s.profiles);
  const connectionMeta = useConnections((s) => s.meta);

  // Order: pinned first, then by most-recently-used. Names are a
  // tiebreaker so two never-used connections still have a stable order.
  // The palette's filter does its own fuzzy match on top of this so the
  // sort only matters when the user hasn't typed yet.
  const profiles = useMemo(() => {
    const copy = [...rawProfiles];
    copy.sort((a, b) => {
      const ma = connectionMeta[a.id];
      const mb = connectionMeta[b.id];
      if (Boolean(ma?.pinned) !== Boolean(mb?.pinned)) {
        return ma?.pinned ? -1 : 1;
      }
      const la = ma?.lastUsedAt ?? 0;
      const lb = mb?.lastUsedAt ?? 0;
      if (la !== lb) return lb - la;
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [rawProfiles, connectionMeta]);
  const allHistory = useQueryHistory((s) => s.entries);
  const cachedSchemas = useSchemaCache((s) => s.entries);
  const allSnippets = useSnippets((s) => s.entries);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  // Global Cmd/Ctrl + K to open. Skip when typing into an input/textarea
  // OR Monaco — Monaco binds Cmd+K to its own command palette and steals
  // the event before we see it, so this listener only fires from elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (!cmd || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Reset the search whenever the palette closes.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const activeConnectionId = useMemo(() => {
    const m = pathname?.match(/^\/connections\/([^/]+)/);
    return m && m[1] !== 'new' ? m[1] : null;
  }, [pathname]);

  const recentForConnection = useMemo(
    () =>
      activeConnectionId
        ? allHistory.filter((e) => e.connectionId === activeConnectionId).slice(0, 25)
        : [],
    [allHistory, activeConnectionId],
  );

  const snippetsForConnection = useMemo(
    () =>
      activeConnectionId
        ? allSnippets.filter((s) => s.connectionId === activeConnectionId)
        : [],
    [allSnippets, activeConnectionId],
  );

  // Tables for the active connection, sourced from the cached schema. If the
  // schema hasn't been loaded yet (user went straight to SQL workspace), this
  // is empty — the schema view fills the cache on load.
  const tablesForConnection = useMemo(() => {
    if (!activeConnectionId) return [];
    const cached = cachedSchemas[activeConnectionId];
    if (!cached) return [];
    const flat: Array<{ schema: string; table: string }> = [];
    for (const ns of cached.schema.schemas) {
      for (const t of ns.tables) flat.push({ schema: ns.name, table: t.name });
    }
    return flat;
  }, [cachedSchemas, activeConnectionId]);

  const close = () => setOpen(false);

  const go = (href: Route) => {
    router.push(href);
    close();
  };

  const loadRecentQuery = (id: string, sql: string) => {
    if (!activeConnectionId) return;
    // The SQL page picks this up on mount via the `palette-load-sql` event.
    sessionStorage.setItem('dbstudio.pendingSql', sql);
    sessionStorage.setItem('dbstudio.pendingSqlEntry', id);
    router.push(`/sql?cid=${activeConnectionId}` as Route);
    // Fire the event after the navigation tick so the SQL page is mounted.
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('palette-load-sql', { detail: { sql } }));
    }, 50);
    close();
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/50 pt-24 backdrop-blur-sm"
      shouldFilter={true}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Jump to a connection, recent query, or action…"
          className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <Command.List className="scrollbar-hidden max-h-[400px] overflow-y-auto p-1">
          <Command.Empty className="px-3 py-6 text-center text-xs text-muted-foreground">
            No matches.
          </Command.Empty>

          <Command.Group heading="Actions" className="palette-group">
            <PaletteItem
              icon={<Plus className="h-3.5 w-3.5" />}
              label="Add connection"
              shortcut="N"
              onSelect={() => go('/connections/new' as Route)}
            />
          </Command.Group>

          {profiles.length > 0 && (
            <Command.Group heading="Connections" className="palette-group">
              {profiles.map((p) => (
                <PaletteItem
                  key={`${p.id}-schema`}
                  icon={<Workflow className="h-3.5 w-3.5" />}
                  label={p.name}
                  meta={`${ENGINE_LABELS[p.engine]} · Schema`}
                  // Keywords boost match scoring for cmdk's built-in fuzzy.
                  keywords={[p.engine, ENGINE_LABELS[p.engine], 'schema']}
                  onSelect={() => go(`/schema?cid=${p.id}` as Route)}
                />
              ))}
              {profiles.map((p) => (
                <PaletteItem
                  key={`${p.id}-sql`}
                  icon={<TerminalIcon className="h-3.5 w-3.5" />}
                  label={p.name}
                  meta={`${ENGINE_LABELS[p.engine]} · SQL workspace`}
                  keywords={[p.engine, ENGINE_LABELS[p.engine], 'sql', 'query']}
                  onSelect={() => go(`/sql?cid=${p.id}` as Route)}
                />
              ))}
              {profiles.map((p) => (
                <PaletteItem
                  key={`${p.id}-edit`}
                  icon={<Pencil className="h-3.5 w-3.5" />}
                  label={p.name}
                  meta={`${ENGINE_LABELS[p.engine]} · Edit`}
                  keywords={['edit', 'settings']}
                  onSelect={() => go(`/edit?cid=${p.id}` as Route)}
                />
              ))}
            </Command.Group>
          )}

          {tablesForConnection.length > 0 && activeConnectionId && (
            <Command.Group heading="Tables" className="palette-group">
              {tablesForConnection.map(({ schema, table }) => (
                <PaletteItem
                  key={`${schema}.${table}`}
                  icon={<Table2 className="h-3.5 w-3.5" />}
                  label={table}
                  meta={schema}
                  keywords={[schema, 'browse', 'data']}
                  onSelect={() => {
                    const profile = profiles.find((p) => p.id === activeConnectionId);
                    if (!profile) return;
                    openTableInSql(router, profile, schema, table);
                    close();
                  }}
                />
              ))}
            </Command.Group>
          )}

          {snippetsForConnection.length > 0 && activeConnectionId && (
            <Command.Group heading="Snippets" className="palette-group">
              {snippetsForConnection.map((snippet) => (
                <PaletteItem
                  key={snippet.id}
                  icon={<Bookmark className="h-3.5 w-3.5 text-amber-500" />}
                  label={snippet.name}
                  meta="saved query"
                  keywords={[snippet.sql]}
                  onSelect={() => loadRecentQuery(snippet.id, snippet.sql)}
                />
              ))}
            </Command.Group>
          )}

          {recentForConnection.length > 0 && (
            <Command.Group heading="Recent queries" className="palette-group">
              {recentForConnection.map((entry) => {
                const preview = entry.sql
                  .split('\n')
                  .filter((l) => l.trim().length > 0)
                  .slice(0, 1)
                  .join('')
                  .slice(0, 80);
                return (
                  <PaletteItem
                    key={entry.id}
                    icon={
                      entry.status === 'ok' ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-destructive" />
                      )
                    }
                    label={preview || '(empty)'}
                    meta={
                      entry.status === 'ok'
                        ? `${entry.elapsedMs} ms · ${entry.rowsReturned ?? entry.rowsAffected ?? 0}`
                        : entry.errorCode
                    }
                    keywords={[entry.sql]}
                    onSelect={() => loadRecentQuery(entry.id, entry.sql)}
                  />
                );
              })}
            </Command.Group>
          )}
        </Command.List>

        <div className="flex items-center justify-between border-t px-3 py-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Database className="h-3 w-3" />
            Bearhold Studio
          </span>
          <span className="flex items-center gap-3">
            <span>
              <kbd className="rounded border px-1">↑</kbd>
              <kbd className="ml-0.5 rounded border px-1">↓</kbd> to navigate
            </span>
            <span>
              <kbd className="rounded border px-1">↵</kbd> to select
            </span>
            <span>
              <kbd className="rounded border px-1">Esc</kbd> to close
            </span>
          </span>
        </div>
      </div>
    </Command.Dialog>
  );
}

function PaletteItem({
  icon,
  label,
  meta,
  shortcut,
  keywords,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  meta?: string;
  shortcut?: string;
  keywords?: string[];
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      keywords={keywords}
      className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-xs aria-selected:bg-accent aria-selected:text-accent-foreground"
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {meta && <span className="text-[10px] text-muted-foreground">{meta}</span>}
      {shortcut && (
        <kbd className="rounded border px-1 text-[10px] text-muted-foreground">
          {shortcut}
        </kbd>
      )}
    </Command.Item>
  );
}

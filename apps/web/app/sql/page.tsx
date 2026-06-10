'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Loader2,
  Play,
  AlertCircle,
  Table2,
  Plus,
  X,
  Bookmark,
  Activity,
  Wand2,
  Square,
  Ban,
  Plug,
} from 'lucide-react';

import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { SqlEditor, type SqlEditorHandle } from '@/components/SqlEditor';
import { ResultTable } from '@/components/ResultTable';
import { SaveSnippetDialog } from '@/components/SnippetsPanel';
import {
  PlanViewer,
  buildExplainSql,
  explainSupportedFor,
} from '@/components/PlanViewer';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useConnections } from '@/store/connections';
import { useQueryHistory } from '@/store/queryHistory';
import { useSchemaCache } from '@/store/schemaCache';
import { useSqlTabs } from '@/store/sqlTabs';
import { useSnippets } from '@/store/snippets';
import { useGridPrefs, ROW_LIMIT_OPTIONS } from '@/store/gridPrefs';
import { buildSelectStarSql } from '@/lib/openTable';
import { api } from '@/lib/api';
import { ENGINE_LABELS, type QueryResult } from '@/lib/types';
import type { Schema } from '@dbstudio/erd';
import { cn } from '@/lib/utils';
import { detectEditableQuery } from '@/lib/detectEditableQuery';
import { buildFilteredSelectSql, loadSqlInWorkspace } from '@/lib/openTable';
import { suggestHint } from '@/lib/errorHints';

const STARTER_SQL = `-- Cmd/Ctrl + Enter to run
SELECT now(), version();
`;

/** The schema/database an unqualified identifier resolves to. Autocomplete
 *  uses this to decide whether to qualify a table reference in `insertText`,
 *  so the user doesn't accept a suggestion that the server can't resolve. */
function defaultSchemaFor(profile: { engine: string; database: string }): string {
  if (profile.engine === 'mysql' || profile.engine === 'mariadb') return profile.database;
  if (profile.engine === 'sqlite') return 'main';
  return 'public';
}

type RunState =
  | { kind: 'idle' }
  /** `queryId` is the same uuid we pass in the QueryRequest so the Stop
   *  button can target this exact run via `cancelQuery`. */
  | { kind: 'running'; queryId: string }
  | { kind: 'ok'; result: QueryResult; sql: string }
  | { kind: 'error'; code: string; message: string };

type PlanState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; result: QueryResult }
  | { kind: 'error'; code: string; message: string };

type BottomTab = 'results' | 'plan';

// Connection id flows in via the `cid` search param. Static
// routes only — no [id] segment — so the file ships at /sql/index.html
// (and similar) and the Tauri asset protocol always finds it.
function SqlPageInner() {
  const id = useSearchParams().get('cid') ?? '';
  const profile = useConnections((s) => s.profiles.find((p) => p.id === id));
  const router = useRouter();
  const editorRef = useRef<SqlEditorHandle>(null);
  const recordHistory = useQueryHistory((s) => s.record);
  const loadSchema = useSchemaCache((s) => s.load);
  // Schema must be DERIVED from the cache selector — not copied into local
  // useState. If Next.js soft-navigates between connections A → B, useState
  // initializers don't re-run, so a stale A schema would be passed to B's
  // editor and leak A's table names into B's autocomplete. The selector
  // re-evaluates whenever the slot for this connection's id changes.
  const schema = useSchemaCache((s) =>
    profile ? (s.entries[profile.id]?.schema ?? null) : null,
  );

  // Tabs are a slice of the store keyed by this connection id. The store
  // handles persistence; we just observe and call its actions.
  const slot = useSqlTabs((s) => (profile ? s.byConnection[profile.id] : undefined));
  const ensureTabs = useSqlTabs((s) => s.ensure);
  const newTab = useSqlTabs((s) => s.newTab);
  const closeTab = useSqlTabs((s) => s.closeTab);
  const setActive = useSqlTabs((s) => s.setActive);
  const setSql = useSqlTabs((s) => s.setSql);
  const loadIntoNewTab = useSqlTabs((s) => s.loadIntoNewTab);
  const openOrFocusTableTab = useSqlTabs((s) => s.openOrFocusTableTab);
  const markRan = useSqlTabs((s) => s.markRan);

  // Run state lives in-memory keyed by tab id so each tab keeps its own
  // result + error panel. Switching tabs swaps the visible panel; reloading
  // the page drops all run state (results don't persist — rerun is cheap).
  const [runByTab, setRunByTab] = useState<Record<string, RunState>>({});
  const [planByTab, setPlanByTab] = useState<Record<string, PlanState>>({});
  const [bottomTab, setBottomTab] = useState<BottomTab>('results');
  const [saveSnippetOpen, setSaveSnippetOpen] = useState(false);
  const createSnippet = useSnippets((s) => s.create);

  // First load for this connection: make sure there's at least one tab.
  useEffect(() => {
    if (!profile) return;
    ensureTabs(profile.id, STARTER_SQL);
  }, [profile?.id, ensureTabs]);

  // Lazy schema fetch for autocomplete. The selector above subscribes to
  // the cache, so a successful load triggers a re-render with the schema
  // populated — no local state assignment needed. We intentionally key
  // only on the connection id; `schema` and `loadSchema` are read inside
  // the effect via closure (loadSchema is a stable Zustand action;
  // schema is just a guard).
  useEffect(() => {
    if (!profile || schema) return;
    void loadSchema(profile).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  // Any feature that wants to "open this SQL in a new tab" goes through
  // the `palette-load-sql` event (table-open from the schema view, sidebar
  // table click, command palette, history rerun). The `autoRun` flag in
  // the event detail decides whether we also fire the query immediately —
  // which is the case for the table-browse flow.
  //
  // The same payload is mirrored to sessionStorage so that when the
  // trigger came from a different route (navigation hasn't completed when
  // the event fires), we drain it on mount.
  useEffect(() => {
    if (!profile) return;
    const open = (
      sql: string,
      autoRun: boolean,
      tableRef?: { schema: string; table: string },
    ) => {
      // Table-bound opens re-focus an existing tab for the same
      // table; query opens still get a fresh tab so prior buffers
      // stay intact. The store reports `isNew=false` when an open
      // tab was just re-focused; in that case we skip the auto-run
      // and let the existing result stay in place — re-clicking an
      // open table tab should feel like pure navigation, not a
      // requery.
      let shouldRun = autoRun;
      if (tableRef) {
        const { isNew } = openOrFocusTableTab(profile.id, sql, tableRef);
        if (!isNew) shouldRun = false;
      } else {
        loadIntoNewTab(profile.id, sql);
      }
      setBottomTab('results');
      if (shouldRun) setTimeout(() => void onRun(sql), 0);
    };
    const onPaletteLoad = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          sql: string;
          autoRun?: boolean;
          tableRef?: { schema: string; table: string };
        }>
      ).detail;
      if (detail?.sql) open(detail.sql, Boolean(detail.autoRun), detail.tableRef);
    };
    window.addEventListener('palette-load-sql', onPaletteLoad as EventListener);
    const pending = sessionStorage.getItem('dbstudio.pendingSql');
    if (pending) {
      const autoRun = sessionStorage.getItem('dbstudio.pendingSqlAutoRun') === '1';
      const refRaw = sessionStorage.getItem('dbstudio.pendingSqlTableRef');
      let ref: { schema: string; table: string } | undefined;
      if (refRaw) {
        try {
          ref = JSON.parse(refRaw);
        } catch {
          // ignore malformed marker
        }
      }
      sessionStorage.removeItem('dbstudio.pendingSql');
      sessionStorage.removeItem('dbstudio.pendingSqlEntry');
      sessionStorage.removeItem('dbstudio.pendingSqlAutoRun');
      sessionStorage.removeItem('dbstudio.pendingSqlTableRef');
      open(pending, autoRun, ref);
    }
    return () =>
      window.removeEventListener('palette-load-sql', onPaletteLoad as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  // Keyboard shortcuts: Cmd+T new, Cmd+W close, Cmd+1..9 switch.
  useEffect(() => {
    if (!profile) return;
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (!cmd) return;
      const key = e.key.toLowerCase();
      if (key === 't') {
        e.preventDefault();
        newTab(profile.id, '');
        return;
      }
      if (key === 'w') {
        e.preventDefault();
        const tabs = useSqlTabs.getState().byConnection[profile.id];
        if (tabs?.activeId) closeTab(profile.id, tabs.activeId);
        return;
      }
      if (/^[1-9]$/.test(key)) {
        const idx = Number(key) - 1;
        const tabs = useSqlTabs.getState().byConnection[profile.id]?.tabs;
        const target = tabs?.[idx];
        if (target) {
          e.preventDefault();
          setActive(profile.id, target.id);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  // Limit-change watcher is wired further down once `onRun` is in
  // scope; see the useEffect below the run helpers.

  // ---- derived state ----------------------------------------------------

  const activeTab = slot?.tabs.find((t) => t.id === slot.activeId) ?? slot?.tabs[0] ?? null;
  const state: RunState = activeTab ? (runByTab[activeTab.id] ?? { kind: 'idle' }) : { kind: 'idle' };
  const planState: PlanState = activeTab
    ? (planByTab[activeTab.id] ?? { kind: 'idle' })
    : { kind: 'idle' };
  const canExplain = explainSupportedFor(profile?.engine ?? 'postgres');

  // Light up editing on the result grid when the user's SQL was a plain
  // `SELECT * FROM <known_table>` — joins, projections, and CTEs stay
  // read-only because we can't safely map cells back to a single row.
  const editable = (() => {
    if (state.kind !== 'ok' || !schema || !profile) return undefined;
    const cfg = detectEditableQuery(state.sql, schema, profile, () => {
      // Re-run the same SQL after an insert / delete so the grid reflects
      // what's actually in the DB (esp. auto-generated PKs after INSERT).
      void onRun(state.sql);
    });
    if (!cfg) return undefined;
    return {
      ...cfg,
      onNavigateFk: (target: {
        schema: string;
        table: string;
        column: string;
        value: unknown;
      }) => {
        // Build a filtered SELECT against the referenced table and open
        // it in a fresh tab — auto-runs so the user sees the related rows
        // immediately without an extra click.
        const sql = buildFilteredSelectSql(
          profile.engine,
          target.schema,
          target.table,
          target.column,
          target.value,
        );
        loadSqlInWorkspace(router, profile, sql, true);
      },
    };
  })();

  // ---- run --------------------------------------------------------------

  /** Run the user's query wrapped with EXPLAIN (ANALYZE, ...) and route the
   *  result to the Plan tab. The plan tab is per-tab, mirroring `runByTab`,
   *  so each editor tab keeps its last plan independent of others. We do
   *  not write history entries here — EXPLAIN runs are diagnostic, the
   *  history panel is for queries the user actually meant to issue. */
  const onExplain = async () => {
    if (!profile) return;
    if (!explainSupportedFor(profile.engine)) return;
    const tabId = useSqlTabs.getState().byConnection[profile.id]?.activeId;
    if (!tabId) return;
    const sql = useSqlTabs
      .getState()
      .byConnection[profile.id]?.tabs.find((t) => t.id === tabId)?.sql;
    if (!sql?.trim()) return;
    const wrapped = buildExplainSql(profile.engine, sql);
    if (!wrapped) return;
    setPlanByTab((m) => ({ ...m, [tabId]: { kind: 'running' } }));
    setBottomTab('plan');
    try {
      const result = await api.runQuery(profile, { sql: wrapped });
      setPlanByTab((m) => ({ ...m, [tabId]: { kind: 'ok', result } }));
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setPlanByTab((m) => ({
        ...m,
        [tabId]: {
          kind: 'error',
          code: err.code ?? 'unknown',
          message: err.message ?? String(e),
        },
      }));
    }
  };

  const onRun = async (sqlToRun: string) => {
    if (!profile) return;
    // Read the active tab from the store, not the closure — when this is
    // called via setTimeout after `loadIntoNewTab`, the React render that
    // would update our captured `activeTab` hasn't committed yet, so the
    // closure still points at the previously-active tab. The store has
    // the freshly-set active id immediately.
    const tabId = useSqlTabs.getState().byConnection[profile.id]?.activeId;
    if (!tabId) return;
    // Mint a fresh uuid per Run. The driver registers the backend PID /
    // connection id against this token while the query is in flight; the
    // Stop button reads it from `RunState` to issue the cancel.
    const queryId = crypto.randomUUID();
    setRunByTab((m) => ({ ...m, [tabId]: { kind: 'running', queryId } }));
    setBottomTab('results');
    const startedAt = performance.now();
    try {
      const result = await api.runQuery(profile, {
        sql: sqlToRun,
        query_id: queryId,
      });
      const elapsedMs = Math.round(performance.now() - startedAt);
      setRunByTab((m) => ({ ...m, [tabId]: { kind: 'ok', result, sql: sqlToRun } }));
      // Snapshot the executed SQL on the tab so the TabBar can compare
      // against the live buffer and show the dirty dot when it diverges.
      markRan(profile.id, tabId, sqlToRun);
      recordHistory({
        connectionId: profile.id,
        sql: sqlToRun,
        elapsedMs: result.elapsed_ms || elapsedMs,
        status: 'ok',
        rowsReturned: result.rows.length,
        rowsAffected: result.rows_affected ?? undefined,
        truncated: result.truncated,
      });
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      const elapsedMs = Math.round(performance.now() - startedAt);
      const code = err.code ?? 'unknown';
      const message = err.message ?? String(e);
      setRunByTab((m) => ({ ...m, [tabId]: { kind: 'error', code, message } }));
      // Don't pollute history with user-initiated cancels — the entry
      // would otherwise show up as a red "error" row for an event the
      // user already knows they triggered.
      if (code !== 'query_cancelled') {
        recordHistory({
          connectionId: profile.id,
          sql: sqlToRun,
          elapsedMs,
          status: 'error',
          errorCode: code,
          errorMessage: message,
        });
      }
    }
  };

  // Re-apply the row-limit selector to whatever table tab is in
  // focus. The user's mental model is "limit is a knob on the table
  // I'm viewing" — change it, visible result updates. We track the
  // previous rowLimit via a ref so the effect skips the initial
  // mount (which would otherwise pile a second query on top of the
  // schema load + initial table open and contribute to MySQL's
  // [08004] too many connections under stress). Subsequent
  // user-driven limit changes still fire normally.
  const rowLimit = useGridPrefs((s) => s.rowLimit);
  const prevRowLimitRef = useRef(rowLimit);
  useEffect(() => {
    if (!profile) return;
    if (prevRowLimitRef.current === rowLimit) return;
    prevRowLimitRef.current = rowLimit;
    const cur = useSqlTabs.getState().byConnection[profile.id];
    const active = cur?.tabs.find((t) => t.id === cur.activeId);
    if (!active?.tableRef) return;
    const nextSql = buildSelectStarSql(
      profile.engine,
      active.tableRef.schema,
      active.tableRef.table,
      rowLimit,
    );
    if (nextSql === active.sql) return;
    setSql(profile.id, active.id, nextSql);
    setTimeout(() => void onRun(nextSql), 0);
    // Watching rowLimit + profile.id. The ref above gates against
    // the on-mount fire; the connection-switch case is benign
    // because the new connection's active tab has its own SQL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowLimit, profile?.id]);

  const [reconnecting, setReconnecting] = useState(false);

  /** Drop the cached pool + SSH tunnel for this connection, then reopen
   *  by re-running the active tab. Used when the user hits a stale-
   *  connection EOF or wants a clean slate after a network change.
   *  Mirrors the Reconnect button on the schema page so the action is
   *  available from wherever the user is working. */
  const onReconnect = async () => {
    if (!profile) return;
    setReconnecting(true);
    try {
      await api.reconnect(profile);
      // We DON'T force-reload the schema here. An earlier attempt
      // did, but doing the getSchema synchronously after a pool
      // reset (a) competes with the freshly-running query below
      // for the still-spinning-up pool slots, and (b) on MySQL
      // servers with a low `max_connections` it stacks alongside
      // the not-yet-fully-dropped previous pool and trips
      // [08004] too many connections. Invalidate the cache instead
      // and let the next consumer (autocomplete focus, sidebar
      // remount, schema page nav) lazy-fetch when there's no
      // contention.
      useSchemaCache.getState().invalidate(profile.id);
    } catch {
      // disconnect errors are non-fatal — we still want to re-run.
    } finally {
      setReconnecting(false);
    }
    // If the active tab has any SQL, re-run it now that the pool is
    // fresh. Empty tabs just stay where they are.
    const tabId = useSqlTabs.getState().byConnection[profile.id]?.activeId;
    const sql = tabId
      ? useSqlTabs
          .getState()
          .byConnection[profile.id]?.tabs.find((t) => t.id === tabId)?.sql
      : undefined;
    if (sql?.trim()) {
      void onRun(sql);
    }
  };

  /** Signal the server to abort the active tab's running query. The Run
   *  promise will reject with `query_cancelled` when the engine
   *  acknowledges; we don't optimistically clear the running state here
   *  because the cancel can still race with the query completing. */
  const onStop = async () => {
    if (!profile) return;
    const tabId = useSqlTabs.getState().byConnection[profile.id]?.activeId;
    if (!tabId) return;
    const current = runByTab[tabId];
    if (current?.kind !== 'running') return;
    try {
      await api.cancelQuery(profile, current.queryId);
    } catch {
      // Best-effort — the original Run will surface any real failure.
    }
  };

  if (!profile) {
    return (
      <AppShell>
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-muted-foreground">Connection not found.</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b px-5 py-2.5">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold truncate">{profile.name}</h1>
            <p className="text-[11px] text-muted-foreground">
              {ENGINE_LABELS[profile.engine]} · SQL workspace ·{' '}
              <kbd className="rounded border px-1 text-[10px]">Cmd</kbd>+
              <kbd className="rounded border px-1 text-[10px]">T</kbd> new tab
            </p>
          </div>
          <div className="flex items-center gap-2">
            <RowLimitSelect />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onReconnect()}
              disabled={reconnecting || state.kind === 'running'}
              title="Drop the pool + SSH tunnel and rerun"
            >
              {reconnecting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plug className="h-3 w-3" />
              )}
              Reconnect
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => editorRef.current?.format()}
              disabled={!activeTab?.sql.trim()}
              title="Format SQL (Cmd/Ctrl+Shift+F)"
            >
              <Wand2 className="h-3 w-3" />
              Format
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSaveSnippetOpen(true)}
              disabled={!activeTab?.sql.trim()}
              title="Save this query as a snippet"
            >
              <Bookmark className="h-3 w-3" />
              Save
            </Button>
            {canExplain && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onExplain()}
                disabled={
                  planState.kind === 'running' || !activeTab?.sql.trim()
                }
                title="Run EXPLAIN ANALYZE on this query"
              >
                {planState.kind === 'running' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Activity className="h-3 w-3" />
                )}
                Explain
              </Button>
            )}
            {state.kind === 'running' ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void onStop()}
                title="Cancel the running query"
              >
                <Square className="h-3 w-3" />
                Stop
              </Button>
            ) : (
              <Button size="sm" onClick={() => editorRef.current?.run()}>
                <Play className="h-3 w-3" />
                Run
              </Button>
            )}
          </div>
        </header>

        <TabBar
          tabs={slot?.tabs ?? []}
          activeId={slot?.activeId ?? null}
          onSelect={(tid) => setActive(profile.id, tid)}
          onClose={(tid) => {
            closeTab(profile.id, tid);
            setRunByTab(({ [tid]: _, ...rest }) => rest);
            setPlanByTab(({ [tid]: _, ...rest }) => rest);
          }}
          onNew={() => newTab(profile.id, '')}
        />

        <ResizablePanelGroup
          direction="vertical"
          autoSaveId="dbstudio.sql-split"
          className="flex-1"
        >
          <ResizablePanel defaultSize={55} minSize={15}>
            <div className="h-full overflow-hidden">
              <SqlEditor
                ref={editorRef}
                // The key forces Monaco to reset its internal model when the
                // active tab changes — otherwise undo history bleeds across
                // tabs, and the cursor jumps to wherever it was in the
                // previous tab's content of the same length.
                key={activeTab?.id ?? 'empty'}
                value={activeTab?.sql ?? ''}
                onChange={(next) => {
                  if (activeTab) setSql(profile.id, activeTab.id, next);
                }}
                onRun={onRun}
                schema={schema}
                engine={profile.engine}
                defaultSchema={defaultSchemaFor(profile)}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={45} minSize={15}>
            <Tabs
              value={bottomTab}
              onValueChange={(v) => setBottomTab(v as BottomTab)}
              className="flex h-full flex-col"
            >
              <TabsList className="m-2 mb-0 h-8 self-start">
                <TabsTrigger value="results" className="gap-1.5">
                  <Table2 className="h-3 w-3" />
                  Results
                </TabsTrigger>
                {canExplain && (
                  <TabsTrigger value="plan" className="gap-1.5">
                    <Activity className="h-3 w-3" />
                    Plan
                  </TabsTrigger>
                )}
              </TabsList>
              <TabsContent value="results" className="mt-0 flex-1 overflow-hidden">
                {state.kind === 'idle' && (
                  <p className="p-4 text-xs text-muted-foreground">
                    Run a query to see results here.
                  </p>
                )}
                {state.kind === 'running' && (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    Running... click Stop to cancel.
                  </div>
                )}
                {state.kind === 'error' &&
                  (state.code === 'query_cancelled' ? (
                    // User-initiated abort — render in muted tones rather
                    // than the red "Query failed" treatment we use for
                    // real errors. This is the success outcome of Stop.
                    <div className="p-5">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Ban className="h-4 w-4" />
                        <span className="text-sm font-semibold">Query cancelled</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        The server acknowledged the cancel and aborted the
                        running statement.
                      </p>
                    </div>
                  ) : (
                    <div className="p-5">
                      <div className="flex items-center gap-2 text-destructive">
                        <AlertCircle className="h-4 w-4" />
                        <span className="text-sm font-semibold">Query failed</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        <span className="font-mono">{state.code}</span> ·{' '}
                        {state.message}
                      </p>
                      {(() => {
                        const hint = suggestHint(schema, state.code, state.message);
                        if (!hint) return null;
                        return (
                          <p className="mt-2 text-xs text-muted-foreground">
                            Did you mean{' '}
                            {hint.suggestions.map((s, i) => (
                              <span key={s}>
                                {i > 0 && (i === hint.suggestions.length - 1 ? ' or ' : ', ')}
                                <code className="font-mono text-foreground">{s}</code>
                              </span>
                            ))}
                            ?
                          </p>
                        );
                      })()}
                    </div>
                  ))}
                {state.kind === 'ok' && (
                  <ResultTable
                    result={state.result}
                    editable={editable}
                    engine={profile.engine}
                  />
                )}
              </TabsContent>
              {canExplain && (
                <TabsContent value="plan" className="mt-0 flex-1 overflow-hidden">
                  {planState.kind === 'idle' && (
                    <p className="p-4 text-xs text-muted-foreground">
                      Click Explain to run EXPLAIN ANALYZE on the active query
                      and see the plan tree here.
                    </p>
                  )}
                  {planState.kind === 'running' && (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      Running EXPLAIN...
                    </div>
                  )}
                  {planState.kind === 'error' && (
                    <div className="p-5">
                      <div className="flex items-center gap-2 text-destructive">
                        <AlertCircle className="h-4 w-4" />
                        <span className="text-sm font-semibold">
                          EXPLAIN failed
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        <span className="font-mono">{planState.code}</span> ·{' '}
                        {planState.message}
                      </p>
                    </div>
                  )}
                  {planState.kind === 'ok' && (
                    <PlanViewer
                      result={planState.result}
                      engine={profile.engine}
                    />
                  )}
                </TabsContent>
              )}
            </Tabs>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <SaveSnippetDialog
        open={saveSnippetOpen}
        initialName={activeTab?.title ?? ''}
        onCancel={() => setSaveSnippetOpen(false)}
        onSave={(name) => {
          if (!activeTab) return;
          createSnippet(profile.id, name, activeTab.sql);
          setSaveSnippetOpen(false);
        }}
      />
    </AppShell>
  );
}

function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
}: {
  tabs: {
    id: string;
    title: string;
    sql: string;
    lastRunSql?: string;
    tableRef?: { schema: string; table: string };
  }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b bg-muted/30 px-2">
      <div className="scrollbar-thin flex flex-1 overflow-x-auto">
        {tabs.map((tab, i) => {
          const active = tab.id === activeId;
          // A tab is dirty when the buffer has non-empty text and either
          // hasn't been run yet (`lastRunSql` undefined) or has been
          // edited since the last successful run. We trim before
          // comparing so whitespace-only edits don't trip it.
          const trimmedSql = tab.sql.trim();
          const dirty =
            trimmedSql.length > 0 &&
            (tab.lastRunSql == null || tab.lastRunSql.trim() !== trimmedSql);
          const isTable = Boolean(tab.tableRef);
          return (
            <div
              key={tab.id}
              className={cn(
                'group flex shrink-0 cursor-pointer items-center gap-1.5 border-r px-3 py-1.5 text-[11px]',
                // Table tabs are visually a different *kind* of tab —
                // they're tied to a single underlying table and the
                // SELECT in the buffer is generated, not authored.
                // Use a distinct accent surface (sky tint), monospace
                // title, and a prominent leading badge so the user
                // can tell at a glance which kind of tab they have
                // focused without inspecting the SQL.
                isTable && [
                  'border-l-2 border-l-sky-500',
                  active
                    ? 'bg-sky-50 text-foreground dark:bg-sky-950/40'
                    : 'bg-sky-50/40 text-muted-foreground hover:bg-sky-100 dark:bg-sky-950/20 dark:hover:bg-sky-900/40',
                ],
                !isTable && [
                  active
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                ],
              )}
              onClick={() => onSelect(tab.id)}
              onAuxClick={(e) => {
                // Middle-click closes — common terminal-emulator convention.
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              title={
                `${tab.title}\nCmd+${i + 1} to switch` +
                (isTable ? '\nTable browse tab' : '') +
                (dirty ? '\nUnrun changes in this tab' : '')
              }
            >
              {isTable ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded bg-sky-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-300"
                  aria-label="Table browse tab"
                >
                  <Table2 className="h-2.5 w-2.5" />
                  TABLE
                </span>
              ) : null}
              {dirty && (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                  aria-label="Tab has unrun changes"
                />
              )}
              <span
                className={cn(
                  'max-w-[180px] truncate',
                  isTable && 'font-mono',
                )}
              >
                {tab.title || 'Untitled'}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className={cn(
                  'rounded p-0.5 opacity-0 transition-opacity hover:bg-background hover:text-destructive',
                  active && 'opacity-60',
                  'group-hover:opacity-100',
                )}
                aria-label={`Close ${tab.title}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onNew}
        className="ml-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="New tab (Cmd+T)"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Top-toolbar selector that controls the default LIMIT applied when
 * the user opens a table by clicking it (sidebar, ER diagram, FK
 * jump). Persisted globally via gridPrefs so the choice survives
 * across connections and reloads. `null` is the "All" option — no
 * LIMIT clause is emitted at all.
 */
function RowLimitSelect() {
  const rowLimit = useGridPrefs((s) => s.rowLimit);
  const setRowLimit = useGridPrefs((s) => s.setRowLimit);
  const current = rowLimit == null ? 'all' : String(rowLimit);
  return (
    <label
      className="flex items-center gap-1 text-[11px] text-muted-foreground"
      title="Default row limit when opening a table from the sidebar"
    >
      <span>Limit</span>
      <select
        value={current}
        onChange={(e) => {
          const v = e.target.value;
          setRowLimit(v === 'all' ? null : Number(v));
        }}
        className="h-7 rounded border border-input bg-background px-1.5 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {ROW_LIMIT_OPTIONS.map((opt) => (
          <option key={String(opt.value)} value={opt.value == null ? 'all' : String(opt.value)}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// Static export requires useSearchParams() to be inside a Suspense
// boundary so Next can split the client-bailout point. The inner
// component does the real work; this wrapper exists only to satisfy
// the build constraint.
export default function SqlPage() {
  return (
    <Suspense fallback={null}>
      <SqlPageInner />
    </Suspense>
  );
}

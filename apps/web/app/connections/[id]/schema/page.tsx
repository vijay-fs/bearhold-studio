'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, AlertCircle, RefreshCw, Plug } from 'lucide-react';

import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { useConnections } from '@/store/connections';
import { useSchemaCache } from '@/store/schemaCache';
import { ENGINE_LABELS } from '@/lib/types';
import { ERDiagram, type Schema } from '@dbstudio/erd';
import { api } from '@/lib/api';
import { openTableInSql } from '@/lib/openTable';
import { TableDetailsDrawer } from '@/components/TableDetailsDrawer';

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; schema: Schema }
  | { kind: 'error'; code: string; message: string };

export default function SchemaPage(props: { params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const profile = useConnections((s) => s.profiles.find((p) => p.id === id));
  const router = useRouter();
  const loadSchema = useSchemaCache((s) => s.load);
  const invalidateSchema = useSchemaCache((s) => s.invalidate);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  // Selected table for the right-side details drawer. Clicking a node sets
  // this; the drawer renders unconditionally and just shows/hides on null.
  const [selectedTable, setSelectedTable] = useState<
    { schema: string; table: string } | null
  >(null);

  const load = async (force = false) => {
    if (!profile) return;
    setState({ kind: 'loading' });
    if (force) invalidateSchema(profile.id);
    try {
      const schema = await loadSchema(profile, force);
      setState({ kind: 'ok', schema });
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setState({
        kind: 'error',
        code: err.code ?? 'unknown',
        message: err.message ?? String(e),
      });
    }
  };

  // Drop the cached pool + SSH tunnel on the backend, then retry the load.
  // Used when the user hits a stale-connection EOF.
  const reconnectAndLoad = async () => {
    if (!profile) return;
    setState({ kind: 'loading' });
    try {
      await api.reconnect(profile);
    } catch {
      // disconnect errors are non-fatal — we still want to retry the load.
    }
    invalidateSchema(profile.id);
    await load(true);
  };

  // Clicking a node opens the details drawer rather than jumping straight
  // into the SQL workspace. The drawer's footer still exposes "Open in SQL"
  // for the previous behaviour when the user has confirmed the table is
  // the one they want.
  const onTableClick = (schemaName: string, tableName: string) => {
    setSelectedTable({ schema: schemaName, table: tableName });
  };

  const openSelectionInSql = (schemaName: string, tableName: string) => {
    if (!profile) return;
    openTableInSql(router, profile, schemaName, tableName);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
          <div>
            <h1 className="text-sm font-semibold">{profile.name}</h1>
            <p className="text-[11px] text-muted-foreground">
              {ENGINE_LABELS[profile.engine]} · {profile.host}:{profile.port}/{profile.database}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={reconnectAndLoad}
              disabled={state.kind === 'loading'}
              title="Drop the pool + SSH tunnel and start over"
            >
              <Plug className="h-3 w-3" />
              Reconnect
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => load(true)}
              disabled={state.kind === 'loading'}
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </Button>
          </div>
        </header>

        <div className="relative flex-1 overflow-hidden">
          {state.kind === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/60">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading schema...
              </div>
            </div>
          )}
          {state.kind === 'error' && (
            <div className="absolute inset-0 flex items-center justify-center px-6">
              <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-5">
                <AlertCircle className="h-5 w-5 text-destructive" />
                <h2 className="mt-3 text-sm font-semibold text-destructive">
                  Could not load schema
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  <span className="font-mono">{state.code}</span> · {state.message}
                </p>
                {looksLikeStaleConnection(state.code, state.message) && (
                  <div className="mt-4 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      The cached connection looks dead — the SSH tunnel or database
                      socket likely got closed. Reopen and retry.
                    </p>
                    <Button size="sm" onClick={reconnectAndLoad}>
                      <Plug className="h-3 w-3" />
                      Reconnect and retry
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
          {state.kind === 'ok' && (
            <ERDiagram schema={state.schema} onTableClick={onTableClick} />
          )}
        </div>

        {state.kind === 'ok' && (
          <TableDetailsDrawer
            schema={state.schema}
            selection={selectedTable}
            onClose={() => setSelectedTable(null)}
            onOpenInSql={openSelectionInSql}
          />
        )}
      </div>
    </AppShell>
  );
}

function looksLikeStaleConnection(code: string, message: string): boolean {
  if (code === 'io_error' || code === 'ssh_tunnel_error' || code === 'connection_failed') {
    return true;
  }
  const m = message.toLowerCase();
  return (
    m.includes('eof') ||
    m.includes('broken pipe') ||
    m.includes('connection reset') ||
    m.includes('got 0 bytes')
  );
}

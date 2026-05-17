'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw, Database } from 'lucide-react';

import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { ResultTable, type EditableConfig } from '@/components/ResultTable';
import { useConnections } from '@/store/connections';
import { useSchemaCache } from '@/store/schemaCache';
import { api } from '@/lib/api';
import { ENGINE_LABELS, type QueryResult } from '@/lib/types';

const DEFAULT_ROW_LIMIT = 1000;

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; result: QueryResult; editable: EditableConfig }
  | { kind: 'error'; code: string; message: string };

export default function TableBrowserPage(props: {
  params: Promise<{ id: string; schema: string; table: string }>;
}) {
  const { id, schema: schemaParam, table: tableParam } = use(props.params);
  const schemaName = decodeURIComponent(schemaParam);
  const tableName = decodeURIComponent(tableParam);

  const profile = useConnections((s) => s.profiles.find((p) => p.id === id));
  const loadSchema = useSchemaCache((s) => s.load);

  const [state, setState] = useState<LoadState>({ kind: 'idle' });

  const load = useCallback(async () => {
    if (!profile) return;
    setState({ kind: 'loading' });
    try {
      // Pull the schema first (cached) so we know the PK columns.
      const cachedSchema = await loadSchema(profile);
      const ns = cachedSchema.schemas.find((s) => s.name === schemaName);
      const tbl = ns?.tables.find((t) => t.name === tableName);
      if (!tbl) {
        throw {
          code: 'not_found',
          message: `Table "${schemaName}"."${tableName}" not found in schema`,
        };
      }
      const pkColumns = tbl.primary_key?.columns ?? [];

      const sql = buildSelectSql(profile.engine, schemaName, tableName, DEFAULT_ROW_LIMIT);
      const result = await api.runQuery(profile, { sql, limit: DEFAULT_ROW_LIMIT });
      setState({
        kind: 'ok',
        result,
        editable: {
          profile,
          schema: schemaName,
          table: tableName,
          pkColumns,
          tableColumns: tbl.columns,
          onChanged: () => {
            // Refetch after insert/delete so the local rows reflect what's
            // actually in the database (especially needed for INSERT — we
            // don't know the auto-generated PK value otherwise).
            void load();
          },
        },
      });
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setState({
        kind: 'error',
        code: err.code ?? 'unknown',
        message: err.message ?? String(e),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, schemaName, tableName]);

  useEffect(() => {
    void load();
  }, [load]);

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
            <h1 className="flex items-center gap-2 text-sm font-semibold">
              <Database className="h-3.5 w-3.5 text-primary" />
              <span className="truncate">
                {schemaName ? `${schemaName}.` : ''}
                {tableName}
              </span>
            </h1>
            <p className="text-[11px] text-muted-foreground">
              {ENGINE_LABELS[profile.engine]} · {profile.name} · first{' '}
              {DEFAULT_ROW_LIMIT.toLocaleString()} rows
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={state.kind === 'loading'}>
            <RefreshCw className="h-3 w-3" />
            Reload
          </Button>
        </header>

        <div className="relative flex-1 overflow-hidden">
          {state.kind === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/60">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading rows...
              </div>
            </div>
          )}
          {state.kind === 'error' && (
            <div className="absolute inset-0 flex items-center justify-center px-6">
              <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-5">
                <AlertCircle className="h-5 w-5 text-destructive" />
                <h2 className="mt-3 text-sm font-semibold text-destructive">
                  Could not load table
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  <span className="font-mono">{state.code}</span> · {state.message}
                </p>
              </div>
            </div>
          )}
          {state.kind === 'ok' && (
            <ResultTable result={state.result} editable={state.editable} />
          )}
        </div>
      </div>
    </AppShell>
  );
}

function buildSelectSql(
  engine: string,
  schema: string,
  table: string,
  limit: number,
): string {
  // MySQL uses backticks; Postgres/SQLite use double-quotes. We always emit
  // a qualified name when a schema is present except in SQLite where there
  // is no schema concept (every table lives in `main`).
  if (engine === 'mysql' || engine === 'mariadb') {
    const tbl = schema && schema !== ''
      ? `\`${schema.replace(/`/g, '``')}\`.\`${table.replace(/`/g, '``')}\``
      : `\`${table.replace(/`/g, '``')}\``;
    return `SELECT * FROM ${tbl} LIMIT ${limit}`;
  }
  if (engine === 'sqlite') {
    return `SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT ${limit}`;
  }
  // Postgres + CockroachDB
  const tbl = schema
    ? `"${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`
    : `"${table.replace(/"/g, '""')}"`;
  return `SELECT * FROM ${tbl} LIMIT ${limit}`;
}

'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import dynamic from 'next/dynamic';
import type { editor } from 'monaco-editor';

import type { Schema } from '@dbstudio/erd';
import type { DatabaseEngine } from '@/lib/types';
import { registerSqlCompletion } from '@/lib/sqlCompletion';

// Monaco is large (~3 MB) and cannot SSR. Load it client-side only.
const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      Loading editor...
    </div>
  ),
});

export interface SqlEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Called with the SQL to run — selection if any, otherwise full buffer. */
  onRun?: (sql: string) => void;
  /** When provided, drives schema-aware autocomplete (tables, columns). */
  schema?: Schema | null;
  /** Drives identifier quoting in autocomplete: backticks for MySQL/MariaDB,
   *  ANSI double-quotes for everything else. */
  engine?: DatabaseEngine | null;
  /** Schema/database that doesn't need qualification — tables outside it
   *  get suggested as `schema.table` to avoid "relation does not exist"
   *  errors. `public` for PG, `main` for SQLite, the active DB for MySQL. */
  defaultSchema?: string | null;
  height?: string | number;
}

export interface SqlEditorHandle {
  /** Run the current selection, or the full buffer if nothing is selected. */
  run: () => void;
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  {
    value,
    onChange,
    onRun,
    schema = null,
    engine = null,
    defaultSchema = null,
    height = '100%',
  },
  ref,
) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  // Completion-provider lifetime is tied to this editor instance. We
  // intentionally don't use a module-level singleton — that survives HMR
  // and React Strict Mode's double-mount with stale registrations, which
  // ends up firing two providers (old + new) and emitting duplicate /
  // wrongly-quoted suggestions. Per-instance registration with explicit
  // cleanup behaves correctly through all of those cycles.
  const completionRef = useRef<ReturnType<typeof registerSqlCompletion> | null>(null);

  // Keep the latest onRun reachable from Monaco's stable command closure.
  const onRunRef = useRef(onRun);
  useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);

  // Push schema/engine/defaultSchema updates into the live provider.
  useEffect(() => {
    completionRef.current?.setSchema(schema);
  }, [schema]);
  useEffect(() => {
    completionRef.current?.setEngine(engine);
  }, [engine]);
  useEffect(() => {
    completionRef.current?.setDefaultSchema(defaultSchema);
  }, [defaultSchema]);

  // Dispose the provider when this editor unmounts. Crucial under StrictMode
  // and HMR where the same component instance can be torn down + remounted.
  useEffect(() => {
    return () => {
      completionRef.current?.dispose();
      completionRef.current = null;
    };
  }, []);

  const runActive = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const selection = ed.getSelection();
    const selected =
      selection && !selection.isEmpty()
        ? ed.getModel()?.getValueInRange(selection)?.trim()
        : '';
    const sql = selected && selected.length > 0 ? selected : ed.getValue();
    onRunRef.current?.(sql);
  }, []);

  useImperativeHandle(ref, () => ({ run: runActive }), [runActive]);

  return (
    <MonacoEditor
      height={height}
      defaultLanguage="sql"
      value={value}
      onChange={(next) => onChange(next ?? '')}
      theme="vs"
      options={{
        fontSize: 13,
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
        minimap: { enabled: false },
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        renderLineHighlight: 'gutter',
        tabSize: 2,
        automaticLayout: true,
        padding: { top: 12, bottom: 12 },
        quickSuggestions: { other: true, comments: false, strings: false },
        suggestOnTriggerCharacters: true,
        wordBasedSuggestions: 'off',
      }}
      onMount={(ed, monaco) => {
        editorRef.current = ed;
        ed.addAction({
          id: 'dbstudio.run-query',
          label: 'Run query (selection or whole buffer)',
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
          contextMenuGroupId: 'navigation',
          contextMenuOrder: 1,
          run: () => runActive(),
        });
        // Defensive: if a previous registration leaked (shouldn't happen
        // with the unmount cleanup above, but HMR is finicky), drop it
        // before installing the new one.
        completionRef.current?.dispose();
        completionRef.current = registerSqlCompletion(monaco, schema, engine, defaultSchema);
      }}
    />
  );
});

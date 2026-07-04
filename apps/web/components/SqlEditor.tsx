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
import { formatSql } from '@/lib/formatSql';
import { useTheme } from '@/lib/theme';

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
  /** Drives identifier quoting in autocomplete: backticks for MySQL,
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
  /** Pretty-print the current selection, or the full buffer if nothing is
   *  selected. Engine-aware (PG / MySQL / SQLite dialects). The
   *  edit goes through Monaco so undo (`Cmd+Z`) reverses it cleanly. */
  format: () => void;
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
  const theme = useTheme();
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

  // `engine` is captured by `formatActive`. Stash it in a ref so the Monaco
  // command handler (registered exactly once in onMount) always sees the
  // current engine when the connection swaps without us having to rebind.
  const engineRef = useRef(engine);
  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

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

  /** Format the current selection (if any) or the whole buffer. Goes
   *  through `executeEdits` so it lands in the undo stack and the cursor
   *  stays anchored at the edit site. */
  const formatActive = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const model = ed.getModel();
    if (!model) return;
    const eng = engineRef.current;
    const selection = ed.getSelection();
    if (selection && !selection.isEmpty()) {
      const original = model.getValueInRange(selection);
      const formatted = formatSql(original, eng);
      if (formatted === original) return;
      ed.executeEdits('dbstudio.format', [
        { range: selection, text: formatted, forceMoveMarkers: true },
      ]);
    } else {
      const original = model.getValue();
      const formatted = formatSql(original, eng);
      if (formatted === original) return;
      ed.executeEdits('dbstudio.format', [
        { range: model.getFullModelRange(), text: formatted, forceMoveMarkers: true },
      ]);
    }
    ed.focus();
  }, []);

  useImperativeHandle(
    ref,
    () => ({ run: runActive, format: formatActive }),
    [runActive, formatActive],
  );

  return (
    <MonacoEditor
      height={height}
      defaultLanguage="sql"
      value={value}
      onChange={(next) => onChange(next ?? '')}
      theme={theme === 'dark' ? 'vs-dark' : 'vs'}
      options={{
        fontSize: 12,
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
        // Enter is always a newline. The previous default ('on')
        // accepted the highlighted suggestion when the popup was
        // visible — and the popup was visible most of the time —
        // so pressing Enter to move down a line would silently
        // insert a duplicate identifier instead. Tab accepts the
        // suggestion; that's the unambiguous gesture.
        // acceptSuggestionOnEnter: 'off',
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
        ed.addAction({
          id: 'dbstudio.format-sql',
          label: 'Format SQL',
          keybindings: [
            monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
          ],
          contextMenuGroupId: 'navigation',
          contextMenuOrder: 2,
          run: () => formatActive(),
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

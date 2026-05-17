// Monaco completion provider for the SQL editor. Fed by the introspected
// Schema, it suggests:
//   - all tables (qualified when ambiguous across schemas)
//   - all columns (table-scoped when the user typed `<table>.`)
//   - common SQL keywords (so we don't lose the dumb-but-useful baseline)
//
// Smart enough to handle the two most common cases — `table.<cursor>` and
// "anywhere else" — without trying to parse the full SQL AST. A real parser
// (sql-parser-cst, libpg_query) would do better but adds 200KB+ to the bundle.

import type { editor, languages, IRange } from 'monaco-editor';
import type { Schema } from '@dbstudio/erd';
import type { DatabaseEngine } from './types';

/** Identifier-quoting style used by the suggestion's `insertText`. MySQL and
 *  MariaDB need backticks; everything else uses ANSI double-quotes. The
 *  user's typing style isn't enough to infer this reliably — we drive it
 *  off the active profile's engine instead. */
type QuoteStyle = 'ansi' | 'backtick';

function quoteStyleFor(engine: DatabaseEngine | null): QuoteStyle {
  return engine === 'mysql' || engine === 'mariadb' ? 'backtick' : 'ansi';
}

function quote(name: string, style: QuoteStyle): string {
  if (style === 'backtick') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

// Subset of ANSI/PG/MySQL/SQLite keywords. Lowercased; we uppercase on emit
// so the suggestions feel familiar regardless of the user's typing style.
const KEYWORDS = [
  'select', 'from', 'where', 'group', 'by', 'order', 'limit', 'offset',
  'having', 'distinct', 'with', 'as', 'on', 'using',
  'join', 'inner', 'left', 'right', 'outer', 'full', 'cross', 'lateral',
  'and', 'or', 'not', 'in', 'between', 'like', 'ilike', 'is', 'null',
  'asc', 'desc', 'nulls', 'first', 'last',
  'insert', 'into', 'values', 'update', 'set', 'delete',
  'create', 'table', 'view', 'index', 'unique', 'primary', 'foreign', 'key',
  'references', 'alter', 'add', 'drop', 'column', 'constraint', 'check',
  'cast', 'case', 'when', 'then', 'else', 'end',
  'union', 'all', 'except', 'intersect',
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'now',
  'true', 'false',
  'explain', 'analyze', 'show', 'describe',
];

type MonacoNS = typeof import('monaco-editor');

interface ProviderState {
  schema: Schema | null;
  engine: DatabaseEngine | null;
  /** Name of the schema that doesn't need qualification in unqualified
   *  references (`public` for PG, `main` for SQLite, active database for
   *  MySQL). Tables outside this schema are suggested *only* in their
   *  qualified `schema.table` form — otherwise the user accepts the bare
   *  name, the server can't resolve it, and the query fails with
   *  "relation does not exist". */
  defaultSchema: string | null;
}

/**
 * Register a SQL completion provider once. The returned setters let the
 * caller swap state as the active connection changes without re-registering
 * — Monaco's API expects exactly one disposable per provider, and
 * re-registering produces duplicate suggestions.
 */
export function registerSqlCompletion(
  monaco: MonacoNS,
  initialSchema: Schema | null,
  initialEngine: DatabaseEngine | null = null,
  initialDefaultSchema: string | null = null,
): {
  setSchema: (next: Schema | null) => void;
  setEngine: (next: DatabaseEngine | null) => void;
  setDefaultSchema: (next: string | null) => void;
  dispose: () => void;
} {
  const state: ProviderState = {
    schema: initialSchema,
    engine: initialEngine,
    defaultSchema: initialDefaultSchema,
  };

  const disposable = monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' ', '\t', '\n', ',', '('],

    provideCompletionItems: (model, position) => {
      const lineUntil = model
        .getLineContent(position.lineNumber)
        .slice(0, position.column - 1);
      const word = model.getWordUntilPosition(position);
      const range: IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const qStyle = quoteStyleFor(state.engine);

      // Detect `<ident>.` immediately before the cursor — that means the
      // user is qualifying a column reference. Suggest only columns of that
      // table (or, if the prefix matches a schema, that schema's tables).
      const dotMatch = /([a-zA-Z_][\w]*)\.\s*$/.exec(lineUntil + word.word);
      // ^ include word.word so we also fire mid-typing of `mytable.fo|`
      if (dotMatch) {
        const prefix = dotMatch[1] ?? '';
        const cols = columnsForTable(state.schema, prefix);
        if (cols.length > 0) {
          return {
            suggestions: cols.map((c) => columnSuggestion(monaco, c, range, qStyle)),
          };
        }
        const tables = tablesInSchema(state.schema, prefix);
        if (tables.length > 0) {
          return {
            suggestions: tables.map((t) =>
              tableSuggestion(monaco, t, range, /*qualified*/ false, qStyle),
            ),
          };
        }
        // Fall through to general suggestions if the prefix wasn't a table.
      }

      const suggestions: languages.CompletionItem[] = [];

      // One suggestion per table. Tables in the default schema get the bare
      // `"table"` insertText; everything else gets `"schema"."table"`. The
      // display label stays bare in both cases so fuzzy match keeps working
      // on the table name; the `detail` row shows the schema.
      for (const t of allTables(state.schema)) {
        const qualify = needsQualification(state.defaultSchema, t.schema);
        suggestions.push(tableSuggestion(monaco, t, range, qualify, qStyle));
      }

      // Columns from every table (suffixed with table name in `detail`).
      for (const col of allColumns(state.schema)) {
        suggestions.push(columnSuggestion(monaco, col, range, qStyle));
      }

      // Keywords.
      for (const kw of KEYWORDS) {
        suggestions.push({
          label: kw.toUpperCase(),
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: kw.toUpperCase(),
          range,
        });
      }

      return { suggestions };
    },
  });

  return {
    setSchema: (next) => {
      state.schema = next;
    },
    setEngine: (next) => {
      state.engine = next;
    },
    setDefaultSchema: (next) => {
      state.defaultSchema = next;
    },
    dispose: () => disposable.dispose(),
  };
}

/** True when the table's schema doesn't match the connection's default and
 *  thus needs explicit qualification in the inserted text. When the
 *  default isn't known yet (engine context still loading), assume bare. */
function needsQualification(defaultSchema: string | null, tableSchema: string): boolean {
  if (!defaultSchema) return false;
  return defaultSchema.toLowerCase() !== tableSchema.toLowerCase();
}

// --- helpers --------------------------------------------------------------

interface TableRef {
  schema: string;
  name: string;
  pk: string[];
  fkColumns: string[];
}

interface ColumnRef {
  schema: string;
  table: string;
  name: string;
  data_type: string;
  nullable: boolean;
  isPk: boolean;
  isFk: boolean;
}

function allTables(schema: Schema | null): TableRef[] {
  if (!schema) return [];
  const out: TableRef[] = [];
  for (const ns of schema.schemas) {
    for (const t of ns.tables) {
      out.push({
        schema: ns.name,
        name: t.name,
        pk: t.primary_key?.columns ?? [],
        fkColumns: t.foreign_keys.flatMap((fk) => fk.columns),
      });
    }
  }
  return out;
}

function allColumns(schema: Schema | null): ColumnRef[] {
  if (!schema) return [];
  const out: ColumnRef[] = [];
  for (const ns of schema.schemas) {
    for (const t of ns.tables) {
      const pks = new Set(t.primary_key?.columns ?? []);
      const fks = new Set(t.foreign_keys.flatMap((fk) => fk.columns));
      for (const c of t.columns) {
        out.push({
          schema: ns.name,
          table: t.name,
          name: c.name,
          data_type: c.data_type,
          nullable: c.nullable,
          isPk: pks.has(c.name),
          isFk: fks.has(c.name),
        });
      }
    }
  }
  return out;
}

function columnsForTable(schema: Schema | null, tableName: string): ColumnRef[] {
  if (!schema) return [];
  const lower = tableName.toLowerCase();
  for (const ns of schema.schemas) {
    for (const t of ns.tables) {
      if (t.name.toLowerCase() === lower) {
        const pks = new Set(t.primary_key?.columns ?? []);
        const fks = new Set(t.foreign_keys.flatMap((fk) => fk.columns));
        return t.columns.map((c) => ({
          schema: ns.name,
          table: t.name,
          name: c.name,
          data_type: c.data_type,
          nullable: c.nullable,
          isPk: pks.has(c.name),
          isFk: fks.has(c.name),
        }));
      }
    }
  }
  return [];
}

function tablesInSchema(schema: Schema | null, schemaName: string): TableRef[] {
  if (!schema) return [];
  const lower = schemaName.toLowerCase();
  const ns = schema.schemas.find((s) => s.name.toLowerCase() === lower);
  if (!ns) return [];
  return ns.tables.map((t) => ({
    schema: ns.name,
    name: t.name,
    pk: t.primary_key?.columns ?? [],
    fkColumns: t.foreign_keys.flatMap((fk) => fk.columns),
  }));
}

function tableSuggestion(
  monaco: MonacoNS,
  table: TableRef,
  range: IRange,
  qualified: boolean,
  qStyle: QuoteStyle,
): languages.CompletionItem {
  const insert = qualified
    ? `${quote(table.schema, qStyle)}.${quote(table.name, qStyle)}`
    : quote(table.name, qStyle);
  // Label stays bare so Monaco's fuzzy match still hits `order_items` when
  // the user types `ord` — but `detail` makes the schema explicit so a
  // qualified insertion isn't a surprise.
  return {
    label: table.name,
    kind: monaco.languages.CompletionItemKind.Struct,
    insertText: insert,
    range,
    detail: qualified ? `table · ${table.schema} (will qualify)` : `table · ${table.schema}`,
    documentation: {
      value: [
        `**${table.schema}.${table.name}**`,
        qualified
          ? `Inserts as \`${insert}\` because \`${table.schema}\` isn't the connection's default schema.`
          : '',
        table.pk.length > 0 ? `PK: ${table.pk.join(', ')}` : '',
        table.fkColumns.length > 0 ? `FK: ${table.fkColumns.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    sortText: `1_${table.name.toLowerCase()}`,
  };
}

function columnSuggestion(
  monaco: MonacoNS,
  col: ColumnRef,
  range: IRange,
  qStyle: QuoteStyle,
): languages.CompletionItem {
  const tag = col.isPk ? ' [PK]' : col.isFk ? ' [FK]' : '';
  return {
    label: col.name,
    kind: col.isPk
      ? monaco.languages.CompletionItemKind.Property
      : monaco.languages.CompletionItemKind.Field,
    insertText: quote(col.name, qStyle),
    range,
    detail: `${col.data_type}${tag} · ${col.table}`,
    documentation: {
      value: `**${col.schema}.${col.table}.${col.name}**\n\nType: \`${col.data_type}\`${col.nullable ? '' : ' · NOT NULL'}`,
    },
    sortText: `2_${col.name.toLowerCase()}`,
  };
}

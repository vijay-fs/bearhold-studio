'use client';

// EXPLAIN viewer.
//
// The Run/Explain split in the workspace wraps the user's SQL with the
// engine's flavour of EXPLAIN and hands the result to this component.
// Each engine speaks a different dialect:
//
//   - Postgres: `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` returns
//     a structured JSON tree with planned vs. actual row counts, per-node
//     timing, and buffer-hit/read stats.
//
//   - MySQL: `EXPLAIN ANALYZE` (8.0.18+) returns an already-formatted text
//     tree with cost + actual-time annotations on each line. We parse the
//     indent levels into a node tree so we can lay it out, highlight
//     mis-estimates, and reuse the same node-row UI as PG.
//
//   - SQLite: `EXPLAIN QUERY PLAN` returns `(id, parent, notused, detail)`
//     rows; we rebuild the tree from the parent links. No timings — SQLite
//     doesn't surface them via this command.

import { useMemo, useState } from 'react';
import { ChevronRight, AlertTriangle } from 'lucide-react';

import type { QueryResult, DatabaseEngine } from '@/lib/types';
import { cn } from '@/lib/utils';

interface PgPlanNode {
  'Node Type': string;
  'Parallel Aware'?: boolean;
  'Relation Name'?: string;
  Alias?: string;
  Schema?: string;
  'Startup Cost'?: number;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Plan Width'?: number;
  'Actual Startup Time'?: number;
  'Actual Total Time'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  Output?: string[];
  Filter?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Hash Cond'?: string;
  'Join Filter'?: string;
  'Sort Key'?: string[];
  'Sort Method'?: string;
  'Join Type'?: string;
  Strategy?: string;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Rows Removed by Join Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Shared Dirtied Blocks'?: number;
  'Shared Written Blocks'?: number;
  'Local Hit Blocks'?: number;
  'Local Read Blocks'?: number;
  'Temp Read Blocks'?: number;
  'Temp Written Blocks'?: number;
  Plans?: PgPlanNode[];
}

interface PgExplainRoot {
  Plan: PgPlanNode;
  'Planning Time'?: number;
  'Execution Time'?: number;
}

interface ParsedPlan {
  root: PgPlanNode;
  planningMs?: number;
  executionMs?: number;
  totalActualMs: number;
}

/** Parse Postgres EXPLAIN JSON output. The first row's first cell is either
 *  already a JS array (driver decoded JSONB) or a JSON string we need to
 *  parse ourselves. Tolerates both. */
function parsePostgresExplain(result: QueryResult): ParsedPlan | null {
  const cell = result.rows?.[0]?.[0];
  if (cell == null) return null;
  let parsed: unknown;
  if (typeof cell === 'string') {
    try {
      parsed = JSON.parse(cell);
    } catch {
      return null;
    }
  } else {
    parsed = cell;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0] as PgExplainRoot | undefined;
  if (!first || !first.Plan) return null;
  return {
    root: first.Plan,
    planningMs: first['Planning Time'],
    executionMs: first['Execution Time'],
    totalActualMs: first.Plan['Actual Total Time'] ?? 0,
  };
}

interface PlanViewerProps {
  result: QueryResult;
  engine: DatabaseEngine;
}

export function PlanViewer({ result, engine }: PlanViewerProps) {
  if (engine === 'postgres') {
    return <PostgresPlan result={result} />;
  }
  if (engine === 'mysql') {
    return <MysqlPlan result={result} />;
  }
  if (engine === 'sqlite') {
    return <SqlitePlan result={result} />;
  }
  return (
    <div className="p-4 text-xs text-muted-foreground">
      EXPLAIN viewer for {engine} is not implemented yet. The raw output is
      shown on the Results tab.
    </div>
  );
}

function PostgresPlan({ result }: { result: QueryResult }) {
  const parsed = useMemo(() => parsePostgresExplain(result), [result]);

  if (!parsed) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        Could not parse the EXPLAIN output. The query may not have returned a
        JSON plan (e.g. EXPLAIN was run without FORMAT JSON).
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-4 border-b bg-muted/30 px-4 py-2 text-xs">
        {parsed.planningMs != null && (
          <Stat label="Planning" value={`${parsed.planningMs.toFixed(2)} ms`} />
        )}
        {parsed.executionMs != null && (
          <Stat
            label="Execution"
            value={`${parsed.executionMs.toFixed(2)} ms`}
            emphasis
          />
        )}
        {parsed.planningMs != null && parsed.executionMs != null && (
          <Stat
            label="Total"
            value={`${(parsed.planningMs + parsed.executionMs).toFixed(2)} ms`}
          />
        )}
      </div>
      <div className="flex-1 overflow-auto p-2 font-mono text-[11px]">
        <PlanNodeRow
          node={parsed.root}
          totalActualMs={parsed.totalActualMs}
          depth={0}
          initiallyOpen
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}:</span>
      <span
        className={cn('font-mono', emphasis ? 'font-semibold' : 'font-normal')}
      >
        {value}
      </span>
    </div>
  );
}

interface PlanNodeRowProps {
  node: PgPlanNode;
  totalActualMs: number;
  depth: number;
  initiallyOpen?: boolean;
}

function PlanNodeRow({ node, totalActualMs, depth, initiallyOpen }: PlanNodeRowProps) {
  const [open, setOpen] = useState(initiallyOpen ?? depth < 3);
  const hasChildren = (node.Plans?.length ?? 0) > 0;

  const planRows = node['Plan Rows'];
  const actualRows = node['Actual Rows'];
  const loops = node['Actual Loops'] ?? 1;
  // Postgres reports per-loop averages for nodes under nested loop joins.
  // Multiply by loops for the true total — that's what people care about.
  const totalActualRows =
    actualRows != null ? Math.round(actualRows * loops) : null;
  const totalActualTime =
    node['Actual Total Time'] != null
      ? node['Actual Total Time'] * loops
      : null;
  const misestimateFactor = useMemo(() => {
    if (planRows == null || totalActualRows == null) return null;
    const p = Math.max(planRows, 1);
    const a = Math.max(totalActualRows, 1);
    return a >= p ? a / p : p / a;
  }, [planRows, totalActualRows]);
  // 10x off is the rule-of-thumb threshold for "the planner is wrong about
  // this node". Worth surfacing visually since these are usually the cause
  // of slow plans (bad join order, missing stats).
  const misestimate = misestimateFactor != null && misestimateFactor >= 10;

  const pct =
    totalActualTime != null && totalActualMs > 0
      ? (totalActualTime / totalActualMs) * 100
      : null;

  const label = buildNodeLabel(node);
  const target = buildNodeTarget(node);

  return (
    <div>
      <div
        className="flex cursor-pointer select-none items-start gap-1 rounded px-1 py-0.5 hover:bg-accent/40"
        onClick={() => hasChildren && setOpen((v) => !v)}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        <ChevronRight
          className={cn(
            'mt-[3px] h-3 w-3 shrink-0 transition-transform',
            open && 'rotate-90',
            !hasChildren && 'invisible',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold text-foreground">{label}</span>
            {target && (
              <span className="text-muted-foreground">on {target}</span>
            )}
            {misestimate && (
              <span
                className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1 py-px text-[10px] font-medium text-amber-700 dark:text-amber-400"
                title={`Planner expected ${planRows} rows, got ${totalActualRows} — off by ${misestimateFactor!.toFixed(1)}x`}
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                {misestimateFactor!.toFixed(1)}x off
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
            {planRows != null && totalActualRows != null && (
              <span>
                rows{' '}
                <span
                  className={cn(
                    'font-mono',
                    misestimate && 'text-amber-700 dark:text-amber-400',
                  )}
                >
                  {totalActualRows.toLocaleString()}
                </span>{' '}
                / planned {planRows.toLocaleString()}
              </span>
            )}
            {totalActualTime != null && (
              <span>
                time{' '}
                <span className="font-mono">{totalActualTime.toFixed(2)} ms</span>
                {pct != null && pct >= 1 && (
                  <span className="ml-1 text-muted-foreground/70">
                    ({pct.toFixed(0)}%)
                  </span>
                )}
              </span>
            )}
            {loops > 1 && <span>loops {loops.toLocaleString()}</span>}
            {node['Total Cost'] != null && (
              <span>
                cost{' '}
                <span className="font-mono">
                  {formatCost(node['Startup Cost'], node['Total Cost'])}
                </span>
              </span>
            )}
            {buildBufferStat(node) && <span>{buildBufferStat(node)}</span>}
          </div>
          {open && <NodeDetails node={node} />}
        </div>
      </div>
      {open && hasChildren && (
        <div>
          {node.Plans!.map((child, idx) => (
            <PlanNodeRow
              key={idx}
              node={child}
              totalActualMs={totalActualMs}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NodeDetails({ node }: { node: PgPlanNode }) {
  const rows: Array<[string, string]> = [];
  if (node['Index Name']) rows.push(['Index', node['Index Name']]);
  if (node['Index Cond']) rows.push(['Index Cond', node['Index Cond']]);
  if (node['Hash Cond']) rows.push(['Hash Cond', node['Hash Cond']]);
  if (node['Join Filter']) rows.push(['Join Filter', node['Join Filter']]);
  if (node.Filter) rows.push(['Filter', node.Filter]);
  if (node['Rows Removed by Filter'] != null) {
    rows.push(['Rows Removed by Filter', String(node['Rows Removed by Filter'])]);
  }
  if (node['Rows Removed by Join Filter'] != null) {
    rows.push([
      'Rows Removed by Join Filter',
      String(node['Rows Removed by Join Filter']),
    ]);
  }
  if (node['Sort Key']?.length) {
    rows.push(['Sort Key', node['Sort Key'].join(', ')]);
  }
  if (node['Sort Method']) rows.push(['Sort Method', node['Sort Method']]);
  if (rows.length === 0) return null;

  return (
    <div className="mt-1 grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5 text-[10px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <span className="text-muted-foreground">{k}</span>
          <span className="break-all font-mono text-foreground/80">{v}</span>
        </div>
      ))}
    </div>
  );
}

function buildNodeLabel(node: PgPlanNode): string {
  const t = node['Node Type'];
  const join = node['Join Type'];
  const strategy = node.Strategy;
  if (join && t.toLowerCase().includes('join')) return `${join} ${t}`;
  if (strategy && t === 'Aggregate') return `${strategy} Aggregate`;
  return t;
}

function buildNodeTarget(node: PgPlanNode): string | null {
  const rel = node['Relation Name'];
  if (!rel) return null;
  const schema = node.Schema;
  const alias = node.Alias;
  const qualified = schema && schema !== 'public' ? `${schema}.${rel}` : rel;
  return alias && alias !== rel ? `${qualified} (${alias})` : qualified;
}

function formatCost(startup: number | undefined, total: number): string {
  if (startup == null) return total.toFixed(2);
  return `${startup.toFixed(2)}..${total.toFixed(2)}`;
}

function buildBufferStat(node: PgPlanNode): string | null {
  const hit = node['Shared Hit Blocks'] ?? 0;
  const read = node['Shared Read Blocks'] ?? 0;
  if (hit === 0 && read === 0) return null;
  const parts: string[] = [];
  if (hit > 0) parts.push(`hit ${hit}`);
  if (read > 0) parts.push(`read ${read}`);
  return `buffers ${parts.join(', ')}`;
}

/** Wrap a user query with the engine's EXPLAIN form. Strips a trailing
 *  semicolon so we don't end up with `... ;)` for the parenthesised forms. */
export function buildExplainSql(engine: DatabaseEngine, sql: string): string | null {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) return null;
  if (engine === 'postgres') {
    return `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${trimmed}`;
  }
  if (engine === 'mysql') {
    // MySQL 8.0.18+ returns a text tree with cost + actual-time
    // annotations. The renderer parses the indent structure into a node tree.
    return `EXPLAIN ANALYZE ${trimmed}`;
  }
  if (engine === 'sqlite') {
    return `EXPLAIN QUERY PLAN ${trimmed}`;
  }
  return null;
}

/** True for engines that currently support the in-app EXPLAIN viewer. */
export function explainSupportedFor(engine: DatabaseEngine): boolean {
  return engine === 'postgres' || engine === 'mysql' || engine === 'sqlite';
}

// --- MySQL --------------------------------------------------------------

interface MyPlanNode {
  label: string;
  cost?: number;
  planRows?: number;
  actualStartMs?: number;
  actualEndMs?: number;
  actualRows?: number;
  loops?: number;
  children: MyPlanNode[];
}

/** Parse the indented text tree returned by MySQL 8.0.18+ `EXPLAIN ANALYZE`.
 *  Each line has the form `<indent>-> <label>  (cost=... rows=...) (actual
 *  time=A..B rows=R loops=L)`. Depth is decided by the indent column of the
 *  arrow marker — children sit at strictly greater indent than their parent. */
function parseMysqlTreeText(text: string): MyPlanNode | null {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  const stack: Array<{ depth: number; node: MyPlanNode }> = [];
  let root: MyPlanNode | null = null;
  const actualRe = /\(actual time=([\d.]+)\.\.([\d.]+) rows=([\d.]+) loops=(\d+)\)/;
  const costRe = /\(cost=([\d.]+)(?: rows=([\d.]+))?\)/;
  for (const line of lines) {
    const m = line.match(/^(\s*)->\s*(.+?)\s*$/);
    if (!m) continue;
    const depth = m[1]?.length ?? 0;
    const rest = m[2] ?? '';
    const actualM = rest.match(actualRe);
    const costM = rest.match(costRe);
    const label = rest.replace(actualRe, '').replace(costRe, '').trim();
    const node: MyPlanNode = {
      label,
      cost: costM ? Number(costM[1]) : undefined,
      planRows: costM?.[2] ? Number(costM[2]) : undefined,
      actualStartMs: actualM ? Number(actualM[1]) : undefined,
      actualEndMs: actualM ? Number(actualM[2]) : undefined,
      actualRows: actualM ? Number(actualM[3]) : undefined,
      loops: actualM ? Number(actualM[4]) : undefined,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) {
      stack.pop();
    }
    if (stack.length === 0) {
      root = node;
    } else {
      stack[stack.length - 1]!.node.children.push(node);
    }
    stack.push({ depth, node });
  }
  return root;
}

function MysqlPlan({ result }: { result: QueryResult }) {
  // MySQL tree form: one text column, one row, value is the full tree.
  if (
    result.columns.length === 1 &&
    result.rows.length === 1 &&
    typeof result.rows[0]?.[0] === 'string'
  ) {
    const text = String(result.rows[0]![0]);
    const root = parseMysqlTreeText(text);
    if (!root) {
      // Couldn't make sense of the indent structure — show the raw text so
      // the user still gets the info, just not the collapsible tree.
      return (
        <div className="h-full overflow-auto p-3">
          <pre className="whitespace-pre font-mono text-[11px] leading-snug">
            {text}
          </pre>
        </div>
      );
    }
    const totalActualMs = root.actualEndMs ?? 0;
    return (
      <div className="h-full overflow-auto p-2 font-mono text-[11px]">
        <MysqlNode node={root} totalActualMs={totalActualMs} depth={0} initiallyOpen />
      </div>
    );
  }
  // Unexpected shape (MySQL EXPLAIN ANALYZE always returns the
  // single-column text tree). Fall back to a raw dump of the rows.
  return (
    <div className="h-full overflow-auto p-3">
      <pre className="whitespace-pre font-mono text-[11px] leading-snug">
        {JSON.stringify(result.rows, null, 2)}
      </pre>
    </div>
  );
}

interface MysqlNodeProps {
  node: MyPlanNode;
  totalActualMs: number;
  depth: number;
  initiallyOpen?: boolean;
}

function MysqlNode({ node, totalActualMs, depth, initiallyOpen }: MysqlNodeProps) {
  const [open, setOpen] = useState(initiallyOpen ?? depth < 3);
  const hasChildren = node.children.length > 0;
  const loops = node.loops ?? 1;
  const totalActualRows =
    node.actualRows != null ? Math.round(node.actualRows * loops) : null;
  const totalActualTime =
    node.actualEndMs != null ? node.actualEndMs * loops : null;
  const misestimateFactor = useMemo(() => {
    if (node.planRows == null || totalActualRows == null) return null;
    const p = Math.max(node.planRows, 1);
    const a = Math.max(totalActualRows, 1);
    return a >= p ? a / p : p / a;
  }, [node.planRows, totalActualRows]);
  const misestimate = misestimateFactor != null && misestimateFactor >= 10;
  const pct =
    totalActualTime != null && totalActualMs > 0
      ? (totalActualTime / totalActualMs) * 100
      : null;

  return (
    <div>
      <div
        className="flex cursor-pointer select-none items-start gap-1 rounded px-1 py-0.5 hover:bg-accent/40"
        onClick={() => hasChildren && setOpen((v) => !v)}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        <ChevronRight
          className={cn(
            'mt-[3px] h-3 w-3 shrink-0 transition-transform',
            open && 'rotate-90',
            !hasChildren && 'invisible',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold text-foreground">{node.label}</span>
            {misestimate && (
              <span
                className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1 py-px text-[10px] font-medium text-amber-700 dark:text-amber-400"
                title={`Planner expected ${node.planRows} rows, got ${totalActualRows} — off by ${misestimateFactor!.toFixed(1)}x`}
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                {misestimateFactor!.toFixed(1)}x off
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
            {node.planRows != null && totalActualRows != null && (
              <span>
                rows{' '}
                <span
                  className={cn(
                    'font-mono',
                    misestimate && 'text-amber-700 dark:text-amber-400',
                  )}
                >
                  {totalActualRows.toLocaleString()}
                </span>{' '}
                / planned {node.planRows.toLocaleString()}
              </span>
            )}
            {totalActualTime != null && (
              <span>
                time{' '}
                <span className="font-mono">{totalActualTime.toFixed(2)} ms</span>
                {pct != null && pct >= 1 && (
                  <span className="ml-1 text-muted-foreground/70">
                    ({pct.toFixed(0)}%)
                  </span>
                )}
              </span>
            )}
            {loops > 1 && <span>loops {loops.toLocaleString()}</span>}
            {node.cost != null && (
              <span>
                cost <span className="font-mono">{node.cost.toFixed(2)}</span>
              </span>
            )}
          </div>
        </div>
      </div>
      {open && hasChildren && (
        <div>
          {node.children.map((child, idx) => (
            <MysqlNode
              key={idx}
              node={child}
              totalActualMs={totalActualMs}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- SQLite --------------------------------------------------------------

interface SqlitePlanNode {
  id: number;
  detail: string;
  children: SqlitePlanNode[];
}

/** SQLite returns rows as `(id, parent, notused, detail)`. Build a tree
 *  using the parent links — parent 0 means top-level. Operations are
 *  emitted in execution order, but we don't rely on row ordering here:
 *  we index by id first, then attach to parents in a second pass. */
function buildSqliteTree(result: QueryResult): SqlitePlanNode[] {
  const colIdx = (name: string) =>
    result.columns.findIndex((c) => c.name.toLowerCase() === name);
  const idCol = colIdx('id');
  const parentCol = colIdx('parent');
  const detailCol = colIdx('detail');
  if (idCol < 0 || parentCol < 0 || detailCol < 0) return [];

  const nodes = result.rows.map((r) => ({
    id: Number(r[idCol] ?? 0),
    parent: Number(r[parentCol] ?? 0),
    detail: String(r[detailCol] ?? ''),
    children: [] as SqlitePlanNode[],
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roots: SqlitePlanNode[] = [];
  for (const n of nodes) {
    const parent = byId.get(n.parent);
    if (parent && n.parent !== n.id) {
      parent.children.push(n);
    } else {
      roots.push(n);
    }
  }
  return roots;
}

function SqlitePlan({ result }: { result: QueryResult }) {
  const roots = useMemo(() => buildSqliteTree(result), [result]);
  if (roots.length === 0) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        EXPLAIN QUERY PLAN returned no rows — the query is trivial (no scans
        or joins) or the result shape was unexpected.
      </p>
    );
  }
  return (
    <div className="h-full overflow-auto p-2 font-mono text-[11px]">
      {roots.map((r) => (
        <SqliteNode key={r.id} node={r} depth={0} />
      ))}
    </div>
  );
}

function SqliteNode({ node, depth }: { node: SqlitePlanNode; depth: number }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  // SCAN is the heaviest signal SQLite gives us — full-table read, usually
  // worth a closer look. Surface it visually.
  const isScan = /^scan\b/i.test(node.detail);
  return (
    <div>
      <div
        className="flex cursor-pointer select-none items-start gap-1 rounded px-1 py-0.5 hover:bg-accent/40"
        onClick={() => hasChildren && setOpen((v) => !v)}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        <ChevronRight
          className={cn(
            'mt-[3px] h-3 w-3 shrink-0 transition-transform',
            open && 'rotate-90',
            !hasChildren && 'invisible',
          )}
        />
        <div className="min-w-0 flex-1">
          <span
            className={cn(
              isScan ? 'text-amber-700 dark:text-amber-400' : 'text-foreground',
            )}
          >
            {node.detail}
          </span>
        </div>
      </div>
      {open && hasChildren && (
        <div>
          {node.children.map((child) => (
            <SqliteNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

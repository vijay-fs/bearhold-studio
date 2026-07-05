// Table dependency graph + topological sort.
//
// Used by the schema and data diff apply flows to order statements so
// they don't violate foreign-key constraints during batch execution.
//
// A table X "depends on" table Y when X has a FK pointing at Y. The
// resulting DAG lets us:
//
//   Schema DDL:
//     CREATE order: parents first  (users before orders before items)
//     DROP   order: children first (items before orders before users)
//
//   Data DML:
//     INSERT order: parents first  (a child row can't reference a
//                                   parent that doesn't exist yet)
//     DELETE order: children first (a parent can't be dropped while
//                                   a child still points at it — the
//                                   exact error you were seeing)
//     UPDATE order: any (no cross-row FK impact)
//
// The sort is stable: tables that don't participate in FKs come out
// in their original alphabetic order, so unrelated changes stay
// predictable.

import type { Schema, Table } from '@dbstudio/erd';

/** Fully-qualified `schema.table` key. Stable across the codebase. */
export type TableKey = string;

export function tableKey(schema: string, table: string): TableKey {
  return `${schema}.${table}`;
}

export interface DependencyGraph {
  /** Nodes present in the schema. Every referenced table is included
   *  even if only via FK — an FK to a table that isn't in `nodes`
   *  points at an external target and is ignored by the sort. */
  nodes: Set<TableKey>;
  /** Adjacency list: `dependsOn.get(child)` = tables the child has
   *  FKs pointing to (i.e. must exist first when creating). */
  dependsOn: Map<TableKey, Set<TableKey>>;
}

export function buildDependencyGraph(schema: Schema): DependencyGraph {
  const nodes = new Set<TableKey>();
  const dependsOn = new Map<TableKey, Set<TableKey>>();

  const collect = (t: Table) => {
    const key = tableKey(t.schema, t.name);
    nodes.add(key);
    if (!dependsOn.has(key)) dependsOn.set(key, new Set());
    for (const fk of t.foreign_keys) {
      const parent = tableKey(fk.references_schema, fk.references_table);
      // Self-references (`categories.parent_id → categories.id`)
      // wouldn't create a cycle in the ordering — the row-level
      // dependency is enforced by the engine, not the batch. Skip.
      if (parent === key) continue;
      dependsOn.get(key)!.add(parent);
    }
  };

  for (const ns of schema.schemas) {
    for (const t of ns.tables) collect(t);
  }
  return { nodes, dependsOn };
}

/** Topologically sort tables so parents come before children.
 *  Kahn's algorithm — O(V + E), deterministic tie-break by
 *  alphabetical key so re-runs produce the same order. */
export function topSortTables(graph: DependencyGraph): TableKey[] {
  const inDegree = new Map<TableKey, number>();
  for (const n of graph.nodes) inDegree.set(n, 0);
  for (const [child, parents] of graph.dependsOn) {
    for (const parent of parents) {
      if (!graph.nodes.has(parent)) continue;
      inDegree.set(child, (inDegree.get(child) ?? 0) + 1);
    }
  }

  // Alphabetically-ordered ready queue so the output is stable.
  const ready: TableKey[] = [];
  for (const [key, deg] of inDegree) if (deg === 0) ready.push(key);
  ready.sort();

  const out: TableKey[] = [];
  while (ready.length > 0) {
    const key = ready.shift()!;
    out.push(key);
    // Decrement in-degree of every child of `key`.
    for (const [child, parents] of graph.dependsOn) {
      if (!parents.has(key)) continue;
      const next = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, next);
      if (next === 0) {
        // Insert-sorted so ready queue stays alphabetical.
        const idx = ready.findIndex((k) => k > child);
        if (idx === -1) ready.push(child);
        else ready.splice(idx, 0, child);
      }
    }
  }

  // Anything left over is inside a cycle. Rare in practice for
  // real schemas (only self-referential loops we already broke).
  // Append them in alphabetical order so their statements still
  // execute — the engine will surface any real problem.
  if (out.length < graph.nodes.size) {
    const remaining = [...graph.nodes].filter((n) => !out.includes(n)).sort();
    out.push(...remaining);
  }
  return out;
}

/** Convenience: sort keys parent-first (create/insert order). */
export function parentFirstOrder(schema: Schema): TableKey[] {
  return topSortTables(buildDependencyGraph(schema));
}

/** Convenience: sort keys child-first (drop/delete order). */
export function childFirstOrder(schema: Schema): TableKey[] {
  return topSortTables(buildDependencyGraph(schema)).reverse();
}

/** Rank map — how far a table is from the top of the DAG.
 *  Lower = fewer dependencies. Used to sort a mixed statement list
 *  when we want to interleave kinds while still respecting FK
 *  order. */
export function rankMap(order: TableKey[]): Map<TableKey, number> {
  const m = new Map<TableKey, number>();
  order.forEach((k, i) => m.set(k, i));
  return m;
}

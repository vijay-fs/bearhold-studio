import dagre from '@dagrejs/dagre';
import { MarkerType, type Edge, type Node } from '@xyflow/react';

import type { Schema, Table } from './types';
import { tableKey } from './types';

const NODE_WIDTH = 280;
const HEADER_HEIGHT = 32;
const ROW_HEIGHT = 24;
const NODE_VERTICAL_PADDING = 8;

export interface TableNodeData {
  table: Table;
  isReferenced: boolean;
  /** Names of columns in this table that some other table's FK points at.
   *  The node uses this to decide whether to render the left-side target
   *  handle on a given row — columns with no incoming FK get no handle at
   *  all, so the canvas isn't dotted with floating connectors. */
  incomingFkColumns: string[];
  [key: string]: unknown;
}

export interface LayoutOptions {
  /** Layout direction: 'LR' (left to right) or 'TB' (top to bottom). */
  direction?: 'LR' | 'TB';
  /** Restrict to a single named schema. Default: all schemas. */
  schemaFilter?: string | null;
}

/**
 * Lay out tables and FK edges using Dagre. Returns React Flow nodes and edges
 * positioned to minimize edge crossings. Tables with no PK/FK connections are
 * still included as isolated nodes.
 *
 * Edges reference per-column handles (`${columnName}::source`/`::target`) so
 * lines land on the exact FK column on one side and the referenced PK column
 * on the other.
 */
export function layoutSchema(
  schema: Schema,
  options: LayoutOptions = {},
): { nodes: Node<TableNodeData>[]; edges: Edge[] } {
  const direction = options.direction ?? 'LR';
  const tables: Table[] = [];
  for (const ns of schema.schemas) {
    if (options.schemaFilter && ns.name !== options.schemaFilter) continue;
    tables.push(...ns.tables);
  }

  const referenced = new Set<string>();
  // Map of tableKey -> Set<columnName> of columns that are the target of
  // at least one FK from another (or the same) table. Used by TableNode to
  // decide whether to render the left-side handle on each row.
  const incomingByTable = new Map<string, Set<string>>();
  for (const t of tables) {
    for (const fk of t.foreign_keys) {
      const targetKey = tableKey(fk.references_schema, fk.references_table);
      referenced.add(targetKey);
      let set = incomingByTable.get(targetKey);
      if (!set) {
        set = new Set();
        incomingByTable.set(targetKey, set);
      }
      for (const col of fk.references_columns) set.add(col);
    }
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 100, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const t of tables) {
    const height = HEADER_HEIGHT + ROW_HEIGHT * t.columns.length + NODE_VERTICAL_PADDING;
    g.setNode(tableKey(t.schema, t.name), { width: NODE_WIDTH, height });
  }

  const edges: Edge[] = [];
  for (const t of tables) {
    for (const fk of t.foreign_keys) {
      const source = tableKey(t.schema, t.name);
      const target = tableKey(fk.references_schema, fk.references_table);
      if (!g.hasNode(target)) continue;
      g.setEdge(source, target);

      // Composite FKs anchor on the first column on each side for the visual
      // line; the label still lists every column.
      const sourceCol = fk.columns[0];
      const targetCol = fk.references_columns[0];
      const label =
        fk.columns.length > 1 ? `(${fk.columns.join(', ')})` : (fk.columns[0] ?? fk.name);

      edges.push({
        id: `${source}::${fk.name}`,
        source,
        target,
        sourceHandle: sourceCol ? `${sourceCol}::source` : undefined,
        targetHandle: targetCol ? `${targetCol}::target` : undefined,
        type: 'smoothstep',
        animated: false,
        label,
        // React Flow renders edge labels as SVG <text>, where `fill`
        // controls the text colour. Without an explicit fill the
        // browser uses its default (black on light, still black on
        // dark) and the column-name labels become invisible on the
        // dark theme. Wiring it to the same CSS var as body text
        // means it follows whatever theme is active.
        labelStyle: {
          fontSize: 10,
          fontFamily: 'var(--font-mono, monospace)',
          fill: 'hsl(var(--foreground))',
        },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 4,
        labelBgStyle: { fill: 'hsl(var(--background))', fillOpacity: 0.9 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: 'hsl(var(--primary) / 0.7)',
        },
        style: { stroke: 'hsl(var(--primary) / 0.55)', strokeWidth: 1.5 },
      });
    }
  }

  dagre.layout(g);

  const nodes: Node<TableNodeData>[] = tables.map((t) => {
    const key = tableKey(t.schema, t.name);
    const pos = g.node(key);
    return {
      id: key,
      type: 'tableNode',
      position: { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 },
      data: {
        table: t,
        isReferenced: referenced.has(key),
        incomingFkColumns: Array.from(incomingByTable.get(key) ?? []),
      },
      width: NODE_WIDTH,
    };
  });

  return { nodes, edges };
}

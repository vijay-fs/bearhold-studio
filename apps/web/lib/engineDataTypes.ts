// Engine-specific data type catalogs for the DDL dialog dropdowns.
//
// Each engine's curated list — the types people actually reach for
// when adding / altering a column. Not exhaustive (every engine has
// a long tail of system / domain types) but covers the standard
// cases. The dropdown also exposes a Custom option that drops back
// to a free-text input so power users can write things like
// `varchar(120)`, `numeric(10,4)`, `enum('a','b')` etc.

import type { DatabaseEngine } from './types';

interface TypeGroup {
  label: string;
  types: string[];
}

/** Groups are surfaced as <optgroup> in the dropdown so common types
 *  stay near the top instead of getting buried in an alphabetical
 *  super-list. Each group's first entry is the "default" pick when
 *  the user opens the group fresh. */
export const ENGINE_TYPES: Record<DatabaseEngine, TypeGroup[]> = {
  postgres: [
    {
      label: 'Numeric',
      types: ['integer', 'bigint', 'smallint', 'serial', 'bigserial', 'numeric', 'real', 'double precision'],
    },
    {
      label: 'Text',
      types: ['text', 'varchar(255)', 'char(1)', 'citext'],
    },
    {
      label: 'Date/Time',
      types: [
        'timestamp with time zone',
        'timestamp without time zone',
        'date',
        'time',
        'interval',
      ],
    },
    {
      label: 'Boolean',
      types: ['boolean'],
    },
    {
      label: 'JSON / Structured',
      types: ['jsonb', 'json', 'uuid'],
    },
    {
      label: 'Binary',
      types: ['bytea'],
    },
    {
      label: 'Network',
      types: ['inet', 'cidr', 'macaddr'],
    },
  ],

  mysql: [
    {
      label: 'Numeric',
      types: [
        'INT',
        'BIGINT',
        'SMALLINT',
        'TINYINT',
        'MEDIUMINT',
        'DECIMAL(10,2)',
        'FLOAT',
        'DOUBLE',
      ],
    },
    {
      label: 'Text',
      types: ['VARCHAR(255)', 'TEXT', 'LONGTEXT', 'CHAR(1)'],
    },
    {
      label: 'Date/Time',
      types: ['DATETIME', 'TIMESTAMP', 'DATE', 'TIME', 'YEAR'],
    },
    {
      label: 'Boolean',
      // MySQL's BOOLEAN is an alias for TINYINT(1); call it out so
      // users get the right introspection back.
      types: ['BOOLEAN'],
    },
    {
      label: 'JSON / Structured',
      types: ['JSON'],
    },
    {
      label: 'Binary',
      types: ['BLOB', 'LONGBLOB', 'VARBINARY(255)'],
    },
    {
      label: 'Enum / Set',
      types: ["ENUM('a','b','c')", "SET('a','b','c')"],
    },
  ],

  sqlite: [
    // SQLite uses type affinity — these strings still get stored as
    // declared types and influence affinity for new rows. The five
    // here cover the documented affinities; everything else falls
    // back to TEXT/NUMERIC behavior.
    {
      label: 'Affinities',
      types: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB'],
    },
    {
      label: 'Common aliases',
      types: ['VARCHAR(255)', 'DATETIME', 'BOOLEAN'],
    },
  ],

  // Non-relational engines don't go through this picker (the
  // relational DDL dialog isn't shown for them), but TS wants the
  // record to be exhaustive over the union.
  mongodb: [],
  redis: [],
  cassandra: [],
  neo4j: [],
  couchdb: [],
};

/** Flatten the catalog for "does this type appear in the list?"
 *  checks — used by the dropdown to decide whether the current value
 *  is a preset (just show it selected) or a custom value (switch the
 *  control to Custom mode with the text field). */
export function isPresetType(engine: DatabaseEngine, value: string): boolean {
  return ENGINE_TYPES[engine].some((g) =>
    g.types.some((t) => t.toLowerCase() === value.toLowerCase()),
  );
}

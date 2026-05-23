// Parsers for common connection-credential exports. The output is a
// uniform `ImportedProfile` list that the import UI shows for review
// before any of them actually land in the connections store.
//
// Passwords are intentionally NOT carried through — the OS keychain
// path expects an explicit user gesture for each credential, and we
// shouldn't surprise the user by silently importing secrets from a
// file they handed us. They re-enter the password in the connection
// form after import.

import type { DatabaseEngine } from './types';

export type ImportSource = 'pgpass' | 'tableplus';

export interface ImportedProfile {
  source: ImportSource;
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  database: string;
  username: string;
}

/** Best-effort format detection — tries TablePlus JSON first (it's the
 *  most unambiguous), then falls back to the colon-delimited .pgpass
 *  shape. Returns null when neither parser yields entries so the UI can
 *  prompt for an explicit choice. */
export function detectAndParse(text: string): ImportedProfile[] | null {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = parseTablePlus(trimmed);
    if (parsed.length > 0) return parsed;
  }
  const pg = parsePgpass(trimmed);
  if (pg.length > 0) return pg;
  return null;
}

/** Parse a `.pgpass`-formatted blob. One entry per line, fields
 *  delimited by `:`, with `\:` as the literal-colon escape. Lines
 *  starting with `#` are comments. `*` is the wildcard — we coerce
 *  wildcards to sensible defaults (localhost / 5432 / postgres) so the
 *  imported profile is at least usable as a starting point. */
export function parsePgpass(text: string): ImportedProfile[] {
  const out: ImportedProfile[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = splitOnColon(line);
    if (parts.length < 4) continue;
    const [hostRaw, portRaw, dbRaw, userRaw] = parts;
    const host = !hostRaw || hostRaw === '*' ? 'localhost' : hostRaw;
    const port =
      !portRaw || portRaw === '*' ? 5432 : Number.parseInt(portRaw, 10) || 5432;
    const database = !dbRaw || dbRaw === '*' ? 'postgres' : dbRaw;
    const username = userRaw || 'postgres';
    out.push({
      source: 'pgpass',
      name: `${username}@${host}/${database}`,
      engine: 'postgres',
      host,
      port,
      database,
      username,
    });
  }
  return out;
}

function splitOnColon(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === ':') {
      cur += ':';
      i++;
      continue;
    }
    if (c === ':') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Parse a TablePlus JSON export. TablePlus emits either an array of
 *  connection objects or a single object with a `connections` array,
 *  depending on the export path — accept both. Field names vary across
 *  TablePlus versions; we read the canonical set and fall back to
 *  reasonable alternatives. */
export function parseTablePlus(text: string): ImportedProfile[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const items: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { connections?: unknown[] })?.connections)
      ? ((data as { connections: unknown[] }).connections)
      : [data];

  const out: ImportedProfile[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const driver = String(obj.Driver ?? obj.driver ?? '').toLowerCase();
    const engine = mapTablePlusDriver(driver);
    if (!engine) continue;
    const host = String(obj.DatabaseHost ?? obj.databaseHost ?? obj.host ?? '');
    const portRaw = obj.DatabasePort ?? obj.databasePort ?? obj.port;
    const port =
      typeof portRaw === 'number'
        ? portRaw
        : Number.parseInt(String(portRaw ?? ''), 10) || defaultPortFor(engine);
    const database = String(
      obj.DatabaseName ?? obj.databaseName ?? obj.database ?? '',
    );
    const username = String(
      obj.DatabaseUser ?? obj.databaseUser ?? obj.username ?? '',
    );
    const name = String(
      obj.ConnectionName ?? obj.connectionName ?? obj.name ?? `${username}@${host}`,
    );
    if (!host) continue;
    out.push({ source: 'tableplus', name, engine, host, port, database, username });
  }
  return out;
}

function mapTablePlusDriver(driver: string): DatabaseEngine | null {
  if (driver.includes('postgres')) return 'postgres';
  if (driver.includes('mariadb')) return 'mariadb';
  if (driver.includes('mysql')) return 'mysql';
  if (driver.includes('sqlite')) return 'sqlite';
  if (driver.includes('cockroach')) return 'cockroachdb';
  return null;
}

function defaultPortFor(engine: DatabaseEngine): number {
  if (engine === 'mysql' || engine === 'mariadb') return 3306;
  return 5432;
}

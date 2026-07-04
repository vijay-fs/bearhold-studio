// Export/import + tool bundle types.
//
// Kept in a separate file from lib/types.ts because these are
// scoped to the dump feature and don't need to be loaded by every
// page. Mirrors the Rust types in apps/desktop/src-tauri/src/tools/
// and apps/desktop/src-tauri/src/dump/.

import type { ConnectionProfile } from './types';

// ---- Tool bundles -----------------------------------------------

export interface InstalledTool {
  name: string;
  /** Absolute path to the executable. null when not yet installed. */
  path: string | null;
}

export interface ToolBundleStatus {
  bundle_key: string;
  display_name: string;
  tool_version: string;
  installed: boolean;
  install_dir: string | null;
  tools: InstalledTool[];
  covers_engines: string[];
  download_size_bytes: number | null;
  download_url: string | null;
}

/** Progress event emitted as `dbstudio://tool/progress` during
 *  install. Frontend listens once and dispatches to whichever
 *  `ToolInstallPrompt` is active. */
export type ToolProgress =
  | { bundle_key: string; phase: 'downloading'; downloaded: number; total: number }
  | { bundle_key: string; phase: 'verifying' }
  | { bundle_key: string; phase: 'extracting' }
  | { bundle_key: string; phase: 'done' };

// ---- Dump detection ---------------------------------------------

export type DumpFormat =
  | 'pg_custom'
  | 'pg_tar'
  | 'pg_plain'
  | 'mysql_plain'
  | 'sqlite_file'
  | 'sqlite_plain'
  | 'mongo_bson_dir'
  | 'jsonl'
  | 'redis_rdb'
  | 'gzip'
  | 'unknown';

export interface DumpProbe {
  format: DumpFormat;
  size_bytes: number;
  path: string;
  description: string;
}

// ---- Export -----------------------------------------------------

export type ExportFormat =
  | 'pg_custom'
  | 'pg_plain'
  | 'pg_tar'
  | 'mysql_plain'
  | 'sqlite_plain'
  | 'sqlite_file_copy';

export interface ExportOptions {
  profile: ConnectionProfile;
  output_path: string;
  format: ExportFormat;
  include_schema: boolean;
  include_data: boolean;
  tables: string[];
  drop_before_create: boolean;
  no_owner: boolean;
  single_transaction: boolean;
  parallel_jobs: number | null;
}

export interface ExportResult {
  job_id: string;
  output_path: string;
}

/** Emitted as `dbstudio://export/progress` per line of stderr and
 *  every ~250 ms as the output file grows. */
export type ExportProgress =
  | { job_id: string; kind: 'stderr'; line: string }
  | { job_id: string; kind: 'bytes'; written: number };

// ---- Import -----------------------------------------------------

export interface ImportOptions {
  profile: ConnectionProfile;
  source_path: string;
  format: DumpFormat;
  single_transaction: boolean;
  drop_before_create: boolean;
  no_owner: boolean;
  parallel_jobs: number | null;
  stop_on_error: boolean;
}

export interface ImportResult {
  job_id: string;
}

export type ImportProgress =
  | { job_id: string; kind: 'stderr'; line: string }
  | { job_id: string; kind: 'bytes'; read: number };

// ---- Engine → bundle key mapping --------------------------------

/** Which tool bundle covers a given engine. Empty string means the
 *  engine has no native-tool dependency (SQLite falls into this bucket
 *  when the user picks "File copy"). */
export function bundleKeyForEngine(engine: string): string {
  switch (engine) {
    case 'postgres':
      return 'postgres';
    case 'mysql':
      return 'mysql';
    case 'sqlite':
      return 'sqlite';
    case 'mongodb':
      return 'mongodb';
    case 'redis':
      return 'redis';
    default:
      return '';
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

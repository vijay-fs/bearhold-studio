#!/usr/bin/env node
// Make macOS CLI tools self-contained so they can ship inside the app
// bundle and run on a Mac that has no Homebrew / no vendor install.
//
// The problem: a binary like `mysqldump` or `pg_dump` links against
// dylibs (libssl, libcrypto, libpq, ...) by ABSOLUTE path
// (/opt/homebrew/...). Copied onto another Mac those paths don't exist
// and the tool fails to launch. The fix is the standard macOS
// relocation dance:
//   1. copy the binary into tools/<bundle>/bin/
//   2. walk its non-system dylib deps (otool -L), copy them into
//      tools/<bundle>/lib/, recursively
//   3. rewrite every dep reference to @rpath/<name> (install_name_tool)
//   4. point the binary's rpath at ../lib and each dylib's at its own
//      dir, and set each dylib's id to @rpath/<name>
//   5. ad-hoc re-sign (mandatory on Apple Silicon after any edit)
//
// The result under tools/<bundle>/ is picked up by
// tool_locator/bundled_tool_executable and shipped via
// bundle.resources — so the app stops asking users to `brew install`.
//
// Usage:
//   node scripts/repackage-macos-tools.mjs [bundle...]     # default: all
// Source binaries are auto-discovered on PATH / common Homebrew kegs;
// override with e.g. MYSQL_BIN_DIR=/opt/homebrew/opt/mysql-client/bin.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const OUT_ROOT = join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'tools');

if (process.platform !== 'darwin') {
  console.error('This repackager is macOS-only. On Linux/Windows use the vendor archives via fetch-desktop-tools.mjs.');
  process.exit(1);
}

// Which binaries make up each bundle, and where to look for the source.
// candidateDirs are searched in order; the first that holds the tool wins.
const BUNDLES = {
  postgres: {
    tools: ['pg_dump', 'pg_restore', 'psql'],
    candidateDirs: [
      process.env.PG_BIN_DIR,
      '/opt/homebrew/opt/libpq/bin',
      '/opt/homebrew/bin',
      '/usr/local/opt/libpq/bin',
    ],
  },
  mysql: {
    tools: ['mysqldump', 'mysql'],
    candidateDirs: [
      process.env.MYSQL_BIN_DIR,
      '/opt/homebrew/opt/mysql-client/bin',
      '/opt/homebrew/bin',
      '/usr/local/opt/mysql-client/bin',
    ],
  },
  sqlite: {
    tools: ['sqlite3'],
    candidateDirs: [process.env.SQLITE_BIN_DIR, '/opt/homebrew/opt/sqlite/bin', '/usr/bin'],
  },
};

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

/** `otool -L` dependency list (excludes the leading id/self line). */
function directDeps(file) {
  const out = sh('otool', ['-L', file]);
  return out
    .split('\n')
    .slice(1) // first line is the file path itself
    .map((l) => l.trim().replace(/\s*\(compatibility.*$/, ''))
    .filter(Boolean);
}

/** LC_RPATH entries of a Mach-O file. */
function rpaths(file) {
  const out = sh('otool', ['-l', file]);
  const paths = [];
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('cmd LC_RPATH')) {
      // path is two lines down: "path <value> (offset ..)"
      const m = lines[i + 2]?.match(/path (.+?) \(offset/);
      if (m) paths.push(m[1]);
    }
  }
  return paths;
}

function isSystemLib(p) {
  return p.startsWith('/usr/lib/') || p.startsWith('/System/');
}

/** Resolve a dependency string to a concrete source path, or null. */
function resolveDep(dep, ownerFile, ownerRpaths) {
  const ownerDir = dirname(ownerFile);
  const expand = (p) =>
    p
      .replace('@loader_path', ownerDir)
      .replace('@executable_path', ownerDir);
  if (dep.startsWith('@rpath/')) {
    const tail = dep.slice('@rpath/'.length);
    for (const rp of ownerRpaths) {
      const cand = join(expand(rp), tail);
      if (existsSync(cand)) return cand;
    }
    return null;
  }
  if (dep.startsWith('@loader_path') || dep.startsWith('@executable_path')) {
    const cand = expand(dep);
    return existsSync(cand) ? cand : null;
  }
  return existsSync(dep) ? dep : null;
}

function findSource(dirs, tool) {
  for (const d of dirs) {
    if (!d) continue;
    const p = join(d, tool);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Copy all non-system dylibs the binary needs into libDir (recursive).
 *  Returns a map originalDepString -> bundled basename for rewriting. */
function collectDylibs(binary, libDir) {
  const copied = new Map(); // realSourcePath -> basename
  const rewrite = new Map(); // depString -> basename (per file, applied later)
  const queue = [binary];
  const seen = new Set();

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const rps = rpaths(file);
    for (const dep of directDeps(file)) {
      if (isSystemLib(dep)) continue;
      // self-reference on a dylib's own id line can slip through if it
      // matches; skip deps that point at the file itself.
      const src = resolveDep(dep, file, rps);
      if (!src) {
        console.warn(`    [warn] unresolved dep ${dep} (from ${basename(file)}) — leaving as-is`);
        continue;
      }
      const name = basename(src);
      if (!copied.has(src)) {
        const dest = join(libDir, name);
        copyFileSync(src, dest);
        chmodSync(dest, 0o755);
        copied.set(src, name);
        queue.push(dest); // recurse into the COPIED lib
      }
    }
  }
  return copied;
}

/** Rewrite one Mach-O file so every bundled dep is referenced via
 *  @rpath, and give it the right rpath + (for dylibs) id. */
function relink(file, isDylib, bundledNames) {
  const rps = rpaths(file);
  for (const dep of directDeps(file)) {
    if (isSystemLib(dep)) continue;
    const src = resolveDep(dep, file, rps);
    const name = src ? basename(src) : basename(dep);
    if (bundledNames.has(name)) {
      const target = `@rpath/${name}`;
      if (dep !== target) {
        sh('install_name_tool', ['-change', dep, target, file]);
      }
    }
  }
  if (isDylib) {
    sh('install_name_tool', ['-id', `@rpath/${basename(file)}`, file]);
    // dylibs sit next to each other; look up siblings via @loader_path.
    if (!rps.includes('@loader_path')) {
      try {
        sh('install_name_tool', ['-add_rpath', '@loader_path', file]);
      } catch {
        /* already present */
      }
    }
  } else {
    // binary in bin/ -> libs in ../lib
    if (!rps.includes('@executable_path/../lib')) {
      try {
        sh('install_name_tool', ['-add_rpath', '@executable_path/../lib', file]);
      } catch {
        /* already present */
      }
    }
  }
  // Ad-hoc re-sign: any load-command edit invalidates the signature,
  // and Apple Silicon refuses to run an invalidly-signed Mach-O.
  sh('codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
}

function repackageBundle(key, def) {
  const bundleDir = join(OUT_ROOT, key);
  const binDir = join(bundleDir, 'bin');
  const libDir = join(bundleDir, 'lib');

  // Locate every tool's source before touching the output dir.
  const sources = {};
  for (const tool of def.tools) {
    const src = findSource(def.candidateDirs, tool);
    if (!src) {
      console.warn(
        `  [skip] ${key}: ${tool} not found in ${def.candidateDirs.filter(Boolean).join(', ')}`,
      );
      return { key, ok: false };
    }
    sources[tool] = src;
  }

  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });

  for (const [tool, src] of Object.entries(sources)) {
    const dest = join(binDir, tool);
    copyFileSync(src, dest);
    chmodSync(dest, 0o755);
  }

  // Collect dylibs across ALL tools in the bundle into the shared lib/.
  for (const tool of def.tools) {
    collectDylibs(join(binDir, tool), libDir);
  }

  const bundledNames = new Set(readdirSync(libDir));

  // Relink the copied dylibs first, then the binaries.
  for (const name of bundledNames) relink(join(libDir, name), true, bundledNames);
  for (const tool of def.tools) relink(join(binDir, tool), false, bundledNames);

  console.log(
    `  [done] ${key}: ${def.tools.length} tool(s), ${bundledNames.size} bundled dylib(s) -> ${bundleDir}`,
  );
  return { key, ok: true };
}

function main() {
  const wanted = process.argv.slice(2);
  const keys = wanted.length ? wanted : Object.keys(BUNDLES);
  mkdirSync(OUT_ROOT, { recursive: true });
  console.log(`Repackaging for ${process.arch} macOS`);

  const results = [];
  for (const key of keys) {
    const def = BUNDLES[key];
    if (!def) {
      console.warn(`  [skip] unknown bundle: ${key}`);
      continue;
    }
    try {
      results.push(repackageBundle(key, def));
    } catch (err) {
      console.error(`  [error] ${key}: ${err.message}`);
      results.push({ key, ok: false });
    }
  }

  const ok = results.filter((r) => r.ok).map((r) => r.key);
  console.log(`\nRepackaged: ${ok.length ? ok.join(', ') : '(none)'}`);

  let total = 0;
  for (const key of ok) {
    for (const sub of ['bin', 'lib']) {
      const d = join(OUT_ROOT, key, sub);
      if (existsSync(d)) for (const f of readdirSync(d)) total += statSync(join(d, f)).size;
    }
  }
  if (ok.length) console.log(`Total bundled size: ${(total / 1024 / 1024).toFixed(1)} MB`);
}

main();

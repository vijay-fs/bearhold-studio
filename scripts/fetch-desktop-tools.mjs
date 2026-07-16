#!/usr/bin/env node
// Populate the installer-bundled CLI tools for the desktop app.
//
// Reads the same manifest the runtime uses
// (apps/desktop/src-tauri/src/tools/manifest.json), downloads the
// archive for the CURRENT platform for each bundle, verifies its
// SHA-256, extracts it, and places each advertised binary at:
//
//   apps/desktop/src-tauri/tools/<bundle_key>/bin/<tool>[.exe]
//
// Those files are picked up by `bundle.resources` in tauri.conf.json
// and shipped inside the installer, so end users get working
// export/import with zero local setup.
//
// Run before `tauri build`:  pnpm run desktop:tools
//
// The downloaded binaries are git-ignored (see .gitignore) — this
// script is the reproducible way to regenerate them on any build
// machine. Bundles whose manifest URL is still a placeholder are
// skipped with a warning rather than failing the whole run.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const TAURI_ROOT = join(REPO_ROOT, 'apps', 'desktop', 'src-tauri');
const MANIFEST_PATH = join(TAURI_ROOT, 'src', 'tools', 'manifest.json');
const OUT_ROOT = join(TAURI_ROOT, 'tools');

const IS_WINDOWS = process.platform === 'win32';

/** Map Node's platform/arch to the manifest's platform keys. */
function currentPlatformKey() {
  const os = process.platform; // 'darwin' | 'linux' | 'win32'
  const arch = process.arch; // 'arm64' | 'x64'
  const archKey = arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (os === 'darwin') return `darwin-${archKey}`;
  if (os === 'linux') return `linux-${archKey}`;
  if (os === 'win32') return `windows-${archKey}`;
  throw new Error(`unsupported platform: ${os}/${arch}`);
}

function isPlaceholder(asset) {
  return (
    asset.sha256.toLowerCase().startsWith('todo_') ||
    asset.url.includes('tools.bearhold.studio')
  );
}

async function download(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'bearhold-studio-build/0.0.1' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Extract a tar.gz or zip buffer into `destDir`. Shells out to the
 *  system tar (bsdtar handles zip on macOS/Windows); falls back to
 *  `unzip` for zip archives on Linux where GNU tar can't read them. */
function extract(buf, archiveKind, destDir) {
  mkdirSync(destDir, { recursive: true });
  const tmpArchive = join(destDir, `__archive.${archiveKind === 'zip' ? 'zip' : 'tgz'}`);
  writeFileSync(tmpArchive, buf);
  try {
    if (archiveKind === 'tar.gz') {
      run('tar', ['-xzf', tmpArchive, '-C', destDir]);
    } else {
      // zip
      const tarTried = trySpawn('tar', ['-xf', tmpArchive, '-C', destDir]);
      if (!tarTried) {
        run('unzip', ['-o', '-q', tmpArchive, '-d', destDir]);
      }
    }
  } finally {
    rmSync(tmpArchive, { force: true });
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
  }
}

function trySpawn(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return r.status === 0;
}

/** Recursively find the first file named exactly `name` under `dir`. */
function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

async function fetchBundle(key, bundle, platformKey) {
  const asset = bundle.platforms[platformKey];
  if (!asset) {
    console.warn(`  [skip] ${key}: no asset for ${platformKey}`);
    return { key, ok: false, reason: 'no-asset' };
  }
  if (isPlaceholder(asset)) {
    console.warn(
      `  [skip] ${key}: manifest URL/hash is still a placeholder (${asset.url}). ` +
        `Upload the real artifact and update manifest.json to bundle it.`,
    );
    return { key, ok: false, reason: 'placeholder' };
  }

  console.log(`  [fetch] ${key} v${bundle.tool_version} <- ${asset.url}`);
  const buf = await download(asset.url);

  const actual = sha256Hex(buf);
  if (actual.toLowerCase() !== asset.sha256.toLowerCase()) {
    throw new Error(
      `${key}: SHA-256 mismatch\n    expected ${asset.sha256}\n    actual   ${actual}`,
    );
  }

  const staging = mkdtempSync(join(tmpdir(), `bearhold-tools-${key}-`));
  try {
    extract(buf, asset.archive, staging);

    const binDir = join(OUT_ROOT, key, 'bin');
    rmSync(join(OUT_ROOT, key), { recursive: true, force: true });
    mkdirSync(binDir, { recursive: true });

    for (const tool of bundle.tools) {
      const exeName = IS_WINDOWS ? `${tool}.exe` : tool;
      const src = findFile(staging, exeName);
      if (!src) {
        throw new Error(`${key}: extracted archive is missing ${exeName}`);
      }
      const dest = join(binDir, exeName);
      cpSync(src, dest);
      if (!IS_WINDOWS) {
        // Ensure the executable bit survived; zip on some platforms
        // drops it.
        chmodSync(dest, 0o755);
      }
    }
    console.log(`  [done] ${key}: ${bundle.tools.length} binaries -> ${binDir}`);
    return { key, ok: true, bundle };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Write tools/THIRD_PARTY_NOTICES.md from the license metadata of the
 *  bundles that were actually fetched. Bundled via the resources glob,
 *  so it ships inside the installer and the app can display it under
 *  Help -> Open Source Licenses. */
function writeNotices(okResults, platformKey) {
  if (!okResults.length) return;
  const lines = [];
  lines.push('# Open Source Notices');
  lines.push('');
  lines.push(
    'Bearhold Studio ships the following third-party command-line tools, ' +
      'each as a **separate executable** that the app runs at arm\'s length ' +
      '(a child process). They are aggregated with, not part of, Bearhold ' +
      'Studio, and each remains under its own license below.',
  );
  lines.push('');
  lines.push(`Platform: \`${platformKey}\``);
  lines.push('');

  for (const { key, bundle } of okResults) {
    const lic = bundle.license || {};
    lines.push(`## ${bundle.display_name} (v${bundle.tool_version})`);
    lines.push('');
    lines.push(`- Binaries: ${bundle.tools.map((t) => `\`${t}\``).join(', ')}`);
    lines.push(`- License: ${lic.spdx || 'see upstream'}`);
    if (lic.copyright) lines.push(`- ${lic.copyright}`);
    if (lic.url) lines.push(`- License text: ${lic.url}`);
    lines.push('');
    if (lic.copyleft) {
      // GPLv2 §3 written offer. Must name the corresponding source for
      // the EXACT version shipped.
      lines.push(
        '> **Written offer (GPL):** This binary is licensed under the GNU ' +
          'General Public License. In accordance with its terms, the complete ' +
          'corresponding source code for the version distributed here is ' +
          `available at: ${lic.source_url || '(SET source_url IN manifest.json)'} ` +
          '— or on written request to the address in the application’s ' +
          'About screen, valid for three years from the date of distribution. ' +
          'The binary is distributed unmodified.',
      );
      lines.push('');
      if (!lic.source_url) {
        console.warn(
          `  [warn] ${key}: copyleft bundle has no source_url — the written offer is incomplete.`,
        );
      }
    }
  }

  const notices = join(OUT_ROOT, 'THIRD_PARTY_NOTICES.md');
  writeFileSync(notices, lines.join('\n'));
  console.log(`Wrote notices: ${notices}`);
}

async function main() {
  const onlyKeys = process.argv.slice(2);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const platformKey = currentPlatformKey();
  console.log(`Fetching desktop tools for ${platformKey}`);
  mkdirSync(OUT_ROOT, { recursive: true });

  const results = [];
  for (const [key, bundle] of Object.entries(manifest.bundles)) {
    if (onlyKeys.length && !onlyKeys.includes(key)) continue;
    try {
      results.push(await fetchBundle(key, bundle, platformKey));
    } catch (err) {
      console.error(`  [error] ${key}: ${err.message}`);
      results.push({ key, ok: false, reason: 'error' });
    }
  }

  const okResults = results.filter((r) => r.ok);
  const ok = okResults.map((r) => r.key);
  const skipped = results.filter((r) => !r.ok);

  // Generate the Open Source Notices for everything that actually
  // shipped. This is what makes bundling copyleft tools (GPLv2
  // mysqldump) lawful: it carries the license text + the §3 written
  // offer pointing at the corresponding source.
  writeNotices(okResults, platformKey);
  console.log(`\nBundled: ${ok.length ? ok.join(', ') : '(none)'}`);
  if (skipped.length) {
    console.log(
      `Not bundled: ${skipped
        .map((r) => `${r.key} (${r.reason})`)
        .join(', ')}`,
    );
    console.log(
      'Bundles marked "placeholder" need a real hosted archive + SHA-256 in manifest.json.',
    );
  }

  // Report what will actually ship so a build doesn't silently omit a tool.
  if (existsSync(OUT_ROOT)) {
    let total = 0;
    for (const key of readdirSync(OUT_ROOT)) {
      const binDir = join(OUT_ROOT, key, 'bin');
      if (existsSync(binDir)) {
        for (const f of readdirSync(binDir)) {
          total += statSync(join(binDir, f)).size;
        }
      }
    }
    console.log(`Total bundled size: ${(total / 1024 / 1024).toFixed(1)} MB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

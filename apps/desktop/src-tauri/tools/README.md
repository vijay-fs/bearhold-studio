# Installer-bundled CLI tools

This directory holds the database CLI tools (`pg_dump`, `pg_restore`,
`psql`, `mysqldump`, `mysql`, `sqlite3`) that the Export/Import features
spawn. Shipping them **inside the installer** means end users get
working export/import with **zero local setup** and no network download.

On macOS these are produced by `scripts/repackage-macos-tools.mjs`,
which copies the tool plus its dylibs and rewrites load commands so the
binary runs on a Mac with no Homebrew / vendor install.

## Layout

The runtime (`src/tools/cache.rs::bundled_tool_executable` and
`src/dump/tool_locator.rs`) resolves binaries at:

```
tools/<bundle_key>/bin/<tool>[.exe]
```

e.g. `tools/postgres/bin/pg_dump`, `tools/mysql/bin/mysqldump`.

`bundle.resources` in `tauri.conf.json` copies this whole tree into the
app's resource directory, so at runtime it lands under
`<resource_dir>/tools/...`.

## How binaries get here

They are **not committed** (large, platform-specific, vendor-licensed).
Regenerate them for the current build platform with:

```
pnpm run desktop:tools          # all bundles
node scripts/fetch-desktop-tools.mjs postgres sqlite   # a subset
```

`build:desktop` runs this automatically before `tauri build`.

The script reads `src/tools/manifest.json`, downloads the archive for
the current OS/arch, verifies its SHA-256, and copies the advertised
binaries here.

## Populating the bundles

On the current build machine (macOS), run:

```
node scripts/repackage-macos-tools.mjs        # all: postgres, mysql, sqlite
```

This finds each tool on the machine (Homebrew `libpq` / `mysql-client`,
system `sqlite3`), makes it relocatable, and drops it here. For Linux /
Windows, the `manifest.json` download path (`scripts/fetch-desktop-tools.mjs`)
still applies — its `postgres` / `mysql` URLs are placeholders
(`tools.bearhold.studio`, `TODO_...` hashes) and need real hosted
archives + SHA-256 values before they populate.

## Licensing

Each bundle carries `license` metadata in `manifest.json`
(SPDX id, copyright, license URL, and for copyleft tools a
`source_url`). The fetch script uses it to generate
`tools/THIRD_PARTY_NOTICES.md`, which ships via `bundle.resources` and
is exposed to the UI through the `third_party_notices` Tauri command
(wire it into an "Open Source Licenses" screen under Help/About).

Most tools are permissive and only need attribution:

| Tool | License |
|------|---------|
| pg_dump / pg_restore / psql | PostgreSQL (permissive) |
| sqlite3 | Public domain |

**`mysqldump` / `mysql` are GPL-2.0** — the one copyleft case. Bundling
is lawful because the app runs them as **separate executables at arm's
length** (mere aggregation), so Bearhold Studio itself stays
proprietary. To comply for that binary we must, and the generated
notices already do:

1. Ship the **GPLv2 license text** (linked in the notices).
2. Provide a **written offer** for the complete corresponding source of
   the exact version shipped (`license.source_url` in `manifest.json`).
3. Distribute the binary **unmodified**, notices intact.

Set `mysql.license.source_url` to the exact matching source archive
before shipping. This is general guidance, not legal advice — have
counsel confirm the notices and offer wording. If you'd rather avoid the
obligation entirely, keep only the `mysql` bundle on the
download-on-demand path (the end user's machine fetches it from Oracle
directly, so Bearhold never redistributes it).

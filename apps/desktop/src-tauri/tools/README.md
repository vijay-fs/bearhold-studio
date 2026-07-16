# Installer-bundled CLI tools

This directory holds the database CLI tools (`pg_dump`, `pg_restore`,
`psql`, `mysqldump`, `mysql`, `sqlite3`, `mongodump`, `redis-cli`, ...)
that the Export/Import features spawn. Shipping them **inside the
installer** means end users get working export/import with **zero local
setup** and no network download.

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

## Before this actually ships

The `postgres`, `mysql`, and `redis` bundles in `manifest.json` still
point at placeholder URLs (`tools.bearhold.studio`) with `TODO_...`
SHA-256 values, so the fetch script skips them. To bundle them:

1. Host the real per-platform archives.
2. Put the real URL + SHA-256 in `manifest.json`.
3. Re-run `pnpm run desktop:tools`.

`sqlite` and `mongodb` already point at real vendor URLs (sqlite.org,
fastdl.mongodb.org) and will populate once their SHA-256 values are
filled in.

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
| mongodump etc. | Apache-2.0 |
| redis-cli (Valkey) | BSD-3-Clause |

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

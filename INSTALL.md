# Installing Bearhold Studio

## macOS

Two formats are produced by the build:

- `Bearhold Studio_0.0.1_aarch64.dmg` — drag-to-Applications installer
- `Bearhold Studio-macos-aarch64.zip` — the bundled `.app` zipped, for download-and-run

Either way:

1. Open the file.
2. Drag `Bearhold Studio.app` into `/Applications` (or anywhere — it's
   self-contained).
3. First launch: macOS Gatekeeper will refuse to open it because the app
   isn't signed with an Apple Developer ID. Right-click the app → **Open**,
   then click **Open** in the dialog. macOS remembers this choice; future
   launches start normally.

   Alternative: System Settings → Privacy & Security → scroll to the
   "Bearhold Studio was blocked" line → **Open Anyway**.

Built for Apple Silicon (M1/M2/M3/M4). An Intel `x86_64.dmg` will follow
when there's CI infrastructure to produce it.

## Windows

Produced by the GitHub Actions workflow (`.github/workflows/release.yml`):

- `Bearhold Studio_0.0.1_x64-setup.exe` — NSIS installer (recommended)
- `Bearhold Studio_0.0.1_x64_en-US.msi` — MSI for group-policy /
  enterprise rollout

Either way:

1. Double-click the installer.
2. First launch: Windows SmartScreen shows "Windows protected your PC"
   because the app isn't signed with an EV certificate. Click **More info**
   → **Run anyway**. The warning doesn't return.

## Building from source

Local macOS build:

```sh
cd apps/desktop
pnpm tauri build --bundles dmg,app
```

Outputs land in `target/release/bundle/`.

For Windows builds, run the same command on a Windows host — the
NSIS/WiX bundlers don't cross-compile from macOS. The repo's
`release.yml` workflow does this automatically on a Windows runner;
trigger it from the GitHub Actions tab or push a `v*` tag.

## Signing (not yet configured)

These builds are **unsigned**. For a real release:

- macOS: an Apple Developer ID certificate plus notarization
  (tasks #28 / #29 in the project todo, blocked on the certificate).
- Windows: an EV code-signing certificate so SmartScreen doesn't bug
  users at all (regular CS certs reduce but don't eliminate the
  warning).

Once those certs land, `tauri.conf.json` gets the `signingIdentity`
and the workflow gets the cert secrets — both are documented hooks
Tauri provides natively.

## Upgrade note from earlier `dbstudio` builds

Earlier development builds were named `dbstudio` with bundle ID
`studio.db.app`. macOS treats the renamed app (`studio.bearhold.app`)
as a fresh install — your saved **passwords / SSH credentials** start
empty in the new build and you'll re-enter them on first connect.

Connection profiles themselves (names, hosts, ports, query history,
snippets) live in the webview's localStorage and **do** carry over —
the storage origin is the same.

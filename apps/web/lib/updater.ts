// Frontend wrapper around tauri-plugin-updater + tauri-plugin-process.
//
// Lives behind an `isDesktop` guard because the JS plugin imports
// the Tauri IPC bridge — calling these from a browser build would
// throw on module load. The browser version of the app (Next dev
// at localhost:3000) silently skips update checks.

import { isDesktop } from './runtime';

export interface UpdateInfo {
  available: boolean;
  /** Semver of the new build when one is available; `null` if the
   *  client is already on the latest version. */
  version: string | null;
  /** Human-readable release notes pulled from the latest.json
   *  manifest. May contain Markdown. */
  notes: string | null;
  /** ISO date of the new build, if the manifest set one. */
  pubDate: string | null;
}

/**
 * Ask the updater plugin whether a newer build is available. Returns
 * a normalized info object — `available: false` for both
 * "up-to-date" and "the check failed entirely" so callers can show a
 * single non-blocking UI. The detailed error is logged but not
 * surfaced; users who care can hit the menu item again.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  if (!isDesktop()) {
    return { available: false, version: null, notes: null, pubDate: null };
  }
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) {
      return { available: false, version: null, notes: null, pubDate: null };
    }
    return {
      available: true,
      version: update.version ?? null,
      notes: update.body ?? null,
      pubDate: update.date ?? null,
    };
  } catch (e) {
    console.warn('update check failed', e);
    return { available: false, version: null, notes: null, pubDate: null };
  }
}

/**
 * Download + apply the update, then relaunch the app so the new
 * binary takes over. Progress is reported through the optional
 * `onProgress` callback as (bytesSoFar, totalBytes|undefined) so the
 * UI can render a progress bar; on platforms where the total isn't
 * known up front (rare), `totalBytes` stays undefined.
 *
 * Throws on failure — the caller should catch and show a toast.
 */
export async function downloadAndInstall(
  onProgress?: (downloaded: number, total: number | undefined) => void,
): Promise<void> {
  if (!isDesktop()) {
    throw new Error('Updates are only available in the desktop build.');
  }
  const { check } = await import('@tauri-apps/plugin-updater');
  const { relaunch } = await import('@tauri-apps/plugin-process');
  const update = await check();
  if (!update) return;

  let downloaded = 0;
  let contentLength: number | undefined;
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      contentLength = event.data.contentLength;
      onProgress?.(0, contentLength);
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength;
      onProgress?.(downloaded, contentLength);
    } else if (event.event === 'Finished') {
      onProgress?.(contentLength ?? downloaded, contentLength);
    }
  });
  await relaunch();
}

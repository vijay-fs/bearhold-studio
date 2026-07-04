// Cached view of "which tool bundles are installed on this machine?".
//
// Backed by the `list_tool_bundles` Tauri command, refreshed on
// demand. The Export and Import pages consult this before rendering
// the workflow — no bundle installed → show the ToolInstallPrompt;
// installed → straight to the options form.
//
// Progress events from the Rust downloader (`dbstudio://tool/progress`)
// are also tracked here so a single active install feeds both the
// prompt UI and any listeners.

import { create } from 'zustand';

import { api } from '@/lib/api';
import type { ToolBundleStatus, ToolProgress } from '@/lib/tools';

interface ToolCacheState {
  bundles: ToolBundleStatus[];
  loading: boolean;
  error: string | null;
  /** Per-bundle download progress, keyed by bundle_key. Cleared to
   *  null when done. */
  progress: Record<string, ToolProgress | null>;
  refresh: () => Promise<void>;
  install: (bundleKey: string) => Promise<ToolBundleStatus>;
  uninstall: (bundleKey: string) => Promise<void>;
  applyProgress: (event: ToolProgress) => void;
  getByEngine: (engine: string) => ToolBundleStatus | undefined;
}

export const useToolCache = create<ToolCacheState>((set, get) => ({
  bundles: [],
  loading: false,
  error: null,
  progress: {},

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const bundles = await api.listToolBundles();
      set({ bundles, loading: false });
    } catch (e: unknown) {
      const err = e as { message?: string };
      set({ loading: false, error: err.message ?? String(e) });
    }
  },

  install: async (bundleKey) => {
    // Kick off; progress events arrive via the applyProgress hook
    // wired up in ToolInstallPrompt's listener.
    set((s) => ({
      progress: {
        ...s.progress,
        [bundleKey]: { bundle_key: bundleKey, phase: 'downloading', downloaded: 0, total: 0 },
      },
    }));
    try {
      const result = await api.installToolBundle(bundleKey);
      // Merge the returned status into the cached list.
      set((s) => ({
        bundles: s.bundles.map((b) => (b.bundle_key === bundleKey ? result : b)),
        progress: { ...s.progress, [bundleKey]: null },
      }));
      return result;
    } catch (e) {
      set((s) => ({ progress: { ...s.progress, [bundleKey]: null } }));
      throw e;
    }
  },

  uninstall: async (bundleKey) => {
    await api.uninstallToolBundle(bundleKey);
    // Full refresh — cheaper than trying to reconstruct the record
    // ourselves and less likely to drift from the source of truth.
    await get().refresh();
  },

  applyProgress: (event) => {
    set((s) => ({
      progress: { ...s.progress, [event.bundle_key]: event },
    }));
  },

  getByEngine: (engine) =>
    get().bundles.find((b) => b.covers_engines.includes(engine)),
}));

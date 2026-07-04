// Runtime platform detection + user-facing shortcut labels.
//
// The palette binding itself is Cmd on macOS and Ctrl elsewhere — we
// listen for both `metaKey` and `ctrlKey` in the handler, so the
// SHORTCUT model is the same everywhere; only the LABEL differs.
// This module exists so every place that renders a hint ("Press ⌘K
// for the palette") stays in sync — no per-component OS sniffing.

/** True when we're on macOS. `navigator.platform` is deprecated but
 *  still the most reliable pre-hydration signal we have; `navigator
 *  .userAgentData` is Chromium-only. We accept the deprecation
 *  because the value is stable across the app's lifetime. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const p = navigator.platform || '';
  const ua = navigator.userAgent || '';
  return /Mac|iPhone|iPad|iPod/i.test(p) || /Mac OS X/i.test(ua);
}

/** OS-appropriate label for the modifier that maps to `Cmd` on macOS
 *  and `Ctrl` everywhere else. Renders as the ⌘ glyph on macOS to
 *  match system convention. */
export function modKeyLabel(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl';
}

/** Compose a full shortcut label, e.g. `⌘K` on macOS, `Ctrl+K`
 *  otherwise. Multi-key chords accept an array of extra tokens. */
export function shortcutLabel(...keys: string[]): string {
  const mac = isMacPlatform();
  const parts = keys.map((k) => k.toUpperCase());
  return mac ? `${modKeyLabel()}${parts.join('')}` : `${modKeyLabel()}+${parts.join('+')}`;
}

/** True when the given keyboard event carries the primary modifier —
 *  Meta on macOS, Ctrl elsewhere. Used by keybinding handlers so we
 *  bind ONCE and the user gets the platform-native key without a
 *  per-OS `if`. */
export function hasModKey(e: {
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return isMacPlatform() ? e.metaKey : e.ctrlKey;
}

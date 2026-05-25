'use client';

// Tiny theme controller. Two states (light / dark), persisted in
// localStorage, applied by toggling the `.dark` class on <html>. A
// pre-paint script lives inline in app/layout.tsx (the layout is a
// Server Component and can't import this module's hooks at all) and
// reads the same `dbstudio.theme` key synchronously so the page never
// flashes the wrong theme on cold load. The two stay in sync because
// both use the constant exported below.

import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'dbstudio.theme';
const STORAGE_KEY = THEME_STORAGE_KEY;

/** Read the persisted theme, falling back to the OS preference. SSR-safe
 *  — returns 'light' during server render so React's hydration matches
 *  the pre-paint script (which also defaults to light when no value is
 *  stored and no OS pref is detectable). */
export function readTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** Apply a theme to the document root and persist it. */
export function setTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
  window.localStorage.setItem(STORAGE_KEY, theme);
}

/** Reactive variant of `readTheme` — subscribes to `.dark` class flips on
 *  <html> via a MutationObserver, so components that branch on theme
 *  (Monaco syntax theme, AG Grid theme params) update live without
 *  needing a remount. SSR-safe: defaults to 'light' until mount. */
export function useTheme(): Theme {
  const [theme, setT] = useState<Theme>('light');
  useEffect(() => {
    const read = (): Theme =>
      document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    setT(read());
    const observer = new MutationObserver(() => setT(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}


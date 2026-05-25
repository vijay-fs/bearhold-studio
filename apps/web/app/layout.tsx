import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Pre-paint theme application — inlined here (rather than imported from
// lib/theme) because this file is a Server Component and lib/theme is
// marked 'use client' for its hooks. Keep the storage key in sync with
// `THEME_STORAGE_KEY` in lib/theme.ts.
const NO_FLASH_SCRIPT = `
(function(){try{var t=localStorage.getItem('dbstudio.theme');if(!t){t=matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}if(t==='dark'){document.documentElement.classList.add('dark');}}catch(e){}})();
`;

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'dbstudio',
  description: 'Cross-platform database management studio.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Pre-paint theme application — read the stored preference and
            add `.dark` to <html> before any styled content renders, so
            users on dark mode never see a white flash on cold load. */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}

'use client';

// Open Source Licenses.
//
// Shows the third-party notices for the CLI tools bundled inside the
// installer (pg_dump, mysqldump, ...). The content is generated at
// build time by scripts/fetch-desktop-tools.mjs into
// tools/THIRD_PARTY_NOTICES.md, shipped via `bundle.resources`, and
// read here through the `third_party_notices` Tauri command.
//
// Displaying these notices in-app is part of honouring the tools'
// licenses — in particular the GPLv2 written offer for the MySQL
// client, which must be reachable by the user.

import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, Scale } from 'lucide-react';

import { AppShell } from '@/components/AppShell';
import { api } from '@/lib/api';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; notices: string }
  | { status: 'empty' }
  | { status: 'error'; message: string };

export default function LicensesPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const notices = await api.thirdPartyNotices();
        if (cancelled) return;
        setState(
          notices && notices.trim()
            ? { status: 'ready', notices }
            : { status: 'empty' },
        );
      } catch (e: unknown) {
        if (cancelled) return;
        const err = e as { message?: string };
        setState({ status: 'error', message: err.message ?? String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl space-y-5 p-6">
        <header className="flex items-center gap-3 border-b pb-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Scale className="h-4.5 w-4.5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Open Source Licenses</h1>
            <p className="text-xs text-muted-foreground">
              Third-party tools bundled with Bearhold Studio and the licenses
              they ship under.
            </p>
          </div>
        </header>

        {state.status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading notices…
          </div>
        )}

        {state.status === 'empty' && (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            No bundled tools in this build. When the export/import tools are
            bundled into the installer, their license notices appear here.
          </p>
        )}

        {state.status === 'error' && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{state.message}</span>
          </div>
        )}

        {state.status === 'ready' && <NoticesMarkdown source={state.notices} />}
      </div>
    </AppShell>
  );
}

/** Minimal renderer for the notices markdown. The generator only emits
 *  a small, known subset — `#`/`##` headings, `-` list items, `>`
 *  blockquotes, and paragraphs — so a full markdown library would be
 *  overkill. Bare URLs are turned into clickable links; nothing else
 *  is interpreted, which also keeps the surface free of injected HTML. */
function NoticesMarkdown({ source }: { source: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = source.split('\n');

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) return;

    if (line.startsWith('## ')) {
      blocks.push(
        <h2 key={i} className="mt-6 text-sm font-semibold text-foreground">
          {line.slice(3)}
        </h2>,
      );
    } else if (line.startsWith('# ')) {
      blocks.push(
        <h1 key={i} className="text-base font-semibold text-foreground">
          {line.slice(2)}
        </h1>,
      );
    } else if (line.startsWith('> ')) {
      blocks.push(
        <blockquote
          key={i}
          className="rounded-md border-l-2 border-amber-500/50 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
        >
          {linkify(stripEmphasis(line.slice(2)))}
        </blockquote>,
      );
    } else if (line.startsWith('- ')) {
      blocks.push(
        <p key={i} className="ml-3 text-xs text-muted-foreground">
          <span className="mr-1.5 text-muted-foreground/50">•</span>
          {linkify(stripEmphasis(line.slice(2)))}
        </p>,
      );
    } else {
      blocks.push(
        <p key={i} className="text-xs leading-relaxed text-muted-foreground">
          {linkify(stripEmphasis(line))}
        </p>,
      );
    }
  });

  return <div className="space-y-1.5">{blocks}</div>;
}

/** Drop `**bold**` markers — we don't render emphasis, just the text. */
function stripEmphasis(text: string): string {
  return text.replace(/\*\*/g, '');
}

/** Turn bare http(s) URLs into clickable links. */
function linkify(text: string): React.ReactNode {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      >
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

'use client';

// Cmd+/ help sheet. Listed bindings are static — if you add a new one
// somewhere in the app, mirror it here so the user can discover it.

import { useEffect, useState } from 'react';
import { Keyboard } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { isMacPlatform } from '@/lib/platform';

interface Binding {
  keys: string[];
  description: string;
}

interface Group {
  label: string;
  items: Binding[];
}

/** Renders a single key as a styled <kbd>. Tokens are normalized so
 *  "Cmd" displays the platform glyph on macOS and the word elsewhere.
 *  We compute the platform label in a mount effect so the initial
 *  SSR-safe render is stable — otherwise a Linux/Windows user would
 *  flash the ⌘ glyph before hydration corrects it. */
function Key({ token }: { token: string }) {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    setMac(isMacPlatform());
  }, []);
  const display =
    token === 'Cmd' ? (mac ? '⌘' : 'Ctrl') : token === 'Shift' ? '⇧' : token;
  return (
    <kbd className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border bg-muted/60 px-1.5 font-mono text-[10px] font-medium">
      {display}
    </kbd>
  );
}

const GROUPS: Group[] = [
  {
    label: 'Global',
    items: [
      { keys: ['Cmd', 'K'], description: 'Open command palette' },
      { keys: ['Cmd', '/'], description: 'Show this shortcuts dialog' },
    ],
  },
  {
    label: 'SQL editor',
    items: [
      { keys: ['Cmd', 'Enter'], description: 'Run the selection (or whole buffer)' },
      { keys: ['Cmd', 'Shift', 'F'], description: 'Format SQL' },
    ],
  },
  {
    label: 'Tabs',
    items: [
      { keys: ['Cmd', 'T'], description: 'New tab' },
      { keys: ['Cmd', 'W'], description: 'Close active tab' },
      { keys: ['Cmd', '1'], description: 'Switch to tab 1 (… up to Cmd+9)' },
    ],
  },
  {
    label: 'Result grid',
    items: [
      { keys: ['Enter'], description: 'Move down after editing' },
      { keys: ['Tab'], description: 'Move right after editing' },
      { keys: ['F2'], description: 'Edit focused cell' },
    ],
  },
];

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);

  // Global listener. `Cmd+/` on macOS, `Ctrl+/` on Linux/Windows. We
  // ignore the event when the user is in a text field — Monaco
  // intercepts its own `Cmd+/` for line-comment toggle and `?` typed
  // into search inputs shouldn't open us.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (!cmd || e.key !== '/') return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return;
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-4 w-4" />
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>
            Press <Key token="Cmd" /> <Key token="/" /> any time to open this
            reference.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {GROUPS.map((group) => (
            <section key={group.label}>
              <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.label}
              </h3>
              <ul className="space-y-1">
                {group.items.map((b) => (
                  <li
                    key={b.description}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="text-foreground/90">{b.description}</span>
                    <span className="flex items-center gap-1">
                      {b.keys.map((k, i) => (
                        <Key key={i} token={k} />
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

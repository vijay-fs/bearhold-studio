'use client';

// Import dialog for connection-credential files. Two input modes —
// paste content into a textarea, or pick a file via <input type="file">.
// The format is auto-detected (TablePlus JSON vs .pgpass) and the user
// reviews/picks profiles before any of them land in the connections
// store. Passwords are NOT carried through; the user re-enters them in
// the connection form after import.

import { useMemo, useRef, useState } from 'react';
import { Upload, FileInput } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useConnections } from '@/store/connections';
import { newProfile } from '@/store/connections';
import {
  detectAndParse,
  type ImportedProfile,
} from '@/lib/importConnections';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportConnectionsDialog({ open, onOpenChange }: Props) {
  const upsert = useConnections((s) => s.upsert);
  const [text, setText] = useState('');
  /** Which detected profiles the user has unchecked. Default is "all
   *  selected" — the dialog leans optimistic since the user's already
   *  said they want to import these. */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => detectAndParse(text), [text]);

  const handleFile = async (file: File) => {
    const content = await file.text();
    setText(content);
    setExcluded(new Set());
  };

  const reset = () => {
    setText('');
    setExcluded(new Set());
    if (fileRef.current) fileRef.current.value = '';
  };

  const apply = () => {
    if (!parsed) return;
    for (const p of parsed) {
      const key = profileKey(p);
      if (excluded.has(key)) continue;
      // Build a real `ConnectionProfile` from the imported sketch — uses
      // newProfile() for sensible defaults (id, options, etc.) then
      // overrides the fields we have.
      const base = newProfile(p.engine);
      upsert({
        ...base,
        name: p.name,
        engine: p.engine,
        host: p.host,
        port: p.port,
        database: p.database,
        auth: {
          kind: 'password',
          username: p.username,
          // password_ref left empty — user sets the password from the
          // connection form after import.
          password_ref: '',
        },
      });
    }
    onOpenChange(false);
    setTimeout(reset, 200);
  };

  const selectableCount = parsed?.length ?? 0;
  const selectedCount = parsed
    ? parsed.filter((p) => !excluded.has(profileKey(p))).length
    : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTimeout(reset, 200);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileInput className="h-4 w-4" />
            Import connections
          </DialogTitle>
          <DialogDescription>
            Paste the contents of <code>~/.pgpass</code> or a TablePlus JSON
            export, or pick the file. Passwords are not imported — you set
            them after the profile lands.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".pgpass,.json,.tpconnections,application/json,text/plain"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
              className="text-xs file:mr-2 file:rounded file:border file:bg-muted file:px-2 file:py-1 file:text-xs"
            />
            <span className="text-[10px] text-muted-foreground">
              or paste below
            </span>
          </div>

          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setExcluded(new Set());
            }}
            placeholder={
              '# .pgpass example\nlocalhost:5432:myapp:appuser:redacted\n\n# or paste TablePlus JSON here'
            }
            className="scrollbar-thin h-32 w-full resize-y rounded border border-input bg-background p-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
          />

          {text.trim() && parsed === null && (
            <p className="text-xs text-destructive">
              Couldn&apos;t parse this as `.pgpass` or TablePlus JSON. Check
              the file&apos;s format and try again.
            </p>
          )}

          {parsed && parsed.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No importable profiles found.
            </p>
          )}

          {parsed && parsed.length > 0 && (
            <div className="rounded border">
              <div className="border-b bg-muted/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Detected · {parsed[0]!.source === 'pgpass' ? '.pgpass' : 'TablePlus'} · {selectedCount}/{selectableCount} selected
              </div>
              <ul className="max-h-[260px] overflow-y-auto divide-y">
                {parsed.map((p) => {
                  const key = profileKey(p);
                  const selected = !excluded.has(key);
                  return (
                    <li key={key} className="flex items-start gap-2 px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(e) => {
                          setExcluded((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.delete(key);
                            else next.add(key);
                            return next;
                          });
                        }}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium">{p.name}</div>
                        <div className="truncate text-[10px] text-muted-foreground">
                          {p.engine} · {p.username}@{p.host}:{p.port}/{p.database}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={selectedCount === 0}>
            <Upload className="h-3.5 w-3.5" />
            Import {selectedCount} profile{selectedCount === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Stable identity for a detected profile. We can't use `name` because
 *  pgpass entries with `*` host produce identical names; combining the
 *  user-visible fields gives every row a unique key. */
function profileKey(p: ImportedProfile): string {
  return `${p.source}|${p.engine}|${p.host}|${p.port}|${p.database}|${p.username}`;
}

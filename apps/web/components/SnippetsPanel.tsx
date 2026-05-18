'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bookmark, Copy, Pencil, Play, Search, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSnippets, type SqlSnippet } from '@/store/snippets';

interface Props {
  connectionId: string;
  /** Replace the editor buffer with this SQL (typically opens a new tab). */
  onLoad: (sql: string, name: string) => void;
  /** Run the snippet immediately (also loads into a tab). */
  onRerun: (sql: string, name: string) => void;
}

export function SnippetsPanel({ connectionId, onLoad, onRerun }: Props) {
  const allEntries = useSnippets((s) => s.entries);
  const rename = useSnippets((s) => s.rename);
  const remove = useSnippets((s) => s.remove);

  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState<SqlSnippet | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [pendingDelete, setPendingDelete] = useState<SqlSnippet | null>(null);

  const entries = useMemo(() => {
    const forConn = allEntries.filter((e) => e.connectionId === connectionId);
    if (!filter.trim()) return forConn;
    const needle = filter.toLowerCase();
    return forConn.filter(
      (e) => e.name.toLowerCase().includes(needle) || e.sql.toLowerCase().includes(needle),
    );
  }, [allEntries, connectionId, filter]);

  const hasAny = allEntries.some((e) => e.connectionId === connectionId);

  if (!hasAny) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="text-xs text-muted-foreground">
          No saved snippets yet. Click <Bookmark className="inline h-3 w-3" />{' '}
          <span className="font-medium">Save</span> in the editor toolbar to bookmark
          the current query.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter snippets…"
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="p-4 text-xs text-muted-foreground">No matches.</p>
      ) : (
        <ul className="flex-1 divide-y overflow-y-auto">
          {entries.map((snippet) => (
            <SnippetRow
              key={snippet.id}
              snippet={snippet}
              onLoad={() => onLoad(snippet.sql, snippet.name)}
              onRerun={() => onRerun(snippet.sql, snippet.name)}
              onRename={() => {
                setRenaming(snippet);
                setRenameDraft(snippet.name);
              }}
              onDelete={() => setPendingDelete(snippet)}
            />
          ))}
        </ul>
      )}

      <Dialog open={renaming != null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename snippet</DialogTitle>
          </DialogHeader>
          <Input
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            placeholder="Snippet name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renaming) {
                rename(renaming.id, renameDraft);
                setRenaming(null);
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (renaming) rename(renaming.id, renameDraft);
                setRenaming(null);
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingDelete != null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete snippet</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{pendingDelete?.name}</span>{' '}
              will be removed from this device. The SQL text is not stored anywhere else.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingDelete) remove(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SnippetRow({
  snippet,
  onLoad,
  onRerun,
  onRename,
  onDelete,
}: {
  snippet: SqlSnippet;
  onLoad: () => void;
  onRerun: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const preview = snippet.sql
    .split('\n')
    .filter((l) => l.trim().length > 0 && !l.trim().startsWith('--'))
    .slice(0, 2)
    .join(' ⏎ ')
    .slice(0, 200);

  return (
    <li
      className="group cursor-pointer px-3 py-2 hover:bg-accent/50"
      onClick={onLoad}
    >
      <div className="flex items-start gap-2">
        <Bookmark className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{snippet.name}</div>
          {preview && (
            <code className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
              {preview}
            </code>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <IconBtn
            title="Copy SQL"
            onClick={(e) => {
              e.stopPropagation();
              void navigator.clipboard.writeText(snippet.sql);
            }}
          >
            <Copy className="h-3 w-3" />
          </IconBtn>
          <IconBtn
            title="Re-run"
            onClick={(e) => {
              e.stopPropagation();
              onRerun();
            }}
          >
            <Play className="h-3 w-3" />
          </IconBtn>
          <IconBtn
            title="Rename"
            onClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
          >
            <Pencil className="h-3 w-3" />
          </IconBtn>
          <IconBtn
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="h-3 w-3" />
          </IconBtn>
        </div>
      </div>
    </li>
  );
}

function IconBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
    >
      {children}
    </button>
  );
}

// X icon imported earlier; export a thin save dialog used by the SQL toolbar.
export function SaveSnippetDialog({
  open,
  initialName,
  onSave,
  onCancel,
}: {
  open: boolean;
  initialName: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);

  // Reset to initial whenever the dialog (re)opens. Keeps the toolbar
  // free of an extra piece of state and avoids stale drafts across opens.
  useEffect(() => {
    if (open) setName(initialName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save snippet</DialogTitle>
          <DialogDescription>
            Give this query a name so it shows up in the Snippets panel and the
            command palette.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. inactive users last 30 days"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) {
              onSave(name);
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onSave(name)} disabled={!name.trim()}>
            <Bookmark className="h-3.5 w-3.5" />
            Save snippet
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


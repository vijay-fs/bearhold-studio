'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import {
  Database,
  Plus,
  Workflow,
  Terminal as TerminalIcon,
  Pencil,
  Trash2,
} from 'lucide-react';

import { useConnections } from '@/store/connections';
import { ENGINE_LABELS } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CommandPalette } from '@/components/CommandPalette';

export function AppShell({ children }: { children: React.ReactNode }) {
  const profiles = useConnections((s) => s.profiles);
  const remove = useConnections((s) => s.remove);
  const pathname = usePathname();
  const router = useRouter();

  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(
    null,
  );

  const askDelete = (id: string, name: string) => {
    setPendingDelete({ id, name });
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { id } = pendingDelete;
    try {
      const { api } = await import('@/lib/api');
      await api.deleteSecrets(id);
    } catch {
      // Best-effort secret cleanup — profile delete still proceeds.
    }
    remove(id);
    setPendingDelete(null);
    if (pathname?.startsWith(`/connections/${id}`)) {
      router.push('/connections' as Route);
    }
  };

  return (
    <div className="grid h-screen grid-cols-[260px_1fr] bg-background">
      <aside className="flex flex-col border-r bg-secondary/30">
        <div className="flex items-center gap-2 border-b px-5 py-3.5">
          <Database className="h-5 w-5 text-primary" />
          <span className="text-sm font-semibold tracking-tight">dbstudio</span>
        </div>

        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Connections
          </span>
          <Link
            href="/connections/new"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            aria-label="Add connection"
          >
            <Plus className="h-3.5 w-3.5" />
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {profiles.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No connections yet. Click + to add one.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {profiles.map((p) => {
                const href = `/connections/${p.id}/schema` as Route;
                const active = pathname?.startsWith(`/connections/${p.id}`);
                return (
                  <li key={p.id}>
                    <Link
                      href={href}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs',
                        active
                          ? 'bg-background font-medium text-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      <Database className="h-3.5 w-3.5 shrink-0" />
                      <span className="flex-1 truncate">{p.name}</span>
                      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                        {ENGINE_LABELS[p.engine]}
                      </span>
                    </Link>
                    {active && (
                      <ul className="mt-0.5 ml-7 space-y-0.5">
                        <SubNavLink
                          href={`/connections/${p.id}/schema` as Route}
                          icon={<Workflow className="h-3 w-3" />}
                          label="Schema"
                          active={pathname === `/connections/${p.id}/schema`}
                        />
                        <SubNavLink
                          href={`/connections/${p.id}/sql` as Route}
                          icon={<TerminalIcon className="h-3 w-3" />}
                          label="SQL"
                          active={pathname === `/connections/${p.id}/sql`}
                        />
                        <SubNavLink
                          href={`/connections/${p.id}/edit` as Route}
                          icon={<Pencil className="h-3 w-3" />}
                          label="Edit"
                          active={pathname === `/connections/${p.id}/edit`}
                        />
                        <li>
                          <button
                            type="button"
                            onClick={() => askDelete(p.id, p.name)}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3" />
                            <span>Delete</span>
                          </button>
                        </li>
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <div className="border-t px-5 py-2.5 text-[10px] text-muted-foreground">
          Phase 1 · local-only · unsigned build
        </div>
      </aside>

      <main className="flex min-h-0 flex-col overflow-y-auto">{children}</main>

      <Dialog
        open={pendingDelete != null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete connection</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{pendingDelete?.name}</span>{' '}
              will be removed from this device. Its saved password and any SSH credentials
              in the OS keychain are also deleted. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete connection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CommandPalette />
    </div>
  );
}

function SubNavLink({
  href,
  icon,
  label,
  active,
}: {
  href: Route;
  icon: React.ReactNode;
  label: string;
  active: boolean;
}) {
  return (
    <li>
      <Link
        href={href}
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1 text-[11px]',
          active
            ? 'text-foreground font-medium'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {icon}
        <span>{label}</span>
      </Link>
    </li>
  );
}

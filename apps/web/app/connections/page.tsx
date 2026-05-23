'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Database, Plus, FileInput } from 'lucide-react';

import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { ImportConnectionsDialog } from '@/components/ImportConnectionsDialog';
import { useConnections } from '@/store/connections';
import { ENGINE_LABELS } from '@/lib/types';

export default function ConnectionsPage() {
  const profiles = useConnections((s) => s.profiles);
  const [importOpen, setImportOpen] = useState(false);

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {profiles.length} saved on this device.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <FileInput className="h-4 w-4" />
              Import
            </Button>
            <Button asChild>
              <Link href="/connections/new">
                <Plus className="h-4 w-4" />
                Add connection
              </Link>
            </Button>
          </div>
        </header>

        {profiles.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-card px-6 py-14 text-center">
            <Database className="mx-auto h-8 w-8 text-muted-foreground" />
            <h2 className="mt-4 text-base font-semibold">No connections yet</h2>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              Add a PostgreSQL connection to view its schema as an ER diagram and run SQL
              against it.
            </p>
            <Button className="mt-5" asChild>
              <Link href="/connections/new">Add your first connection</Link>
            </Button>
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {profiles.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/connections/${p.id}/schema`}
                  className="block rounded-lg border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-accent/50"
                >
                  <div className="mb-2 flex items-center gap-2">
                    <Database className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">{p.name}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {ENGINE_LABELS[p.engine]} · {p.host}:{p.port}/{p.database}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ImportConnectionsDialog open={importOpen} onOpenChange={setImportOpen} />
    </AppShell>
  );
}

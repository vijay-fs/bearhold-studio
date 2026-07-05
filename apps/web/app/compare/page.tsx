'use client';

// Merged Compare workspace. Replaces the separate /diff and /data-diff
// pages. Shared top-level connection picker feeds both a Schema tab
// (DDL) and a Tables tab (row-level DML), so the user picks their
// connection pair ONCE and can move between the two comparisons
// without re-selecting anything.
//
// Deep link:  /compare?src=<uuid>&tgt=<uuid>&tab=schema|tables

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { GitCompare, Rows3 } from 'lucide-react';

import { AppShell } from '@/components/AppShell';
import { CompareTopBar } from '@/components/compare/CompareTopBar';
import { SchemaDiffPanel } from '@/components/compare/SchemaDiffPanel';
import { DataDiffPanel } from '@/components/compare/DataDiffPanel';
import { useConnections } from '@/store/connections';
import { cn } from '@/lib/utils';

type Tab = 'schema' | 'tables';

function ComparePageInner() {
  const profiles = useConnections((s) => s.profiles);
  const searchParams = useSearchParams();
  const router = useRouter();

  // Support both old param names (cid/tab) for backwards compat with
  // links out of the sidebar + palette that pre-date the merge.
  const [sourceId, setSourceId] = useState(
    () => searchParams.get('src') ?? searchParams.get('cid') ?? '',
  );
  const [targetId, setTargetId] = useState(() => searchParams.get('tgt') ?? '');
  const initialTab = (searchParams.get('tab') as Tab) || 'schema';
  const [tab, setTab] = useState<Tab>(
    initialTab === 'tables' ? 'tables' : 'schema',
  );

  const source = profiles.find((p) => p.id === sourceId);
  const target = profiles.find((p) => p.id === targetId);

  // Reflect state → URL so back/forward works and the link is
  // shareable. Uses `replace` so we don't spam history for every
  // combobox change.
  useEffect(() => {
    const params = new URLSearchParams();
    if (sourceId) params.set('src', sourceId);
    if (targetId) params.set('tgt', targetId);
    params.set('tab', tab);
    router.replace(`/compare?${params.toString()}` as never, { scroll: false });
  }, [sourceId, targetId, tab, router]);

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-hidden">
        <div className="scrollbar-thin flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-6">
            <header>
              <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                <GitCompare className="h-5 w-5" />
                Compare
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Diff two connections. Apply the generated SQL to bring the
                source in line with the target.
              </p>
            </header>

            <CompareTopBar
              sourceId={sourceId}
              targetId={targetId}
              onSourceChange={setSourceId}
              onTargetChange={setTargetId}
              profiles={profiles}
              restrictToSourceEngine={tab === 'tables'}
            />

            <TabStrip active={tab} onChange={setTab} />

            {tab === 'schema' ? (
              <SchemaDiffPanel source={source} target={target} />
            ) : (
              <DataDiffPanel source={source} target={target} />
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function TabStrip({
  active,
  onChange,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b">
      <TabButton
        active={active === 'schema'}
        onClick={() => onChange('schema')}
        icon={<GitCompare className="h-3.5 w-3.5" />}
        label="Schema"
        detail="Structural — DDL"
      />
      <TabButton
        active={active === 'tables'}
        onClick={() => onChange('tables')}
        icon={<Rows3 className="h-3.5 w-3.5" />}
        label="Tables"
        detail="Row data — DML"
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  detail,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      <span
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md transition',
          active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span className="text-left">
        <span className="block font-semibold">{label}</span>
        <span className="block text-[10px] text-muted-foreground/80">{detail}</span>
      </span>
    </button>
  );
}

export default function ComparePage() {
  return (
    <Suspense fallback={null}>
      <ComparePageInner />
    </Suspense>
  );
}

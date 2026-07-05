'use client';

// Shared top bar for the /compare workspace.
//
// Owns the source + target connection pickers, the swap-sides button,
// and the engine/version chips that give users at-a-glance context
// about what they're comparing ("PG 16.4 ↔ PG 17.0"). Emits changes
// through props so both the schema and data tabs see the same pair
// without wiring their own pickers.

import { ArrowLeftRight } from 'lucide-react';

import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { ENGINE_LABELS, type ConnectionProfile } from '@/lib/types';
import { useServerInfoCache } from '@/store/serverInfoCache';
import { cn } from '@/lib/utils';

interface CompareTopBarProps {
  sourceId: string;
  targetId: string;
  onSourceChange: (id: string) => void;
  onTargetChange: (id: string) => void;
  profiles: ConnectionProfile[];
  /** Only offer target connections that share the source's engine.
   *  Cross-engine diff never produces useful SQL. */
  restrictToSourceEngine?: boolean;
}

export function CompareTopBar({
  sourceId,
  targetId,
  onSourceChange,
  onTargetChange,
  profiles,
  restrictToSourceEngine = false,
}: CompareTopBarProps) {
  const sourceProfile = profiles.find((p) => p.id === sourceId);
  const targetProfile = profiles.find((p) => p.id === targetId);
  const sameProfile = sourceId && sourceId === targetId;

  const targetProfiles =
    restrictToSourceEngine && sourceProfile
      ? profiles.filter(
          (p) => p.engine === sourceProfile.engine && p.id !== sourceProfile.id,
        )
      : profiles.filter((p) => p.id !== sourceId);

  const swap = () => {
    const s = sourceId;
    onSourceChange(targetId);
    onTargetChange(s);
  };

  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
        <SideSlot
          label="Source (will receive changes)"
          value={sourceId}
          profile={sourceProfile}
          onChange={onSourceChange}
          profiles={profiles}
        />
        <button
          type="button"
          onClick={swap}
          disabled={!sourceId || !targetId}
          className="mx-auto inline-flex h-8 w-8 items-center justify-center rounded-full border bg-background text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:opacity-40"
          aria-label="Swap source and target"
          title="Swap sides"
        >
          <ArrowLeftRight className="h-3.5 w-3.5" />
        </button>
        <SideSlot
          label="Target (desired state)"
          value={targetId}
          profile={targetProfile}
          onChange={onTargetChange}
          profiles={targetProfiles}
        />
      </div>
      {sameProfile && (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          Source and target are the same connection — nothing to compare.
        </p>
      )}
    </div>
  );
}

function SideSlot({
  label,
  value,
  profile,
  onChange,
  profiles,
}: {
  label: string;
  value: string;
  profile: ConnectionProfile | undefined;
  onChange: (id: string) => void;
  profiles: ConnectionProfile[];
}) {
  const version = useServerInfoCache((s) =>
    profile ? s.entries[profile.id]?.version ?? null : null,
  );
  const options: ComboboxOption[] = profiles.map((p) => ({
    value: p.id,
    label: p.name,
    hint: ENGINE_LABELS[p.engine],
    keywords: [p.engine, p.host, p.database].filter(Boolean) as string[],
  }));

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <Combobox
        value={value}
        onChange={onChange}
        options={options}
        placeholder="— pick a connection —"
        emptyLabel="No matching connections."
      />
      {profile && (
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
          <span
            className={cn(
              'inline-flex items-center rounded px-1.5 py-0.5 font-semibold uppercase tracking-wider ring-1 ring-inset',
              engineChip(profile.engine),
            )}
          >
            {ENGINE_LABELS[profile.engine]}
          </span>
          {version?.raw && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
              v{version.raw.split(' ')[0]}
            </span>
          )}
          <span className="truncate">
            {profile.database ? `${profile.host} · ${profile.database}` : profile.host}
          </span>
        </div>
      )}
    </label>
  );
}

function engineChip(engine: string): string {
  switch (engine) {
    case 'postgres':
      return 'bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-500/30';
    case 'mysql':
      return 'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/30';
    case 'sqlite':
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30';
    default:
      return 'bg-muted text-muted-foreground ring-border';
  }
}

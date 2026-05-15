'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { FilterSpec, SortSpec } from '@/lib/filter-encode';

const PLATFORMS = ['instagram', 'tiktok', 'youtube'] as const;
const HOOK_TYPES = [
  'question',
  'stat',
  'controversial-claim',
  'list-promise',
  'story-open',
  'pattern-interrupt',
  'direct-address',
] as const;
const SORT_OPTIONS = [
  { v: 'velocity', label: 'Velocity' },
  { v: 'outlier_score', label: 'Outlier' },
  { v: 'views', label: 'Views' },
  { v: 'likes', label: 'Likes' },
  { v: 'posted_at', label: 'Recent' },
] as const;

export function FilterBar({
  initialFilter,
  initialSort,
}: {
  initialFilter: FilterSpec | null;
  initialSort: SortSpec | null;
}) {
  const router = useRouter();
  const sp = useSearchParams();

  function update(key: string, value: string | null) {
    const next = new URLSearchParams(sp.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`?${next.toString()}`);
  }

  const platforms = readMulti(initialFilter, 'platform');
  const hookTypes = readMulti(initialFilter, 'hook_type');

  return (
    <div className="flex flex-wrap items-center gap-2 mb-4 text-sm">
      <ChipGroup
        label="Platform"
        options={PLATFORMS as readonly string[]}
        active={platforms}
        onToggle={(v) => update('platform', toggleCsv(platforms, v))}
      />
      <ChipGroup
        label="Hook"
        options={HOOK_TYPES as readonly string[]}
        active={hookTypes}
        onToggle={(v) => update('hook_type', toggleCsv(hookTypes, v))}
      />
      <div className="ml-auto flex items-center gap-2">
        <span className="text-zinc-500 text-xs">Sort by</span>
        <select
          value={initialSort?.by ?? 'velocity'}
          onChange={(e) => update('sort', e.target.value)}
          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function ChipGroup({
  label,
  options,
  active,
  onToggle,
}: {
  label: string;
  options: readonly string[];
  active: string[];
  onToggle: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-zinc-500 text-xs mr-1">{label}:</span>
      {options.map((o) => {
        const on = active.includes(o);
        return (
          <button
            key={o}
            onClick={() => onToggle(o)}
            className={`rounded px-2 py-0.5 text-xs border ${
              on
                ? 'bg-emerald-700/30 border-emerald-600 text-emerald-200'
                : 'border-zinc-800 text-zinc-400 hover:border-zinc-600'
            }`}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

function readMulti(filter: FilterSpec | null, field: string): string[] {
  const c = filter?.and?.find((x) => x.field === field && x.op === 'in');
  return Array.isArray(c?.value) ? (c.value as string[]) : [];
}

function toggleCsv(current: string[], v: string): string | null {
  const next = current.includes(v) ? current.filter((x) => x !== v) : [...current, v];
  return next.length ? next.join(',') : null;
}

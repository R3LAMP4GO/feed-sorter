import { apiGet } from '@/lib/api';
import { encodeFilter, encodeSort, type FilterSpec, type SortSpec } from '@/lib/filter-encode';
import { FilterBar } from './filter-bar';

export const dynamic = 'force-dynamic';

interface LibraryRow {
  id: string;
  platform: string;
  posted_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  outlier_score: number | null;
  velocity: number | null;
  cover_url: string | null;
  duration_s: number | null;
  caption: string | null;
  format: string | null;
  hook_text: string | null;
  hook_type: string | null;
  cta_text: string | null;
  cta_type: string | null;
}

interface LibraryResp {
  items: LibraryRow[];
  total: number;
  limit: number;
  offset: number;
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const filter = parseFilter(sp);
  const sort = parseSort(sp);

  const qs = new URLSearchParams();
  if (filter) qs.set('filter', encodeFilter(filter));
  if (sort) qs.set('sort', encodeSort(sort));
  qs.set('limit', '50');

  const data = await apiGet<LibraryResp>(`/v1/library?${qs.toString()}`);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Library</h1>
        <div className="text-sm text-zinc-400">{data.total.toLocaleString()} posts</div>
      </div>
      <FilterBar initialFilter={filter} initialSort={sort} />

      <div className="overflow-x-auto rounded border border-zinc-800">
        <table className="fs-table">
          <thead>
            <tr>
              <th>Cover</th>
              <th>Platform</th>
              <th>Hook</th>
              <th>Format</th>
              <th className="text-right">Views</th>
              <th className="text-right">Likes</th>
              <th className="text-right">Outlier</th>
              <th className="text-right">Velocity</th>
              <th>CTA</th>
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 && (
              <tr>
                <td colSpan={9} className="text-center text-zinc-500 py-8">
                  No posts yet — sync from the extension.
                </td>
              </tr>
            )}
            {data.items.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.cover_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={r.cover_url}
                      alt=""
                      className="w-10 h-14 object-cover rounded"
                      loading="lazy"
                    />
                  )}
                </td>
                <td className="text-xs uppercase">{r.platform}</td>
                <td className="max-w-md">
                  <div className="text-zinc-100">{r.hook_text ?? '—'}</div>
                  <div className="text-xs text-zinc-500">{r.hook_type ?? ''}</div>
                </td>
                <td className="text-xs">{r.format ?? '—'}</td>
                <td className="text-right tabular-nums">{fmt(r.views)}</td>
                <td className="text-right tabular-nums">{fmt(r.likes)}</td>
                <td className="text-right tabular-nums">{fmtFloat(r.outlier_score)}</td>
                <td className="text-right tabular-nums">{fmtFloat(r.velocity)}</td>
                <td className="text-xs">{r.cta_type ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmt(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}
function fmtFloat(n: number | null): string {
  return n == null ? '—' : n.toFixed(2);
}

function parseFilter(sp: Record<string, string | string[] | undefined>): FilterSpec | null {
  // Lightweight: we parse a small set of common chips. Heavier filter UI is v2.
  const and: FilterSpec['and'] = [];
  const platform = sp.platform;
  if (typeof platform === 'string' && platform) {
    and.push({ field: 'platform', op: 'in', value: platform.split(',') });
  }
  const hookType = sp.hook_type;
  if (typeof hookType === 'string' && hookType) {
    and.push({ field: 'hook_type', op: 'in', value: hookType.split(',') });
  }
  const format = sp.format;
  if (typeof format === 'string' && format) {
    and.push({ field: 'format', op: 'in', value: format.split(',') });
  }
  return and.length ? { and } : null;
}

function parseSort(sp: Record<string, string | string[] | undefined>): SortSpec | null {
  const by = typeof sp.sort === 'string' ? sp.sort : null;
  if (!by) return { by: 'velocity', dir: 'desc', secondary: { by: 'posted_at', dir: 'desc' } };
  return { by, dir: 'desc' };
}

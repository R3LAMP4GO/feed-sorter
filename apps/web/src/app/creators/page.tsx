// Per-creator drill-down. v1: aggregate captured posts grouped by creator,
// link out to the library filtered by that creator.

import { apiGet } from '@/lib/api';
import { encodeFilter } from '@/lib/filter-encode';

export const dynamic = 'force-dynamic';

interface LibraryRow {
  id: string;
  platform: string;
  creator_id: string | null;
  views: number | null;
  outlier_score: number | null;
  cover_url: string | null;
}

interface LibraryResp {
  items: LibraryRow[];
  total: number;
}

export default async function CreatorsPage() {
  // Reuse /v1/library for now, group on the client. Once we add a dedicated
  // /v1/aggregates/creators endpoint this becomes a single round-trip.
  const data = await apiGet<LibraryResp>('/v1/library?limit=200');

  const byCreator = new Map<
    string,
    { count: number; avgOutlier: number; views: number; platforms: Set<string>; cover: string | null }
  >();
  for (const r of data.items) {
    const k = r.creator_id ?? 'unknown';
    const cur = byCreator.get(k) ?? { count: 0, avgOutlier: 0, views: 0, platforms: new Set<string>(), cover: null };
    cur.count++;
    cur.avgOutlier += r.outlier_score ?? 0;
    cur.views += r.views ?? 0;
    cur.platforms.add(r.platform);
    if (!cur.cover) cur.cover = r.cover_url;
    byCreator.set(k, cur);
  }
  const rows = [...byCreator.entries()]
    .map(([id, v]) => ({
      id,
      count: v.count,
      avgOutlier: v.avgOutlier / v.count,
      views: v.views,
      platforms: [...v.platforms],
      cover: v.cover,
    }))
    .sort((a, b) => b.avgOutlier - a.avgOutlier);

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Creators</h1>
      <div className="overflow-x-auto rounded border border-zinc-800">
        <table className="fs-table">
          <thead>
            <tr>
              <th></th>
              <th>Creator</th>
              <th>Platforms</th>
              <th className="text-right">Posts</th>
              <th className="text-right">Total views</th>
              <th className="text-right">Avg outlier</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.cover && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.cover} alt="" className="w-10 h-14 object-cover rounded" />
                  )}
                </td>
                <td className="font-mono text-xs">{r.id.slice(0, 8)}…</td>
                <td className="text-xs">{r.platforms.join(', ')}</td>
                <td className="text-right tabular-nums">{r.count}</td>
                <td className="text-right tabular-nums">{r.views.toLocaleString()}</td>
                <td className="text-right tabular-nums">{r.avgOutlier.toFixed(2)}</td>
                <td>
                  <a
                    className="text-xs text-emerald-400 hover:underline"
                    href={`/library?filter=${encodeFilter({
                      and: [{ field: 'creator_id', op: 'eq', value: r.id }],
                    })}`}
                  >
                    View posts →
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

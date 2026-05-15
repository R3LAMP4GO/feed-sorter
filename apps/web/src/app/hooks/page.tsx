import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface HookGroup {
  group: string;
  count: number;
  avg_outlier: number | null;
  avg_velocity: number | null;
  avg_views: number | null;
}

interface HookText {
  post_id: string;
  hook_text: string;
  hook_type: string;
  platform: string;
  views: number | null;
  outlier_score: number | null;
  velocity: number | null;
  cover_url: string | null;
}

export default async function HooksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const groupBy = (typeof sp.groupBy === 'string' ? sp.groupBy : 'hook_type') as
    | 'hook_type'
    | 'hook_text';

  if (groupBy === 'hook_type') {
    const data = await apiGet<{ groupBy: string; groups: HookGroup[] }>(
      `/v1/aggregates/hooks?groupBy=hook_type&topN=20`,
    );
    return (
      <div>
        <Header groupBy={groupBy} />
        <div className="overflow-x-auto rounded border border-zinc-800">
          <table className="fs-table">
            <thead>
              <tr>
                <th>Hook type</th>
                <th className="text-right">Count</th>
                <th className="text-right">Avg outlier</th>
                <th className="text-right">Avg velocity</th>
                <th className="text-right">Avg views</th>
              </tr>
            </thead>
            <tbody>
              {data.groups.map((g) => (
                <tr key={g.group}>
                  <td className="font-medium">{g.group}</td>
                  <td className="text-right tabular-nums">{g.count}</td>
                  <td className="text-right tabular-nums">{fmtFloat(g.avg_outlier)}</td>
                  <td className="text-right tabular-nums">{fmtFloat(g.avg_velocity)}</td>
                  <td className="text-right tabular-nums">{fmtInt(g.avg_views)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const data = await apiGet<{ groupBy: string; items: HookText[] }>(
    `/v1/aggregates/hooks?groupBy=hook_text&topN=50`,
  );
  return (
    <div>
      <Header groupBy={groupBy} />
      <ul className="space-y-2">
        {data.items.map((h) => (
          <li
            key={h.post_id}
            className="rounded border border-zinc-800 bg-zinc-900/40 p-3 flex gap-3"
          >
            {h.cover_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={h.cover_url} alt="" className="w-10 h-14 rounded object-cover" />
            )}
            <div className="flex-1">
              <div>{h.hook_text}</div>
              <div className="text-xs text-zinc-500 mt-1">
                {h.hook_type} · {h.platform} · {fmtInt(h.views)} views · velocity{' '}
                {fmtFloat(h.velocity)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Header({ groupBy }: { groupBy: string }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h1 className="text-2xl font-semibold">Top hooks</h1>
      <div className="text-sm">
        <a
          href="?groupBy=hook_type"
          className={
            groupBy === 'hook_type' ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'
          }
        >
          By type
        </a>
        <span className="mx-2 text-zinc-700">·</span>
        <a
          href="?groupBy=hook_text"
          className={
            groupBy === 'hook_text' ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'
          }
        >
          Top text
        </a>
      </div>
    </div>
  );
}

function fmtInt(n: number | null): string {
  if (n == null) return '—';
  return Math.round(n).toLocaleString();
}
function fmtFloat(n: number | null): string {
  return n == null ? '—' : n.toFixed(2);
}

// Saved view: applies the persisted filter+sort, redirects to /library
// with the encoded query string.

import { redirect } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { encodeFilter, encodeSort, type FilterSpec, type SortSpec } from '@/lib/filter-encode';

export const dynamic = 'force-dynamic';

interface View {
  id: string;
  name: string;
  filterJson: FilterSpec;
  sortJson: SortSpec;
}

export default async function ViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await apiGet<View>(`/v1/views/${id}`);
  const qs = new URLSearchParams();
  if (view.filterJson) qs.set('filter', encodeFilter(view.filterJson));
  if (view.sortJson) qs.set('sort', encodeSort(view.sortJson));
  redirect(`/library?${qs.toString()}`);
}

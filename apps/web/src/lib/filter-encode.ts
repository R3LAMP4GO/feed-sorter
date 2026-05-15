// Browser-safe base64url encoder for filter / sort specs.

export interface FilterSpec {
  and: Array<{ field: string; op: string; value: unknown }>;
}

export interface SortSpec {
  by: string;
  dir: 'asc' | 'desc';
  secondary?: { by: string; dir: 'asc' | 'desc' };
}

export function encodeFilter(spec: FilterSpec | null): string {
  if (!spec) return '';
  return base64urlEncode(JSON.stringify(spec));
}

export function encodeSort(spec: SortSpec | null): string {
  if (!spec) return '';
  return base64urlEncode(JSON.stringify(spec));
}

function base64urlEncode(s: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(s).toString('base64url');
  // browser fallback
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

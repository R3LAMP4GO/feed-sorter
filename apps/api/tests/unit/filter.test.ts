import { describe, it, expect } from 'vitest';
import {
  compileFilter,
  compileSort,
  decodeFilter,
  decodeSort,
  filterTouchesExtractions,
  FilterError,
} from '../../src/lib/filter.js';

// We don't depend on a live DB; we only inspect that the compiler returns
// a structured `sql` chunk and rejects malformed inputs. The exact SQL is
// validated end-to-end by the integration tests.

describe('filter translator', () => {
  it('throws on unknown field', () => {
    expect(() =>
      compileFilter({ and: [{ field: 'evil_drop_table', op: 'eq', value: 'x' }] }),
    ).toThrow(FilterError);
  });

  it('throws on unsupported op', () => {
    expect(() =>
      // @ts-expect-error testing runtime guard
      compileFilter({ and: [{ field: 'platform', op: 'pwn', value: 'x' }] }),
    ).toThrow(FilterError);
  });

  it('rejects non-array `in` value', () => {
    expect(() =>
      compileFilter({ and: [{ field: 'platform', op: 'in', value: 'instagram' }] }),
    ).toThrow(FilterError);
  });

  it('rejects ilike on non-text field', () => {
    expect(() =>
      compileFilter({ and: [{ field: 'views', op: 'ilike', value: '%x%' }] }),
    ).toThrow(FilterError);
  });

  it('rejects contains-any on non-array field', () => {
    expect(() =>
      compileFilter({ and: [{ field: 'platform', op: 'contains-any', value: ['x'] }] }),
    ).toThrow(FilterError);
  });

  it('rejects bad uuid', () => {
    expect(() =>
      compileFilter({ and: [{ field: 'creator_id', op: 'eq', value: 'not-a-uuid' }] }),
    ).toThrow(FilterError);
  });

  it('coerces timestamp strings', () => {
    expect(() =>
      compileFilter({ and: [{ field: 'posted_at', op: 'gte', value: '2026-04-01' }] }),
    ).not.toThrow();
    expect(() =>
      compileFilter({ and: [{ field: 'posted_at', op: 'gte', value: 'banana' }] }),
    ).toThrow(FilterError);
  });

  it('coerces number values', () => {
    expect(() =>
      compileFilter({ and: [{ field: 'views', op: 'gte', value: '10000' }] }),
    ).not.toThrow();
    expect(() =>
      compileFilter({ and: [{ field: 'views', op: 'gte', value: 'banana' }] }),
    ).toThrow(FilterError);
  });

  it('returns true-clause for empty and-list', () => {
    const sql = compileFilter({ and: [] });
    expect(sql).toBeTruthy();
  });

  it('handles all enumerated ops', () => {
    const ok: Array<{ field: string; op: string; value: unknown }> = [
      { field: 'platform', op: 'eq', value: 'instagram' },
      { field: 'platform', op: 'neq', value: 'tiktok' },
      { field: 'platform', op: 'in', value: ['instagram', 'tiktok'] },
      { field: 'platform', op: 'not-in', value: ['x'] },
      { field: 'views', op: 'gte', value: 1 },
      { field: 'views', op: 'lte', value: 1 },
      { field: 'views', op: 'gt', value: 1 },
      { field: 'views', op: 'lt', value: 1 },
      { field: 'caption', op: 'ilike', value: '%foo%' },
      { field: 'topics', op: 'contains-any', value: ['x'] },
      { field: 'topics', op: 'contains-all', value: ['x', 'y'] },
    ];
    for (const c of ok) {
      // @ts-expect-error generic narrow
      expect(() => compileFilter({ and: [c] })).not.toThrow();
    }
  });
});

describe('sort translator', () => {
  it('rejects unsortable field', () => {
    expect(() => compileSort({ by: 'caption', dir: 'desc' })).toThrow(FilterError);
  });

  it('accepts known fields and secondary', () => {
    expect(() =>
      compileSort({ by: 'velocity', dir: 'desc', secondary: { by: 'posted_at', dir: 'desc' } }),
    ).not.toThrow();
  });

  it('falls back to posted_at desc when null', () => {
    expect(compileSort(null)).toBeTruthy();
  });
});

describe('decode helpers', () => {
  it('decodes base64url-json', () => {
    const spec = { and: [{ field: 'platform', op: 'eq', value: 'instagram' }] };
    const b64 = Buffer.from(JSON.stringify(spec)).toString('base64url');
    expect(decodeFilter(b64)).toEqual(spec);
  });

  it('returns null on garbage', () => {
    expect(decodeFilter('garbage!!!')).toBeNull();
    expect(decodeSort('!!')).toBeNull();
  });
});

describe('filterTouchesExtractions', () => {
  it('detects extractions-table fields', () => {
    expect(
      filterTouchesExtractions({ and: [{ field: 'hook_type', op: 'eq', value: 'question' }] }),
    ).toBe(true);
    expect(
      filterTouchesExtractions({ and: [{ field: 'topics', op: 'contains-any', value: ['x'] }] }),
    ).toBe(true);
    expect(
      filterTouchesExtractions({ and: [{ field: 'views', op: 'gte', value: 1 }] }),
    ).toBe(false);
  });
});

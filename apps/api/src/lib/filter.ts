// Filter-spec → parameterized SQL translator.
//
// Input shape:
//   { and: [{ field, op, value }, …] }    // top-level OR is v2
// Output: a Drizzle `sql` chunk safe to embed in a WHERE clause.
//
// Field names are looked up in a whitelist mapping → fully-qualified column
// expressions. Operators are likewise enforced via a switch — no user input
// ever reaches a SQL identifier position.

import { sql, type SQL } from 'drizzle-orm';

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'in'
  | 'not-in'
  | 'gte'
  | 'lte'
  | 'gt'
  | 'lt'
  | 'ilike'
  | 'contains-any'
  | 'contains-all';

export interface FilterClause {
  field: string;
  op: FilterOp;
  value: unknown;
}

export interface FilterSpec {
  and?: FilterClause[];
}

export interface SortSpec {
  by: string;
  dir: 'asc' | 'desc';
  secondary?: { by: string; dir: 'asc' | 'desc' };
}

// --- Field whitelist ---------------------------------------------------------
// Maps logical field name → SQL column expression. Each value is a tagged
// `sql` template so we never paste raw strings.
//
// `kind` controls coercion: `text` | `number` | `timestamp` | `uuid` |
// `text-array` (for `topics`).
type FieldKind = 'text' | 'number' | 'timestamp' | 'uuid' | 'text-array';

interface FieldDef {
  expr: SQL;
  kind: FieldKind;
}

const FIELDS: Record<string, FieldDef> = {
  // posts
  platform: { expr: sql`p.platform`, kind: 'text' },
  niche_cluster_id: { expr: sql`p.niche_cluster_id`, kind: 'uuid' },
  format: { expr: sql`p.format`, kind: 'text' },
  creator_id: { expr: sql`p.creator_id`, kind: 'uuid' },
  posted_at: { expr: sql`p.posted_at`, kind: 'timestamp' },
  views: { expr: sql`p.views`, kind: 'number' },
  likes: { expr: sql`p.likes`, kind: 'number' },
  comments: { expr: sql`p.comments`, kind: 'number' },
  shares: { expr: sql`p.shares`, kind: 'number' },
  outlier_score: { expr: sql`p.outlier_score`, kind: 'number' },
  velocity: { expr: sql`p.velocity`, kind: 'number' },
  duration_s: { expr: sql`p.duration_s`, kind: 'number' },
  caption: { expr: sql`p.caption`, kind: 'text' },
  // extractions (joined as `e`)
  hook_type: { expr: sql`e.hook_type`, kind: 'text' },
  cta_type: { expr: sql`e.cta_type`, kind: 'text' },
  topics: { expr: sql`e.topics`, kind: 'text-array' },
};

const SORT_FIELDS: Record<string, SQL> = {
  views: sql`p.views`,
  likes: sql`p.likes`,
  comments: sql`p.comments`,
  outlier_score: sql`p.outlier_score`,
  velocity: sql`p.velocity`,
  posted_at: sql`p.posted_at`,
  duration_s: sql`p.duration_s`,
};

// --- Coercion ----------------------------------------------------------------
function coerceScalar(kind: FieldKind, v: unknown): string | number | Date {
  if (kind === 'number') {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) throw new FilterError(`expected number, got ${v}`);
    return n;
  }
  if (kind === 'timestamp') {
    const d = v instanceof Date ? v : new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new FilterError(`expected timestamp, got ${v}`);
    return d;
  }
  if (kind === 'uuid') {
    const s = String(v);
    if (!/^[0-9a-f-]{36}$/i.test(s)) throw new FilterError(`expected uuid, got ${v}`);
    return s;
  }
  // text / text-array element
  return String(v);
}

function coerceArray(kind: FieldKind, v: unknown): Array<string | number | Date> {
  if (!Array.isArray(v)) throw new FilterError('expected array value');
  return v.map((x) => coerceScalar(kind, x));
}

export class FilterError extends Error {}

// --- Clause compiler ---------------------------------------------------------
function compileClause(c: FilterClause): SQL {
  const def = FIELDS[c.field];
  if (!def) throw new FilterError(`unknown field: ${c.field}`);

  const col = def.expr;

  switch (c.op) {
    case 'eq':
      return sql`${col} = ${coerceScalar(def.kind, c.value)}`;
    case 'neq':
      return sql`${col} <> ${coerceScalar(def.kind, c.value)}`;
    case 'gte':
      return sql`${col} >= ${coerceScalar(def.kind, c.value)}`;
    case 'lte':
      return sql`${col} <= ${coerceScalar(def.kind, c.value)}`;
    case 'gt':
      return sql`${col} > ${coerceScalar(def.kind, c.value)}`;
    case 'lt':
      return sql`${col} < ${coerceScalar(def.kind, c.value)}`;
    case 'in': {
      const arr = coerceArray(def.kind, c.value);
      if (arr.length === 0) return sql`false`;
      // Expand into one placeholder per element. drizzle/postgres-js binds JS
      // arrays as a single scalar (not a Postgres array), which produced
      // "malformed array literal" errors when we tried `any($1::text[])`.
      const list = sql.join(arr.map((v) => sql`${v}`), sql`, `);
      return sql`${col} in (${list})`;
    }
    case 'not-in': {
      const arr = coerceArray(def.kind, c.value);
      if (arr.length === 0) return sql`true`;
      const list = sql.join(arr.map((v) => sql`${v}`), sql`, `);
      return sql`${col} not in (${list})`;
    }
    case 'ilike':
      if (def.kind !== 'text') throw new FilterError('ilike requires text field');
      return sql`${col} ilike ${String(c.value)}`;
    case 'contains-any': {
      if (def.kind !== 'text-array') throw new FilterError('contains-any requires text-array field');
      const arr = (c.value as unknown[]).map(String);
      return sql`${col} && ${arr}::text[]`;
    }
    case 'contains-all': {
      if (def.kind !== 'text-array') throw new FilterError('contains-all requires text-array field');
      const arr = (c.value as unknown[]).map(String);
      return sql`${col} @> ${arr}::text[]`;
    }
    default:
      throw new FilterError(`unsupported op: ${(c as { op: string }).op}`);
  }
}

export function compileFilter(spec: FilterSpec | null | undefined): SQL {
  const clauses = spec?.and ?? [];
  if (clauses.length === 0) return sql`true`;
  const compiled = clauses.map(compileClause);
  // join with AND
  let out = compiled[0];
  for (let i = 1; i < compiled.length; i++) {
    out = sql`${out} and ${compiled[i]}`;
  }
  return out;
}

export function compileSort(spec: SortSpec | null | undefined): SQL {
  if (!spec) return sql`p.posted_at desc nulls last`;
  const primary = SORT_FIELDS[spec.by];
  if (!primary) throw new FilterError(`unsortable field: ${spec.by}`);
  const dir = spec.dir === 'asc' ? sql`asc` : sql`desc`;
  let out = sql`${primary} ${dir} nulls last`;
  if (spec.secondary) {
    const sec = SORT_FIELDS[spec.secondary.by];
    if (!sec) throw new FilterError(`unsortable field: ${spec.secondary.by}`);
    const sdir = spec.secondary.dir === 'asc' ? sql`asc` : sql`desc`;
    out = sql`${out}, ${sec} ${sdir} nulls last`;
  }
  return out;
}

/** Whether the compiled WHERE references any extractions column. */
export function filterTouchesExtractions(spec: FilterSpec | null | undefined): boolean {
  for (const c of spec?.and ?? []) {
    const def = FIELDS[c.field];
    if (!def) continue;
    if (c.field === 'hook_type' || c.field === 'cta_type' || c.field === 'topics') return true;
  }
  return false;
}

/** Decode `?filter=<base64-json>` query param. */
export function decodeFilter(b64: string | undefined): FilterSpec | null {
  if (!b64) return null;
  try {
    const json = Buffer.from(b64, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed == null) return null;
    return parsed as FilterSpec;
  } catch {
    return null;
  }
}

export function decodeSort(b64: string | undefined): SortSpec | null {
  if (!b64) return null;
  try {
    const json = Buffer.from(b64, 'base64url').toString('utf8');
    return JSON.parse(json) as SortSpec;
  } catch {
    return null;
  }
}

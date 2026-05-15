// CORS origin allowlist resolver.
//
// Pattern follows real-world Hono deployments (elizaOS/eliza
// cloud-api-hono-cors.ts, phughesmcr/deno-mcp-template hono.ts,
// secondsky/claude-skills cloudflare-workers hono-app.ts):
//
//   cors({ origin: (origin) => isAllowed(origin) ? origin : null,
//          credentials: true })
//
// Returning `null` (not '*') when the origin is unknown is the only safe
// pairing with `credentials: true` — '*' + credentials is rejected by the
// browser, and reflecting any incoming Origin defeats CORS as a CSRF
// defense.

export interface AllowlistConfig {
  appUrl: string;
  extra: string;
  isProd: boolean;
}

export interface Allowlist {
  /** Exact origins allowed unconditionally (with credentials). */
  exact: ReadonlySet<string>;
  /** Whether `chrome-extension://*` origins are allowed. */
  allowExtensions: boolean;
  /** Whether `http://localhost:*` and `http://127.0.0.1:*` are allowed. */
  allowLocalhost: boolean;
}

/**
 * Build the runtime allowlist from env. APP_URL is always included.
 * In non-prod we also allow Chrome extensions and any localhost port so
 * `npm run web:dev` + a side-loaded extension just work.
 */
export function buildAllowlist(cfg: AllowlistConfig): Allowlist {
  const exact = new Set<string>();
  if (cfg.appUrl) exact.add(stripTrailingSlash(cfg.appUrl));
  for (const raw of cfg.extra.split(',')) {
    const o = stripTrailingSlash(raw.trim());
    if (o) exact.add(o);
  }
  return {
    exact,
    allowExtensions: !cfg.isProd,
    allowLocalhost: !cfg.isProd,
  };
}

const LOCALHOST_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
const EXTENSION_RE = /^chrome-extension:\/\/[a-p]{32}$/;

/** Returns the origin to echo back, or `null` to reject. */
export function resolveOrigin(allowlist: Allowlist, origin: string | undefined): string | null {
  // No Origin header: server-to-server / curl / health checks. CORS doesn't
  // apply, so the origin echo is irrelevant — return null and the cors
  // middleware will simply not emit Access-Control-* headers.
  if (!origin) return null;

  if (allowlist.exact.has(origin)) return origin;
  if (allowlist.allowExtensions && EXTENSION_RE.test(origin)) return origin;
  if (allowlist.allowLocalhost && LOCALHOST_RE.test(origin)) return origin;
  return null;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

// /v1/auth/* — magic-link issuance + token exchange → JWT cookie.

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

import { db } from '../db/client.js';
import { magicLinkTokens, users, sessions } from '../db/schema.js';
import { sendMagicLink } from '../services/email.js';
import { COOKIE_NAME, COOKIE_OPTIONS, createSessionToken } from '../auth/jwt.js';
import { env } from '../env.js';
import { log } from '../log.js';

const app = new Hono();

const TOKEN_TTL_MIN = 15;

function issueToken(): string {
  return randomBytes(32).toString('base64url');
}

function isEmailValid(s: unknown): s is string {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

// POST /v1/auth/magic-link  { email }
app.post('/magic-link', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!isEmailValid(email)) return c.json({ error: 'invalid email' }, 400);

  const token = issueToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MIN * 60 * 1000);

  await db.insert(magicLinkTokens).values({ token, email, expiresAt });

  const url = `${env.APP_URL}/login/callback?token=${encodeURIComponent(token)}`;
  try {
    await sendMagicLink({ to: email, url });
  } catch (err) {
    log.error({ err: (err as Error).message }, 'magic-link send failed');
    return c.json({ error: 'send-failed' }, 502);
  }

  return c.json({ ok: true });
});

// POST /v1/auth/verify  { token }
app.post('/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = String(body?.token ?? '');
  if (!token) return c.json({ error: 'missing token' }, 400);

  const [row] = await db
    .select()
    .from(magicLinkTokens)
    .where(
      and(
        eq(magicLinkTokens.token, token),
        isNull(magicLinkTokens.usedAt),
        gt(magicLinkTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row) return c.json({ error: 'invalid-or-expired' }, 400);

  // Mark token used (single-use).
  await db
    .update(magicLinkTokens)
    .set({ usedAt: new Date() })
    .where(eq(magicLinkTokens.token, token));

  // Find or create user
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, row.email))
    .limit(1);

  const user =
    existing ??
    (
      await db
        .insert(users)
        .values({ email: row.email })
        .returning()
    )[0];

  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));

  const tier = (user.tier as 'free' | 'pro' | 'studio') ?? 'free';
  const session = await createSessionToken({ sub: user.id, email: user.email, tier });

  await db.insert(sessions).values({
    userId: user.id,
    jwtJti: session.jti,
    expiresAt: session.expiresAt,
    userAgent: c.req.header('user-agent') ?? null,
  });

  setCookie(c, COOKIE_NAME, session.token, COOKIE_OPTIONS);

  return c.json({
    ok: true,
    token: session.token,
    user: { id: user.id, email: user.email, tier },
  });
});

// POST /v1/auth/logout
app.post('/logout', async (c) => {
  setCookie(c, COOKIE_NAME, '', { ...COOKIE_OPTIONS, maxAge: 0 });
  return c.json({ ok: true });
});

export default app;

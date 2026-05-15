// JWT issuance & verification helpers. Cookie-based session.
// Pattern mirrors `f/mcp-startup-framework` `createSessionToken` (jose).

import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { env } from '../env.js';

const ALG = 'HS256';
const ISSUER = 'feedsorter';
const AUDIENCE = 'feedsorter-app';
const SESSION_DAYS = 30;

export const COOKIE_NAME = 'session';
export const SESSION_TTL_S = SESSION_DAYS * 24 * 60 * 60;

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.JWT_SECRET);
}

export interface SessionClaims {
  sub: string; // user id
  email: string;
  tier: 'free' | 'pro' | 'studio';
  jti: string;
}

export async function createSessionToken(claims: Omit<SessionClaims, 'jti'>): Promise<{
  token: string;
  jti: string;
  expiresAt: Date;
}> {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_S * 1000);
  const token = await new SignJWT({ email: claims.email, tier: claims.tier })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.sub)
    .setJti(jti)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secretKey());
  return { token, jti, expiresAt };
}

export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (!payload.sub || !payload.jti) return null;
    return {
      sub: payload.sub,
      email: String(payload.email ?? ''),
      tier: (payload.tier as SessionClaims['tier']) ?? 'free',
      jti: payload.jti,
    };
  } catch {
    return null;
  }
}

export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'Lax' as const,
  secure: env.IS_PROD,
  maxAge: SESSION_TTL_S,
  path: '/',
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
};

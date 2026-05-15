// Tier-gate: which capture scopes are allowed for which tier.
// Mirrors the JS module shipped to the extension (`src/lib/tier-gate.js`)
// so server + client agree.

export type Tier = 'free' | 'pro' | 'studio';
export type Platform = 'instagram' | 'tiktok' | 'youtube';
export type Scope = 'profile' | 'explore' | 'foryou' | 'shorts-feed' | 'search' | 'hashtag' | 'sound' | 'other';

const FREE_ALLOWED_SCOPES: ReadonlySet<Scope> = new Set(['profile']);

export interface GateResult {
  allowed: boolean;
  reason?: 'tier-locked' | 'unknown-scope';
}

export function checkScope(input: { tier: Tier; platform: Platform; scope: Scope }): GateResult {
  if (input.tier === 'pro' || input.tier === 'studio') return { allowed: true };
  if (FREE_ALLOWED_SCOPES.has(input.scope)) return { allowed: true };
  return { allowed: false, reason: 'tier-locked' };
}

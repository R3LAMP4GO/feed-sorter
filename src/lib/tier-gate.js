// Free vs Pro capture-scope gate (ESM spec, used by tests).
// Server enforces the same logic in apps/api/src/lib/tier-gate.ts.
// IIFE mirror: tier-gate-runtime.js.
//
// Exports two layers:
//   1. Pure helpers: checkScope, meetsTier, TIER_RANK, isPro — synchronous,
//      no I/O. Trivially testable.
//   2. Storage-backed helpers: getTier, onTierChange — accept a `storage` /
//      `onChanged` adapter (chrome.storage.local shape) so tests can pass a
//      fake. The IIFE mirror hardcodes `chrome.storage` for the content
//      script.

const FREE_ALLOWED_SCOPES = new Set(['profile']);
const PRO_TIERS = new Set(['pro', 'studio']);

export const TIER_STORAGE_KEY = 'fs.api.tier';

export function checkScope({ tier, platform, scope }) {
  if (tier === 'pro' || tier === 'studio') return { allowed: true };
  if (FREE_ALLOWED_SCOPES.has(scope)) return { allowed: true };
  return { allowed: false, reason: 'tier-locked' };
}

export const TIER_RANK = { free: 0, pro: 1, studio: 2 };

export function meetsTier(actual, required) {
  return (TIER_RANK[actual] ?? 0) >= (TIER_RANK[required] ?? 0);
}

/** Truth-table: pro | studio → true. Everything else (including unknown
 *  strings / null / undefined) → false. */
export function isPro(tier) {
  return PRO_TIERS.has(tier);
}

/** Reads the persisted tier from a chrome.storage.local-shaped adapter.
 *  Supports both callback and Promise forms. Falls back to 'free' on any
 *  failure or missing value. */
export async function getTier(storage) {
  if (!storage || typeof storage.get !== 'function') return 'free';
  const read = () => new Promise((resolve) => {
    try {
      const maybe = storage.get([TIER_STORAGE_KEY], (r) => resolve(r || {}));
      if (maybe && typeof maybe.then === 'function') {
        maybe.then((r) => resolve(r || {})).catch(() => resolve({}));
      }
    } catch {
      resolve({});
    }
  });
  const out = await read();
  return out[TIER_STORAGE_KEY] || 'free';
}

/** Subscribes to a chrome.storage.onChanged-shaped event. Calls
 *  `handler(newTier, oldTier)` whenever the tier key flips in the 'local'
 *  area. Returns an unsubscribe function. */
export function onTierChange(onChanged, handler) {
  if (!onChanged || typeof onChanged.addListener !== 'function') return () => {};
  if (typeof handler !== 'function') return () => {};
  const listener = (changes, area) => {
    if (area && area !== 'local') return;
    const ch = changes?.[TIER_STORAGE_KEY];
    if (!ch) return;
    handler(ch.newValue || 'free', ch.oldValue || 'free');
  };
  onChanged.addListener(listener);
  return () => {
    try { onChanged.removeListener(listener); } catch { /* noop */ }
  };
}

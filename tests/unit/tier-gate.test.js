import { describe, it, expect, vi } from 'vitest';
import {
  checkScope,
  meetsTier,
  TIER_RANK,
  isPro,
  getTier,
  onTierChange,
  TIER_STORAGE_KEY,
} from '../../src/lib/tier-gate.js';

describe('tier-gate', () => {
  it('allows free tier on profile only', () => {
    expect(checkScope({ tier: 'free', platform: 'instagram', scope: 'profile' })).toEqual({
      allowed: true,
    });
    expect(checkScope({ tier: 'free', platform: 'instagram', scope: 'explore' })).toEqual({
      allowed: false,
      reason: 'tier-locked',
    });
    expect(checkScope({ tier: 'free', platform: 'tiktok', scope: 'foryou' })).toEqual({
      allowed: false,
      reason: 'tier-locked',
    });
    expect(checkScope({ tier: 'free', platform: 'youtube', scope: 'shorts-feed' })).toEqual({
      allowed: false,
      reason: 'tier-locked',
    });
  });

  it('allows pro tier on every scope', () => {
    for (const scope of ['profile', 'explore', 'foryou', 'shorts-feed', 'search']) {
      expect(
        checkScope({ tier: 'pro', platform: 'instagram', scope }).allowed,
      ).toBe(true);
    }
  });

  it('meetsTier compares ranks', () => {
    expect(meetsTier('pro', 'free')).toBe(true);
    expect(meetsTier('free', 'pro')).toBe(false);
    expect(meetsTier('studio', 'pro')).toBe(true);
  });

  it('exposes a stable rank table', () => {
    expect(TIER_RANK).toEqual({ free: 0, pro: 1, studio: 2 });
  });
});

describe('tier-gate isPro truth table', () => {
  it('returns true for pro and studio', () => {
    expect(isPro('pro')).toBe(true);
    expect(isPro('studio')).toBe(true);
  });

  it('returns false for free and unknowns', () => {
    expect(isPro('free')).toBe(false);
    expect(isPro('')).toBe(false);
    expect(isPro(null)).toBe(false);
    expect(isPro(undefined)).toBe(false);
    expect(isPro('PRO')).toBe(false); // case-sensitive — server sends lowercase
    expect(isPro('enterprise')).toBe(false);
    expect(isPro(0)).toBe(false);
    expect(isPro({})).toBe(false);
  });

  it('TIER_STORAGE_KEY is the chrome.storage.local key the runtime listens on', () => {
    expect(TIER_STORAGE_KEY).toBe('fs.api.tier');
  });
});

// Fake storage adapter that mimics chrome.storage.local.get + the
// chrome.storage.onChanged event surface. Lets us drive getTier /
// onTierChange in node without a browser.
function makeFakeStorage(initial = {}) {
  let store = { ...initial };
  const listeners = new Set();
  return {
    get: (keys, cb) => {
      const out = {};
      const ks = Array.isArray(keys) ? keys : [keys];
      for (const k of ks) if (k in store) out[k] = store[k];
      // Mimic chrome's callback form. The real API also returns a Promise
      // in Manifest V3, but spec-level the callback path covers both.
      cb(out);
    },
    onChanged: {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
    },
    /** Test helper: simulate writing a value + firing change events. */
    set(key, value, area = 'local') {
      const prev = store[key];
      store[key] = value;
      const changes = { [key]: { newValue: value, oldValue: prev } };
      for (const fn of listeners) fn(changes, area);
    },
    /** Test helper: peek at registered listener count. */
    listenerCount: () => listeners.size,
  };
}

describe('tier-gate getTier (storage adapter)', () => {
  it('returns "free" when key is missing', async () => {
    const storage = makeFakeStorage({});
    expect(await getTier(storage)).toBe('free');
  });

  it('returns the persisted tier', async () => {
    const storage = makeFakeStorage({ [TIER_STORAGE_KEY]: 'pro' });
    expect(await getTier(storage)).toBe('pro');
  });

  it('returns "free" when no storage adapter is provided', async () => {
    expect(await getTier(undefined)).toBe('free');
    expect(await getTier(null)).toBe('free');
    expect(await getTier({})).toBe('free');
  });
});

describe('tier-gate onTierChange listener', () => {
  it('fires the handler with (newTier, oldTier) when fs.api.tier flips', () => {
    const storage = makeFakeStorage({ [TIER_STORAGE_KEY]: 'free' });
    const handler = vi.fn();
    const unsubscribe = onTierChange(storage.onChanged, handler);

    storage.set(TIER_STORAGE_KEY, 'pro');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenLastCalledWith('pro', 'free');

    storage.set(TIER_STORAGE_KEY, 'studio');
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith('studio', 'pro');

    storage.set(TIER_STORAGE_KEY, 'free');
    expect(handler).toHaveBeenLastCalledWith('free', 'studio');

    unsubscribe();
    expect(storage.listenerCount()).toBe(0);
    storage.set(TIER_STORAGE_KEY, 'pro');
    expect(handler).toHaveBeenCalledTimes(3); // no new call after unsubscribe
  });

  it('ignores changes to other keys', () => {
    const storage = makeFakeStorage({});
    const handler = vi.fn();
    onTierChange(storage.onChanged, handler);
    storage.set('fs.api.token', 'tok-123');
    storage.set('fs.api.baseUrl', 'http://localhost:8787');
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores changes from non-local storage areas', () => {
    const storage = makeFakeStorage({});
    const handler = vi.fn();
    onTierChange(storage.onChanged, handler);
    storage.set(TIER_STORAGE_KEY, 'pro', 'sync');
    storage.set(TIER_STORAGE_KEY, 'studio', 'managed');
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns a no-op unsubscribe when given garbage', () => {
    expect(typeof onTierChange(null, () => {})).toBe('function');
    expect(typeof onTierChange({}, () => {})).toBe('function');
    const storage = makeFakeStorage({});
    expect(typeof onTierChange(storage.onChanged, null)).toBe('function');
    // None of the above should have wired anything up.
    expect(storage.listenerCount()).toBe(0);
  });

  it('coerces missing newValue/oldValue to "free"', () => {
    const storage = makeFakeStorage({});
    const handler = vi.fn();
    onTierChange(storage.onChanged, handler);
    // Partial chrome events (e.g. when the key is being deleted) leave
    // newValue/oldValue undefined — the spec's `|| 'free'` fallbacks turn
    // those into safe defaults so the handler never sees `undefined`.
    storage.set(TIER_STORAGE_KEY, undefined);
    expect(handler).toHaveBeenCalledWith('free', 'free');
  });
});

// IIFE mirror of src/lib/tier-gate.js for content scripts.
// Keep in lock-step.
//
// Adds storage-backed helpers (getTier / isPro / onTierChange) that read
// from chrome.storage.local["fs.api.tier"]. A module-scoped cache lets the
// content script's render loop call isPro() synchronously without an async
// round-trip per row.

(() => {
  const FREE_ALLOWED_SCOPES = new Set(['profile']);
  const PRO_TIERS = new Set(['pro', 'studio']);
  const TIER_RANK = { free: 0, pro: 1, studio: 2 };
  const TIER_STORAGE_KEY = 'fs.api.tier';
  let cachedTier = 'free';

  function checkScope(input) {
    const tier = input?.tier;
    const scope = input?.scope;
    if (tier === 'pro' || tier === 'studio') return { allowed: true };
    if (FREE_ALLOWED_SCOPES.has(scope)) return { allowed: true };
    return { allowed: false, reason: 'tier-locked' };
  }

  function meetsTier(actual, required) {
    return (TIER_RANK[actual] || 0) >= (TIER_RANK[required] || 0);
  }

  // isPro(): if called with no args, reads the cached tier (sync). If called
  // with an explicit tier string, runs as a pure truth-table check.
  function isPro(tier) {
    const t = tier == null ? cachedTier : tier;
    return PRO_TIERS.has(t);
  }

  function getCachedTier() {
    return cachedTier;
  }

  function getTier() {
    return new Promise((resolve) => {
      try {
        if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) {
          resolve(cachedTier);
          return;
        }
        chrome.storage.local.get([TIER_STORAGE_KEY], (r) => {
          if (chrome.runtime?.lastError) {
            resolve(cachedTier);
            return;
          }
          cachedTier = r?.[TIER_STORAGE_KEY] || 'free';
          resolve(cachedTier);
        });
      } catch {
        resolve(cachedTier);
      }
    });
  }

  function onTierChange(handler) {
    if (typeof handler !== 'function') return () => {};
    try {
      if (!globalThis.chrome || !chrome.storage || !chrome.storage.onChanged) {
        return () => {};
      }
      const listener = (changes, area) => {
        if (area !== 'local') return;
        const ch = changes?.[TIER_STORAGE_KEY];
        if (!ch) return;
        const next = ch.newValue || 'free';
        const prev = ch.oldValue || cachedTier;
        cachedTier = next;
        try {
          handler(next, prev);
        } catch {
          /* swallow handler errors */
        }
      };
      chrome.storage.onChanged.addListener(listener);
      return () => {
        try {
          chrome.storage.onChanged.removeListener(listener);
        } catch {
          /* noop */
        }
      };
    } catch {
      return () => {};
    }
  }

  globalThis.FeedSorterTierGate = {
    checkScope,
    meetsTier,
    TIER_RANK,
    TIER_STORAGE_KEY,
    isPro,
    getTier,
    getCachedTier,
    onTierChange,
  };
})();

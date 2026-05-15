# Fix: Collect-all stops early when posts are rehydrated from IDB

## Problem
From the user's logs:
- `collect.start ... limit:200`
- `collect.end reason:limit-reached, scrolls:1, inScope:476`

The collector exits immediately because `inScopeCount()` returns
`posts.size` (476 rehydrated rows) regardless of `state.scope`.
Meanwhile the visible list shows only 50 posts (this session),
because `filtered()` respects `state.scope === "session"`.

So the user sees "50 posts" but the collector thinks 476 are
already in scope, instantly tripping the `limit-reached` exit.

## Fix
Make `inScopeCount()` mirror what the user sees in the list:
- Respect `state.scope === "session"` by counting only ids in
  `sessionIds`.
- Keep the existing surface filter.

Same logic should apply to `oldestInScope()` (used for the
date-cutoff exit), but that's a smaller issue — out of scope here
unless trivial. Apply for symmetry.

## File / location
`content.js` ~line 558–572 (`oldestInScope`, `inScopeCount`).

## Steps
1. Update `inScopeCount()` in `content.js` to filter by `sessionIds` when `state.scope === "session"`, in addition to the surface filter.
2. Update `oldestInScope()` to apply the same session filter.
3. `node --check content.js` and `npm run test:unit` to verify nothing broke.

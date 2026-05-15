// Local vitest config for the apps/api workspace.
//
// The repo-root `vitest.config.js` includes these tests when run from the
// workspace root (`npm run test:unit`). This local config makes
// `npm --workspace apps/api run test` work from any directory by resolving
// includes relative to this file.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});

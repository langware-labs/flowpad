import { afterAll } from 'vitest';

import { installCleanup } from '../_cleanup';

// The backend port is resolved from `.env.local` in vitest.config.ts and baked
// in via `define`. Validate it HERE — this setup only loads when the hub
// project runs — so a missing port hard-fails the hub suite (no silent guess at
// a non-existent backend) without breaking unrelated projects whose runs also
// evaluate the hub config file at startup.
declare const __HUB_BACKEND_PORT__: string;
if (!__HUB_BACKEND_PORT__) {
  throw new Error('hub vitest: LOCAL_SERVER_PORT is not set in .env.local — refusing to guess a backend port');
}

// Track + sweep every live local entity these hub tests mint before sharing to
// the hub. Scope is LOCAL-backend entities (the realm that created them); the
// remote hub copy is out of scope.
installCleanup({ sweepTypes: ['skill', 'conversation', 'workflow', 'whiteboard'] });

/**
 * Hub-suite test isolation: reset the per-instance SDK realm override.
 *
 * The two-client helpers (`_instances.ts getInstance`) set
 * `globalThis.__FLOWPAD_API_URL__` to point the freshly re-evaluated `@sdk`
 * realm at a specific instance's backend (dev-1 / dev-2). The hub project runs
 * single-threaded, so that global leaks across FILES: a single-client test file
 * loaded after a two-client file would re-import `@sdk` and silently target the
 * last instance's backend (wrong identity → 401 / "entity not found").
 *
 * Resetting it after every file means each file's `@sdk` import resolves to the
 * configured default backend (the `__API_URL__` define) unless that file
 * explicitly opts into an instance via `getInstance`. No hardcoded URL here —
 * deleting the override hands resolution back to the build-time config.
 */
afterAll(() => {
  delete (globalThis as Record<string, unknown>).__FLOWPAD_API_URL__;
});

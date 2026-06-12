import { afterAll } from 'vitest';

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

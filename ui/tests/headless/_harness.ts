/**
 * Shared boot harness for the headless tests.
 *
 * Both headless tests resolve a live backend (soft-skipping when none is up) and
 * then mount the REAL app exactly like `main.tsx`. That preamble lived in two
 * places; it lives here now so the ThemeProvider wiring and the boot-spinner wait
 * (and its `// do not increase timeout` budget) can't drift between files.
 */
import { afterEach, beforeAll, expect } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { ThemeProvider } from 'next-themes';
// react-router is deduped/inlined (see vitest.config.ts), so this is the same
// module instance the freshly-evaluated `@src/router` builds its router against.
import { RouterProvider } from 'react-router';
import { resolveLiveBackend, type LiveBackend } from './_backend';

/**
 * Resolve a live backend once per file and register `cleanup()` after each test.
 * Returns a ref whose `.current` is null until `beforeAll` runs (and stays null
 * when no backend is reachable — the test then soft-skips). `logPrefix` tags the
 * skip notice so failures point at the right file.
 */
export function setupLiveBackend(logPrefix: string): { current: LiveBackend | null } {
  const ref: { current: LiveBackend | null } = { current: null };
  beforeAll(async () => {
    ref.current = await resolveLiveBackend();
    if (!ref.current) {
      console.warn(
        `${logPrefix} no live backend reachable — skipping. Launch one with ` +
          '`scripts/instance_ctl.sh launch dev-1` or `uv run -m flow_sdk.server.run`.',
      );
    }
  });
  afterEach(() => cleanup());
  return ref;
}

/**
 * Boot the REAL app (import `@src/router` fresh, render it inside ThemeProvider
 * like `main.tsx`) and wait for the root loader to resolve — the HydrateFallback
 * spinner (`.animate-spin`) is shown while `loadRoot`/`initSdk` runs, then gone.
 *
 * The caller must already have pointed the realm at the backend
 * (`globalThis.__FLOWPAD_API_URL__ = …` + `vi.resetModules()`), and — if it needs
 * the SDK *before* the app mounts (e.g. to create an entity) — imported `@sdk`
 * after that reset. `bootApp` imports the router from the SAME realm (no further
 * reset), so the entity it created and the app it boots share one backend binding.
 */
export async function bootApp(): Promise<{ router: any; container: HTMLElement }> {
  const { router } = await import('@src/router');
  const { container } = render(
    React.createElement(
      ThemeProvider,
      { attribute: 'class', defaultTheme: 'dark', enableSystem: true, disableTransitionOnChange: true },
      React.createElement(RouterProvider, { router }),
    ),
  );
  await waitFor(() => expect(container.querySelector('.animate-spin')).toBeNull(), {
    timeout: 20000, // do not increase timeout without approval
  });
  return { router, container };
}

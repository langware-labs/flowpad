/**
 * Shared boot harness for the headless tests.
 *
 * Headless tests resolve the explicit disposable FLOW_INSTANCE and then mount
 * the REAL app exactly like `main.tsx`. That preamble lived in two
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
 * Returns a ref whose `.current` is null until `beforeAll` runs. Missing or
 * mismatched infrastructure fails the hook: Phase 8 never turns an infra outage
 * into a passing test. `logPrefix` tags the error with the owning file.
 */
export function setupLiveBackend(logPrefix: string): { current: LiveBackend | null } {
  const ref: { current: LiveBackend | null } = { current: null };
  beforeAll(async () => {
    const instanceName = process.env.FLOW_INSTANCE?.trim() || '';
    if (!instanceName) {
      throw new Error(
        `${logPrefix} FLOW_INSTANCE is required. Launch a disposable named instance, then run ` +
          '`FLOW_INSTANCE=<name> npm run test:vitest:headless`.',
      );
    }
    ref.current = await resolveLiveBackend(instanceName);
    if (!ref.current) {
      throw new Error(
        `${logPrefix} FLOW_INSTANCE='${instanceName}' is not a matching live instance_ctl backend ` +
          `(expected .env.${instanceName}.local, launcher identity/port/live PID, and ready bootstrap).`,
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
 * The caller must already have created a backend-bound realm with
 * `createSdkRealm`. `bootApp` imports the router from that SAME module graph (no
 * further reset), so an entity seeded through the returned SDK and the app it
 * boots share one backend binding.
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

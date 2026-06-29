/**
 * FULL-APP smoke test — boot the real app in jsdom against a live backend, with
 * zero mocks, and assert it reaches a non-error view. See `headless/CLAUDE.md`
 * for the tier rationale (in-process E2E; the realm trick; jsdom ceiling).
 *
 * Run: `cd ui && npm run test:vitest:headless` (skips if no backend is up).
 */
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { setupLiveBackend, bootApp } from './_harness';

const backend = setupLiveBackend('[headless]');

describe('full app boots against a live backend (no mocks)', () => {
  it('mounts the real router tree, runs loadRoot/bootstrap, and renders a non-error view', async () => {
    if (!backend.current) return; // soft-skip when no backend is up
    console.log(`[headless] booting full app against ${backend.current.source} → ${backend.current.apiUrl}`);

    // Point the next SDK realm at the live backend, re-evaluate the module graph,
    // then boot the real app (router + ThemeProvider) and wait for loadRoot.
    (globalThis as any).__FLOWPAD_API_URL__ = backend.current.apiUrl;
    vi.resetModules();
    const { container } = await bootApp();

    // Backend reachable + bootstrap succeeded → the root errorElement
    // (ErrorScreen "Service Unavailable") must NOT be showing, and a real view
    // rendered (not a blank tree).
    expect(screen.queryByRole('heading', { name: /service unavailable/i })).toBeNull();
    expect((container.textContent ?? '').length).toBeGreaterThan(0);

    // Cross-check the SDK realm bootstrapped against the backend (no error recorded).
    const { dataContext } = await import('@sdk');
    expect((dataContext as any).bootstrapError ?? null).toBeNull();
  });
});

/**
 * FULL-APP smoke test — boot the real app in jsdom against a live backend, with
 * zero mocks, and assert it reaches a non-error view. See `headless/CLAUDE.md`
 * for the tier rationale (in-process E2E; the realm trick; jsdom ceiling).
 *
 * Run: `cd ui && FLOW_INSTANCE=<disposable-name> npm run test:vitest:headless`.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { setupLiveBackend, bootApp } from './_harness';
import { createSdkRealm } from '../_sdk_realm';

const backend = setupLiveBackend('[headless]');

describe('full app boots against a live backend (no mocks)', () => {
  it('mounts the real router tree, runs loadRoot/bootstrap, and renders a non-error view', async () => {
    const live = backend.current;
    if (!live) throw new Error('headless backend preflight did not resolve FLOW_INSTANCE');
    console.log(`[headless] booting full app against ${live.source} → ${live.apiUrl}`);

    // Point the next SDK realm at the live backend, re-evaluate the module graph,
    // then boot the real app (router + ThemeProvider) and wait for loadRoot.
    const { sdk } = await createSdkRealm(live.apiUrl);
    const { container } = await bootApp();

    // Backend reachable + bootstrap succeeded → the root errorElement
    // (ErrorScreen "Service Unavailable") must NOT be showing, and a real view
    // rendered (not a blank tree).
    expect(screen.queryByRole('heading', { name: /service unavailable/i })).toBeNull();
    expect((container.textContent ?? '').length).toBeGreaterThan(0);

    // Cross-check the SDK realm bootstrapped against the backend (no error recorded).
    expect((sdk.dataContext as any).bootstrapError ?? null).toBeNull();
  });
});

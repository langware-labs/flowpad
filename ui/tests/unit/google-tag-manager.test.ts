// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ hubOnly: vi.fn(() => true) }));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return { ...actual, isHubOnly: mocks.hubOnly, hubModeReady: () => Promise.resolve() };
});

import { loadGoogleTagManager, measured } from '@src/utils/google-tag-manager';

const gtmScripts = (): number => document.querySelectorAll('script[src*="googletagmanager.com/gtm.js"]').length;

/** Lets the `hubModeReady()` continuation run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

describe('GTM path allowlist', () => {
  beforeEach(() => {
    vi.stubEnv('DEV', false);
    mocks.hubOnly.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    document.querySelectorAll('script[src*="googletagmanager.com"]').forEach((script) => script.remove());
  });

  it.each(['/dock/hub/home', '/launch'])('measures %s', (path) => {
    expect(measured(path)).toBe(true);
  });

  it.each([
    '/',
    '/invite/secret-token',
    '/dock/hub/home/extra',
    '/dock/hub/worldview/world',
    '/dock/home',
    '/flow_message/1',
    '/launchpad',
  ])('does not measure %s', (path) => {
    expect(measured(path)).toBe(false);
  });

  it('does not measure outside the hub', () => {
    mocks.hubOnly.mockReturnValue(false);
    expect(measured('/dock/hub/home')).toBe(false);
  });

  it('does not measure on the dev server', () => {
    vi.stubEnv('DEV', true);
    expect(measured('/dock/hub/home')).toBe(false);
  });

  it('loads nothing on a path outside the allowlist', async () => {
    loadGoogleTagManager('/invite/secret-token');
    await settle();
    expect(gtmScripts()).toBe(0);
  });

  it('loads the container once across navigations', async () => {
    loadGoogleTagManager('/dock/hub/home');
    loadGoogleTagManager('/launch');
    await settle();
    expect(gtmScripts()).toBe(1);
  });
});

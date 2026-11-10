// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ hubOnly: vi.fn(() => true) }));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return { ...actual, isHubOnly: mocks.hubOnly, hubModeReady: () => Promise.resolve() };
});

import { loadGoogleTagManager, measured } from '@src/utils/google-tag-manager';

const AGENT_ID = '11111111-2222-4333-8444-555555555555';

const gtmScripts = (): number => document.querySelectorAll('script[src*="googletagmanager.com/gtm.js"]').length;

/** Lets the `hubModeReady()` continuation run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.analytics_url_secrets.rules: FAILING? GTM reports each page's
//       full URL - never allow a page whose URL can carry a secret. Read this tag's
//       rules before editing
// flowpad:endcapsule tag
describe('GTM path allowlist', () => {
  beforeEach(() => {
    vi.stubEnv('DEV', false);
    mocks.hubOnly.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    document.querySelectorAll('script[src*="googletagmanager.com"]').forEach((script) => script.remove());
  });

  it.each([
    ['/dock/hub/home', ''],
    ['/launch', `?agent=${AGENT_ID}`],
    ['/launch', `?project=${AGENT_ID}`],
  ])('measures %s%s', (path, search) => {
    expect(measured(path, search)).toBe(true);
  });

  // Each of these reports a secret in its URL, or is a page that never loaded GTM.
  it.each([
    ['/', ''],
    ['/invite/secret-token', ''],
    ['/launch', '?repo=https://github.com/acme/private-repo'],
    ['/launch', `?repo=https://github.com/acme/private-repo&agent=${AGENT_ID}`],
    ['/launch', '?agent=not-an-id'],
    ['/launch', ''],
    ['/dock/hub/home/extra', ''],
    ['/dock/hub/worldview/world', ''],
    ['/dock/home', ''],
    ['/flow_message/1', ''],
    ['/launchpad', `?agent=${AGENT_ID}`],
  ])('does not measure %s%s', (path, search) => {
    expect(measured(path, search)).toBe(false);
  });

  it('does not measure outside the hub', () => {
    mocks.hubOnly.mockReturnValue(false);
    expect(measured('/dock/hub/home', '')).toBe(false);
  });

  it('does not measure on the dev server', () => {
    vi.stubEnv('DEV', true);
    expect(measured('/dock/hub/home', '')).toBe(false);
  });

  it('loads nothing on a path outside the allowlist', async () => {
    loadGoogleTagManager('/invite/secret-token', '');
    await settle();
    expect(gtmScripts()).toBe(0);
  });

  it('loads the container once across navigations', async () => {
    loadGoogleTagManager('/dock/hub/home', '');
    loadGoogleTagManager('/launch', `?agent=${AGENT_ID}`);
    await settle();
    expect(gtmScripts()).toBe(1);
  });
});

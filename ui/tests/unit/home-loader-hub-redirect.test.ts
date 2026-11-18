import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return { ...actual, initSdk: mocks.init, isHubOnly: () => true };
});
vi.mock('@src/routes/loaders/load-dock-pointer', () => ({ adoptScopeProject: vi.fn() }));
vi.mock('@src/routes/loaders/load-redirects', () => ({ registerLoadRedirect: vi.fn(), runLoadRedirects: vi.fn() }));
vi.mock('@src/journey/journey-load-redirect', () => ({}));
vi.mock('@src/agents/agent-auto-launch-redirect', () => ({}));
vi.mock('@src/project-home-page/project-home-page-redirect', () => ({}));

import { loadHomePage } from '@src/routes/loaders/home-loader';

/** The hub's redirect target for a request to `/` with this query. */
const redirectedTo = async (search: string): Promise<string | null> => {
  const thrown = await loadHomePage({
    request: new Request(`http://localhost/${search}`),
    params: {},
    context: {},
  } as never).catch((e: unknown) => e);
  return (thrown as Response).headers.get('Location');
};

// The hub's login callback lands on `/?signup` or `/?login`, and App.tsx reads that param
// for analytics after this redirect: dropping it reports the sign-up as a plain visit.
// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.analytics_url_secrets.rules: FAILING? forward only the login marker
//       from the root query - GA4 receives the hub home URL. Read this tag's rules before
//       editing
// flowpad:endcapsule tag
describe('hub root redirect', () => {
  it.each(['?signup', '?login'])('keeps the login callback marker %s', async (search) => {
    await expect(redirectedTo(search)).resolves.toBe(`/dock/hub/home${search}`);
  });

  // GA4 receives the hub home's URL, and Auth0's verification link can carry the visitor's address.
  it.each([
    ['?success=true&message=Your%20email%20was%20verified&email=a%40b.test&signup', '?signup'],
    ['?utm_source=x&login', '?login'],
    ['?success=true&message=Your%20email%20was%20verified&email=a%40b.test', ''],
    ['?action=open&setup_git=1', ''],
  ])('drops everything else from %s', async (search, kept) => {
    await expect(redirectedTo(search)).resolves.toBe(`/dock/hub/home${kept}`);
  });

  it('adds nothing when the request has no query', async () => {
    await expect(redirectedTo('')).resolves.toBe('/dock/hub/home');
  });
});

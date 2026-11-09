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
describe('hub root redirect', () => {
  it.each(['?signup', '?login', '?utm_source=x&signup'])('keeps the request query %s', async (search) => {
    await expect(redirectedTo(search)).resolves.toBe(`/dock/hub/home${search}`);
  });

  it('adds nothing when the request has no query', async () => {
    await expect(redirectedTo('')).resolves.toBe('/dock/hub/home');
  });
});

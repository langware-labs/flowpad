/**
 * A signed-out hub load sends the browser to login ONCE.
 *
 * `seedBootstrap` redirects a session-less hub load to `/api/v1/login`. If it
 * then resolves, the root loader finishes and the route renders — and an entry
 * page (`/project/<id>`) answers its own 401 with a SECOND login redirect. Two
 * concurrent Auth0 authorizations overwrite each other's `state`, the callback
 * fails its CSRF check and lands the user on `/` instead of the page they opened.
 * Measured on app.flowpad.ai: 2 `/api/v1/login` requests per load, callback
 * `307 → /` on 4 of 8 runs; with the redirect held, 1 request and 0 of 8.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSdkRealm, disposeAllOwnedSdkRealms } from '../_sdk_realm';

const PROJECT_PATH = '/project/033ec95f-31ce-406b-9ced-2f0e17898413';

async function signedOutHubRealm() {
  const realm = await createSdkRealm('http://localhost:8093/api/v1');
  realm.sdk.setSupportedPagesForHubMode(['hub']);
  const assign = vi.fn();
  vi.stubGlobal('location', {
    pathname: PROJECT_PATH,
    search: '',
    href: `https://app.flowpad.ai${PROJECT_PATH}`,
    assign,
  });
  return { sdk: realm.sdk, assign };
}

const settledWithin = (promise: Promise<unknown>) =>
  Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 50))]);

afterEach(() => {
  disposeAllOwnedSdkRealms();
  vi.unstubAllGlobals();
});

describe('CloudManager.seedBootstrap — signed-out hub load', () => {
  it('redirects to login and never lets the app go on to render', async () => {
    const { sdk, assign } = await signedOutHubRealm();
    const seeded = sdk.cloudManager.seedBootstrap({ user: null });
    expect(await settledWithin(seeded)).toBe(false);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/api/v1/login?${new URLSearchParams({ target_path: PROJECT_PATH })}`);
  });

  it('lets an anonymous entry route render without a redirect', async () => {
    const { sdk, assign } = await signedOutHubRealm();
    const seeded = sdk.cloudManager.seedBootstrap({ user: null }, { allowAnonymous: true });
    expect(await settledWithin(seeded)).toBe(true);
    expect(assign).not.toHaveBeenCalled();
  });
});

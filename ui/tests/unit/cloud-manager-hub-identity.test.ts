import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSdkRealm, disposeAllOwnedSdkRealms } from '../_sdk_realm';

const HUB_USER = {
  type: 'user',
  id: '4f967af8-a65f-4e29-93df-4ac42aeb18ae',
  name: 'Hub Alice',
  email: 'alice@hub.test',
};

const LOCAL_USER = {
  type: 'user',
  id: '61bb515d-228f-4b66-80b8-834afcd347c6',
  name: 'Local Alice',
  email: 'alice@local.test',
};

const HUB_ORIGIN = 'https://hub.test';
const originalLocation = window.location;

async function createIdentityRealm(apiUrl: string) {
  const realm = await createSdkRealm(apiUrl);
  // Fresh SDK imports may schedule unrelated readiness probes. Keep this unit
  // suite hermetic; the assertions below separately prove auth does not use
  // the desktop-only POST routes.
  vi.spyOn(realm.sdk.apiClient, 'get').mockResolvedValue(null as never);
  vi.spyOn(realm.sdk.apiClient, 'post').mockResolvedValue(null as never);
  return realm;
}

afterEach(() => {
  (window as unknown as { location: Location }).location = originalLocation;
  disposeAllOwnedSdkRealms();
  // Keep the final realm's HTTP stubs alive for the unit tier's afterAll leak
  // tripwire, which lazily imports the current SDK realm.
  vi.clearAllMocks();
});

describe('CloudManager hub identity', () => {
  it('adopts the bootstrap user as the cloud identity and uses the configured hub origin', async () => {
    const { sdk } = await createIdentityRealm(`${HUB_ORIGIN}/api/v1`);
    sdk.setSupportedPagesForHubMode(['hub']);

    await sdk.cloudManager.bootstrap({
      user: HUB_USER,
      desktop_info: null,
    });

    expect(sdk.cloudManager.loginStatus).toBe('logged_in');
    expect(sdk.cloudManager.isLoggedIn).toBe(true);
    expect(sdk.cloudManager.currentUser).toMatchObject({
      name: HUB_USER.name,
      email: HUB_USER.email,
    });
    expect(sdk.cloudManager.currentUser?.typeId.toString()).toBe(`user-${HUB_USER.id}`);
    expect(sdk.cloudManager.cloudUrl).toBe(HUB_ORIGIN);
    expect(sdk.dataContext.cloudLoginAvailable).toBe(true);
    expect(sdk.dataContext.cloudUser).toBe(sdk.cloudManager.currentUser);
    expect(sdk.dataContext.cloudUserTypeId?.toString()).toBe(`user-${HUB_USER.id}`);
  });

  it('maps an absent bootstrap user to a logged-out identity and redirects to hub login', async () => {
    const { sdk } = await createIdentityRealm(`${HUB_ORIGIN}/api/v1`);
    sdk.setSupportedPagesForHubMode(['hub']);

    // The hub surface has no anonymous mode: a session-less bootstrap must
    // send the browser to the provider login rather than render signed-out.
    const assign = vi.fn();
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      origin: originalLocation.origin,
      href: originalLocation.href,
      pathname: '/dock/hub/home',
      search: '',
      assign,
    };

    await sdk.cloudManager.bootstrap({
      user: null,
      desktop_info: null,
    });

    expect(sdk.cloudManager.loginStatus).toBe('logged_out');
    expect(sdk.cloudManager.isLoggedIn).toBe(false);
    expect(sdk.cloudManager.currentUser).toBeNull();
    expect(sdk.cloudManager.cloudUrl).toBe(HUB_ORIGIN);
    expect(sdk.dataContext.cloudLoginAvailable).toBe(false);
    expect(sdk.dataContext.cloudUser).toBeNull();
    expect(sdk.dataContext.cloudUserTypeId).toBeNull();
    // Deep link preserved: target_path returns the browser to the URL it
    // asked for once the provider round-trip completes.
    expect(assign).toHaveBeenLastCalledWith('/api/v1/login?target_path=%2Fdock%2Fhub%2Fhome');
  });

  it('redirects through hub auth routes without desktop API or secret probes', async () => {
    const { sdk } = await createIdentityRealm(`${HUB_ORIGIN}/api/v1`);
    sdk.setSupportedPagesForHubMode(['hub']);

    // Mocked BEFORE bootstrap: a user-less hub bootstrap itself navigates to
    // login now, and jsdom's real location.assign is unimplemented.
    const assign = vi.fn();
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      origin: originalLocation.origin,
      href: originalLocation.href,
      pathname: '/',
      search: '',
      assign,
    };

    await sdk.cloudManager.bootstrap({
      user: null,
      desktop_info: null,
    });
    expect(assign).toHaveBeenLastCalledWith('/api/v1/login');

    const post = vi.mocked(sdk.apiClient.post);
    post.mockClear();
    const secretProbe = vi.spyOn(sdk.secretsService, 'isEnabled');

    await sdk.cloudManager.login();
    expect(assign).toHaveBeenLastCalledWith('/api/v1/login');
    expect(post).not.toHaveBeenCalled();
    expect(secretProbe).not.toHaveBeenCalled();

    // Logout is a top-level navigation to the hub's OWN /logout, not to
    // /login: the hub chain (/logout → IdP /v2/logout → returnTo) is what
    // actually ends the SSO session. Sending the browser straight to /login
    // left that session alive, so the next /login silently re-authenticated
    // the same account and logout appeared to do nothing.
    await sdk.cloudManager.logout();
    expect(assign).toHaveBeenLastCalledWith('/api/v1/logout');
    expect(post).not.toHaveBeenCalled();
    expect(secretProbe).not.toHaveBeenCalled();
  });

  it('mirrors the existing connection manager slot in hub mode', async () => {
    const { sdk } = await createIdentityRealm(`${HUB_ORIGIN}/api/v1`);
    sdk.setSupportedPagesForHubMode(['hub']);

    await sdk.cloudManager.bootstrap({
      user: HUB_USER,
      desktop_info: null,
    });

    sdk.connectionManager.emit('connection_status_changed', {
      status: 'connected',
      error: null,
    });
    expect(sdk.cloudManager.connectionSlot).toEqual({ status: 'connected', error: null });

    sdk.connectionManager.emit('connection_status_changed', {
      status: 'error',
      error: 'socket closed',
    });
    expect(sdk.cloudManager.connectionSlot).toEqual({ status: 'error', error: 'socket closed' });
  });

  it('keeps desktop cloud identity separate from the bootstrap local user', async () => {
    const { sdk } = await createIdentityRealm('http://localhost:6001/api/v1');
    sdk.setSupportedPagesForHubMode(['desk']);

    await sdk.cloudManager.bootstrap({
      user: LOCAL_USER,
      desktop_info: {
        cloud_url: 'https://cloud.flowpad.test',
        login: { status: 'logged_out', user: null, reason: null },
        connection: { status: 'verified', error: null },
      },
    });

    expect(sdk.cloudManager.loginStatus).toBe('logged_out');
    expect(sdk.cloudManager.currentUser).toBeNull();
    expect(sdk.dataContext.cloudUser).toBeNull();
    expect(sdk.cloudManager.cloudUrl).toBe('https://cloud.flowpad.test');
    expect(sdk.cloudManager.connectionSlot).toEqual({ status: 'verified', error: null });

    sdk.connectionManager.emit('connection_status_changed', {
      status: 'disconnected',
      error: null,
    });
    expect(sdk.cloudManager.connectionSlot).toEqual({ status: 'verified', error: null });
  });

  it('adopts the cloud identity from the bootstrap seed alone', async () => {
    // The sandbox identity race. A cloud sandbox is signed in by the hub over
    // loopback, but the box's own bootstrap carried no cloud user — so the UI
    // painted `currentUser = cloudUser ?? localUser`, i.e. the template's local
    // user ("E2B Local"), and only corrected itself once an async /cloud/status
    // landed. On a cold resume that call loses the race against the still-waking
    // backend, and the wrong account is what the user sees.
    //
    // This file stubs /cloud/status to null (see beforeEach), and THAT STUB IS
    // THE RACE: it reproduces "the status call never lands". So everything
    // asserted below has to come from the bootstrap seed by itself.
    const { sdk } = await createIdentityRealm('http://localhost:6001/api/v1');
    sdk.setSupportedPagesForHubMode(['desk']);

    await sdk.cloudManager.bootstrap({
      user: LOCAL_USER,
      desktop_info: {
        cloud_url: 'https://cloud.flowpad.test',
        login: {
          status: 'logged_in',
          user: { id: 'b0b00000-0000-4000-8000-000000000001', type: 'user', email: 'bob@local.test', name: 'Bob' },
          reason: null,
        },
        connection: { status: 'connecting', error: null },
      },
    });

    expect(sdk.cloudManager.loginStatus).toBe('logged_in');
    expect(sdk.dataContext.cloudUser?.email).toBe('bob@local.test');
    // The whole point: `currentUser` is `cloudUser ?? localUser`, so an unset
    // cloudUser is what made the box render its own local account. (localUser is
    // seeded by the SDK bootstrap in main.ts, not by cloudManager.bootstrap, so
    // this test does not exercise the `??` fallback itself — the sibling test
    // above covers the logged-out side.)
    expect(sdk.dataContext.currentUser?.email).toBe('bob@local.test');
  });

  it('bypasses desktop secret provisioning before hub navigation login', async () => {
    const { sdk } = await createIdentityRealm(`${HUB_ORIGIN}/api/v1`);
    sdk.setSupportedPagesForHubMode(['hub']);
    const secretProbe = vi.spyOn(sdk.secretsService, 'isEnabled');
    const login = vi.spyOn(sdk.cloudManager, 'login').mockResolvedValue(undefined);
    vi.spyOn(sdk.dataContext, 'setActiveEntityTypeId').mockResolvedValue(undefined);

    await sdk.navigator.navigateToLogin();

    expect(secretProbe).not.toHaveBeenCalled();
    expect(login).toHaveBeenCalledOnce();
  });
});

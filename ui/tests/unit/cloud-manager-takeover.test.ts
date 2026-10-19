/**
 * `CloudManager.takenOver` — the sticky flag `SessionTakenOverOverlay` reads
 * (FLOWPAD-2151/2153: a shared sandbox's login switch must block an
 * already-open tab, not just quietly re-render it as the new account).
 *
 * Measured live against a real backend: the incoming person's LOGGED_IN
 * broadcast lands ~50ms after the outgoing person's LOGGED_OUT(reason=
 * switched_out) one — well under one animation frame apart on a local
 * connection. A naive `login.status === 'logged_out'` check (what this
 * replaced) renders for a single frame and is gone before a human can read
 * it, let alone click it. These tests exist specifically to catch that
 * regression: `takenOver` must survive the subsequent LOGGED_IN, not just
 * the instant right after the switch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSdkRealm, disposeAllOwnedSdkRealms } from '../_sdk_realm';

const LOCAL_USER = {
  type: 'user',
  id: '61bb515d-228f-4b66-80b8-834afcd347c6',
  name: 'Alice',
  email: 'alice@local.test',
};
const OTHER_USER = { type: 'user', id: 'b0b00000-0000-4000-8000-000000000001', name: 'Bob', email: 'bob@local.test' };

// `on_cloud_login_status_msg`'s handler is registered with `void this._onCloudLoginStatusMsg(msg)` —
// fired, not awaited — and `_setLoggedOut` itself awaits `_dataContext()` before
// touching `takenOver`. `emit()` returns before that settles, so every assertion
// below needs one real tick for the already-scheduled microtasks to drain.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function bootedRealm() {
  const realm = await createSdkRealm('http://localhost:6001/api/v1');
  vi.spyOn(realm.sdk.apiClient, 'get').mockResolvedValue(null as never);
  vi.spyOn(realm.sdk.apiClient, 'post').mockResolvedValue(null as never);
  realm.sdk.setSupportedPagesForHubMode(['desk']);
  await realm.sdk.cloudManager.bootstrap({
    user: LOCAL_USER,
    desktop_info: {
      cloud_url: 'https://cloud.flowpad.test',
      login: { status: 'logged_in', user: LOCAL_USER, reason: null },
      connection: { status: 'connected', error: null },
    },
  });
  return realm;
}

afterEach(() => {
  disposeAllOwnedSdkRealms();
  vi.clearAllMocks();
});

describe('CloudManager.takenOver', () => {
  it('starts false', async () => {
    const { sdk } = await bootedRealm();
    expect(sdk.cloudManager.takenOver).toBe(false);
  });

  it('turns on when login_callback reports a real cross-account switch', async () => {
    const { sdk } = await bootedRealm();

    sdk.connectionManager.emit('on_cloud_login_status_msg', {
      message_type: 'cloud_login_status_msg',
      status: 'logged_out',
      user: null,
      reason: sdk.LogoutReason.SwitchedOut,
    });
    await flush();

    expect(sdk.cloudManager.takenOver).toBe(true);
  });

  it('does NOT turn on for an explicit self-logout (no reason)', async () => {
    const { sdk } = await bootedRealm();

    sdk.connectionManager.emit('on_cloud_login_status_msg', {
      message_type: 'cloud_login_status_msg',
      status: 'logged_out',
      user: null,
      reason: null,
    });
    await flush();

    expect(sdk.cloudManager.takenOver).toBe(false);
  });

  it('does NOT turn on for an unrelated logout reason (e.g. an expired/rejected token)', async () => {
    const { sdk } = await bootedRealm();

    sdk.connectionManager.emit('on_cloud_login_status_msg', {
      message_type: 'cloud_login_status_msg',
      status: 'logged_out',
      user: null,
      reason: 'rejected',
    });
    await flush();

    expect(sdk.cloudManager.takenOver).toBe(false);
  });

  it("THE REGRESSION: stays true once the incoming person's LOGGED_IN broadcast lands", async () => {
    const { sdk } = await bootedRealm();

    sdk.connectionManager.emit('on_cloud_login_status_msg', {
      message_type: 'cloud_login_status_msg',
      status: 'logged_out',
      user: null,
      reason: sdk.LogoutReason.SwitchedOut,
    });
    await flush();
    expect(sdk.cloudManager.takenOver).toBe(true);

    // The very next broadcast on a real switch: the OTHER person's login
    // completing. Before the sticky flag, this raced the transient
    // `login.status` back to 'logged_in' and the overlay vanished.
    sdk.connectionManager.emit('on_cloud_login_status_msg', {
      message_type: 'cloud_login_status_msg',
      status: 'logged_in',
      user: OTHER_USER,
      reason: null,
    });
    await flush();

    expect(sdk.cloudManager.loginStatus).toBe('logged_in'); // the live status DID move on...
    expect(sdk.cloudManager.takenOver).toBe(true); // ...but the sticky block must not.
  });

  it('clears immediately when a LOCAL login attempt starts (before it even resolves)', async () => {
    const { sdk } = await bootedRealm();
    sdk.connectionManager.emit('on_cloud_login_status_msg', {
      message_type: 'cloud_login_status_msg',
      status: 'logged_out',
      user: null,
      reason: sdk.LogoutReason.SwitchedOut,
    });
    await flush();
    expect(sdk.cloudManager.takenOver).toBe(true);

    // Fire-and-forget on purpose: `_takenOver = false` is the first, synchronous
    // statement in login(), before any await — clicking "Log in" must dismiss
    // the overlay instantly, not once some downstream network call resolves.
    const attempt = sdk.cloudManager.login().catch(() => undefined);
    expect(sdk.cloudManager.takenOver).toBe(false);
    await attempt;
  });
});

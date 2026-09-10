/**
 * FLOWPAD-2125 — an authorization refusal is an error to log, not a logout.
 *
 * The hub answers `POST compute_node/<id>/ops/status` with 401 when the caller
 * is only `admin` on a SHARED machine: `ops` resolves for `owner` alone, which
 * is a deliberate product decision and stays. The denial is therefore PERMANENT
 * and will arrive on every page load for every shared box — which is precisely
 * why the client must absorb it quietly.
 *
 * It used to do the opposite, in two places, both keyed off the status code:
 *
 *   ts_sdk/src/client.ts:163   → alert(statusText, msg, 'warning')   // popup
 *   ts_sdk/src/FlowSync/auth.ts:154
 *       const isAuthError = status === 401 || status === 403 || <token msgs>;
 *       if (isAuthError) {
 *         this.currentUser = null;                            // → read scope 'anonymous'
 *         this.setLoginStatus('logged_out', null, 'expired');
 *       }
 *
 * Both are axios RESPONSE interceptors, so they run before the rejection ever
 * reaches the caller: `ui/src/hooks/use-sandboxes.ts:472` already wraps its
 * probe in `try { … } catch { … }` and is powerless to stop either one.
 *
 * Desired behavior: no logout, no popup — the error rejects to the caller and
 * is written to the console, nothing more. Authentication and authorization are
 * different answers; only "your token is invalid" may end a session.
 *
 * ── What this test can and cannot reach ────────────────────────────────────
 * The refusal driven here is the local backend's own authority gate
 * (`flow_sdk/app/actions/task_assign_action.py:124` → 403 "Cloud login required
 * to assign-task"): an authenticated session, a real entity it owns, one action
 * it is not authorized to perform. Same class as the hub's `ops` denial; the
 * status digit differs (403 here, 401 there). Nothing is mocked or hand-forced;
 * the backend really refuses.
 *
 * A hub 401 takes a second step this test cannot reach: a policy denial carries
 * no `error_code`, so `auth.ts` settles it by re-checking the credential against
 * `current-user` (`sessionStillValid`). Exercising that needs a real hub policy
 * denial, i.e. the two-instance `tests/hub` tier.
 *
 * The local backend has no entity-level ACL and cannot 401 an AUTHENTICATED
 * caller — every 401 it has requires no actor at all. So the popup assertion
 * below is a GUARD, not a reproduction: `client.ts` pops on 401 only, so it
 * already holds for this 403. Reproducing that half needs a real hub policy
 * denial, i.e. the two-instance `tests/hub` tier.
 *
 * Entry is the product's own seam: `ActionInfo` + `dataManager.callAction`, the
 * exact pair `ComputeNode.ops()` uses to reach `ops/status`.
 */
import { ActionInfo, authManager, config, dataManager, Task, type User } from '@sdk';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { trackTypeId } from '../_cleanup';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

/** Create the task over raw HTTP so setup never touches the interceptors under test. */
async function saveLocalTask(): Promise<string> {
  const id = crypto.randomUUID();
  const r = await fetch(`${config.SERVER_URL}/graph/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, type: Task.type, name: 'auth-denial-keeps-session' }),
  });
  if (!r.ok) throw new Error(`saveLocalTask failed: ${r.status} ${await r.text()}`);
  trackTypeId(Task.type, id);
  return id;
}

describe('api: an authorization denial keeps the session', () => {
  let user: User;

  beforeAll(async (context: any) => {
    const localUser = await apiTestSetup(getTestSignupInfo(), context.task?.name ?? 'auth_denial_keeps_session');
    if (!localUser) throw new Error('bootstrap returned no user');
    user = localUser;
    // The real sign-in path — `ts_sdk/src/main.ts:160` does exactly this.
    await authManager.init(user);
  });

  it('logs the error, shows no popup, and leaves the logged-in user in place', async () => {
    expect(authManager.isLoggedIn).toBe(true);

    const taskId = await saveLocalTask();

    // Same shape as `ComputeNode.ops('status')`: an ActionInfo aimed at one
    // entity, dispatched through dataManager.
    const denied = new ActionInfo('assign-task', Task.type, taskId, 'POST');
    denied.bodyParameters = { email: 'not-a-member@example.test' };

    const popups: Event[] = [];
    const onAlert = (e: Event) => popups.push(e);
    window.addEventListener('alert', onAlert);
    const consoleLog = vi.spyOn(console, 'log');

    const error = await dataManager.callAction(denied).then(
      () => null,
      (e: any) => e,
    );

    window.removeEventListener('alert', onAlert);
    const logged = consoleLog.mock.calls.some((args) => String(args[0]).includes('API call error'));
    consoleLog.mockRestore();

    // The refusal really happened, and it is an authorization refusal — not a
    // 404, not a 5xx. If this ever stops being 403 the rest proves nothing.
    expect(error?.response?.status).toBe(403);
    expect(error?.response?.data?.message).toContain('Cloud login required');

    // It reached the caller, which is what lets a screen decide what to render.
    expect(error).toBeTruthy();
    // And it was written to the console rather than swallowed.
    expect(logged).toBe(true);

    // No popup: a machine the user is not owner of will refuse on every load,
    // so a toast per denial is noise, not information.
    expect(popups).toHaveLength(0);

    // The bug: the denial is on ONE action against ONE entity. It says nothing
    // about the session's credentials, so the session must survive it.
    expect(authManager.currentUser).not.toBeNull();
    expect(authManager.currentUser?.typeId?.toString()).toBe(user.typeId.toString());
    expect(authManager.loginStatus).toBe('logged_in');
    expect(authManager.isLoggedIn).toBe(true);
  }, 15_000);
});

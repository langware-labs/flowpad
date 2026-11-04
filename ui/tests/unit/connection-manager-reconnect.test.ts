import { describe, expect, it, vi } from 'vitest';

import { authManager } from '@sdk/FlowSync/auth';
import { ConnectionManager, WS_CLOSE_AUTH, WS_CLOSE_REPLACED } from '@sdk/websocket';

// Prod 2026-11-03: a dropped hub socket must reconnect at once, and a tab
// refused for a missing token must not redial the same refusal every ~2s.
function managerWithDialSpy() {
  const manager = new ConnectionManager();
  const dial = vi.spyOn(manager, 'connect').mockResolvedValue(undefined);
  return { manager, dial };
}

const close = (code: number, reason = '') => ({ code, wasClean: true, reason }) as CloseEvent;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ConnectionManager reconnect', () => {
  it('redials immediately after a socket that lived drops', async () => {
    const { manager, dial } = managerWithDialSpy();
    (manager as any).reconnectAttempts = 5; // earlier failed dials must not delay this one
    manager.onClose(close(1006), true);
    await tick();
    expect(dial).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it('waits for a credential after an auth refusal, then dials at once', async () => {
    const { manager, dial } = managerWithDialSpy();
    manager.onClose(close(WS_CLOSE_AUTH, 'Missing token'), true);
    await tick();
    expect(dial).not.toHaveBeenCalled();

    manager.retryIfParked(); // sign-in / tab focus / back online
    expect(dial).toHaveBeenCalledOnce();
    manager.retryIfParked(); // not parked any more: no second dial
    expect(dial).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it('a sign-in wakes a socket parked on an auth refusal', async () => {
    const { manager, dial } = managerWithDialSpy();
    await tick(); // the manager subscribes to the auth module lazily
    manager.onClose(close(WS_CLOSE_AUTH, 'Missing token'), true);
    authManager.emit('login_status_changed', { status: 'logged_in' });
    expect(dial).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it('does not redial when a newer socket with its id replaced it', async () => {
    const { manager, dial } = managerWithDialSpy();
    manager.onClose(close(WS_CLOSE_REPLACED, 'replaced'), true);
    await tick();
    expect(dial).not.toHaveBeenCalled();
    manager.dispose();
  });
});

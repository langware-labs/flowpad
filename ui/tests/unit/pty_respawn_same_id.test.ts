/**
 * A →CLI switch kills the PTY and the →PTY switch back respawns it under the
 * SAME pty id. The connection must forget the dead attach (`markPtyGone`) or
 * the re-attach is a no-op and the pane stays blank whenever the terminal
 * mounted too late to catch `restarted`. Without the reset, a plain attach to
 * the reused id sends nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { subpath: string }[] = [];

vi.mock('../../../ts_sdk/src/APIEntity', () => ({
  dataManager: {
    callActionOverWS: vi.fn((action: { subpath: string }) => {
      calls.push({ subpath: action.subpath });
      return Promise.resolve({ status: 'attached' });
    }),
  },
}));

vi.mock('../../../ts_sdk/src/websocket', () => ({
  ConnectionManager: { getInstance: () => ({ id: 'conn-1', on: () => {}, off: () => {} }) },
}));

import { dataContext } from '../../../ts_sdk/src/FlowSync/context';
import { PtyConnection } from '../../../ts_sdk/src/services/shell/ptyConnection';

const attaches = () => calls.filter((c) => c.subpath === 'attach').length;

describe('PtyConnection respawn under the same pty id', () => {
  beforeEach(() => {
    calls.length = 0;
    dataContext.connection = {} as WebSocket;
  });
  afterEach(() => {
    dataContext.connection = null;
  });

  it('a stale attach makes the re-attach a no-op', async () => {
    const pc = new PtyConnection('shell-1', 'node-1');
    await pc.attach('shell-1');
    await pc.attach('shell-1');
    expect(attaches()).toBe(1);
  });

  it("a plain attach joins the terminal's forced attach in flight — one connect, not two", async () => {
    const pc = new PtyConnection('shell-1', 'node-1');
    const forced = pc.attach('shell-1', { force: true });
    const joined = pc.attach('shell-1');
    await Promise.all([forced, joined]);
    expect(attaches()).toBe(1);
  });

  it('after markPtyGone the re-attach reaches the backend', async () => {
    const pc = new PtyConnection('shell-1', 'node-1');
    await pc.attach('shell-1');
    pc.markPtyGone();
    expect(pc.attached).toBe(false);
    await pc.attach('shell-1');
    expect(attaches()).toBe(2);
    expect(pc.attached).toBe(true);
  });
});

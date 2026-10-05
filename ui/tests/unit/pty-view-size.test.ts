/**
 * A PTY has ONE winsize, shared by every client attached to it — whoever sizes it last wins.
 * The view on screen owns it: PtyConnection keeps the size that view claims (never dropped for
 * "not connected yet") and asserts it on every attach. A window-sized guess is a spawn seed for a
 * NEW pty only; asserted on a live one it resized every session away from its real width on entry
 * (prod 2026-10-05: every attach sent 142x42 to terminals fitted at 116x40).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { subpath: string; body: Record<string, unknown> }[] = [];
let attachGate: Promise<void> | null = null;

vi.mock('../../../ts_sdk/src/APIEntity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dataManager: {
    callActionOverWS: vi.fn(async (action: { subpath: string; bodyParameters: Record<string, unknown> }) => {
      calls.push({ subpath: action.subpath, body: action.bodyParameters });
      if (action.subpath === 'attach' && attachGate) await attachGate;
      return { status: 'attached' };
    }),
  },
}));

vi.mock('../../../ts_sdk/src/websocket', () => ({
  ConnectionManager: { getInstance: () => ({ id: 'conn-1', on: () => {}, off: () => {} }) },
}));

import { dataContext } from '../../../ts_sdk/src/FlowSync/context';
import { PtyConnection } from '../../../ts_sdk/src/services/shell/ptyConnection';

const sent = (subpath: string) => calls.filter((c) => c.subpath === subpath).map((c) => c.body);
const size = (b: Record<string, unknown>) => (b.cols === undefined ? null : `${Number(b.cols)}x${Number(b.rows)}`);

describe('PtyConnection view size', () => {
  beforeEach(() => {
    calls.length = 0;
    attachGate = null;
    dataContext.connection = {} as WebSocket;
  });
  afterEach(() => {
    dataContext.connection = null;
  });

  it('a size claimed before the PTY is live is kept, and the attach asserts it', async () => {
    const pc = new PtyConnection('s1', 'node-1');
    await pc.resize(116, 40); // the view fitted before its shell attached
    expect(sent('resize')).toEqual([]);

    await pc.attach('s1');
    expect(sent('attach').map(size)).toEqual(['116x40']);
    expect(sent('resize')).toEqual([]); // the attach already carried it
  });

  it('with no view on screen the attach asserts no size: the backend repaints at the current one', async () => {
    const pc = new PtyConnection('s2', 'node-1');
    await pc.attach('s2');
    expect(sent('attach').map(size)).toEqual([null]);
  });

  it('a size claimed while the attach is in flight is sent once it lands', async () => {
    const pc = new PtyConnection('s3', 'node-1');
    let open!: () => void;
    attachGate = new Promise((r) => (open = r));
    const attaching = pc.attach('s3');
    await vi.waitFor(() => expect(sent('attach')).toHaveLength(1));

    await pc.resize(116, 40); // not started yet → kept
    open();
    await attaching;
    await vi.waitFor(() => expect(sent('resize').map(size)).toEqual(['116x40']));
  });

  it('a live resize is always sent — another client may hold the PTY at a different size', async () => {
    const pc = new PtyConnection('s4', 'node-1');
    await pc.attach('s4');
    await pc.resize(116, 40);
    await pc.resize(116, 40); // unchanged here, but the PTY may be at another window's size
    expect(sent('resize').map(size)).toEqual(['116x40', '116x40']);
  });

  it('a released size is not asserted by a later re-attach', async () => {
    const pc = new PtyConnection('s5', 'node-1');
    await pc.resize(116, 40);
    await pc.attach('s5');
    pc.releaseViewSize(); // the view went off screen
    await pc.attach('s5', { force: true }); // e.g. the reconnect hook
    expect(sent('attach').map(size)).toEqual(['116x40', null]);
  });
});

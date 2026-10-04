/**
 * PtyConnection typeahead: keystrokes typed before a terminal's FIRST attach
 * reach the shell once it attaches, in order — a view mounts its xterm before
 * the attach completes, and what a person types in that gap must not be lost.
 * A pane that was live and then dropped still refuses input (no stale replay).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { subpath: string; body: Record<string, unknown> }[] = [];

vi.mock('../../../ts_sdk/src/APIEntity', () => ({
  dataManager: {
    callActionOverWS: vi.fn(async (action: { subpath: string; bodyParameters: Record<string, unknown> }) => {
      calls.push({ subpath: action.subpath, body: action.bodyParameters });
      return { status: 'attached' };
    }),
  },
}));

vi.mock('../../../ts_sdk/src/websocket', () => ({
  ConnectionManager: { getInstance: () => ({ id: 'conn-1', on: () => {}, off: () => {} }) },
}));

import { dataContext } from '../../../ts_sdk/src/FlowSync/context';
import { PtyConnection } from '../../../ts_sdk/src/services/shell/ptyConnection';

function inputs(): string[] {
  return calls.filter((c) => c.subpath === 'input').map((c) => String(c.body.data));
}

describe('PtyConnection typeahead', () => {
  beforeEach(() => {
    calls.length = 0;
    // isLive needs a WS; any non-null connection is "connected".
    dataContext.connection = {} as WebSocket;
  });
  afterEach(() => {
    dataContext.connection = null;
  });

  it('holds keystrokes typed before the first attach and sends them, in order, once it attaches', async () => {
    const pc = new PtyConnection('shell-1', 'node-1');
    await pc.sendInput('echo ');
    await pc.sendInput('marker');
    await pc.sendInput('\r');
    expect(inputs()).toEqual([]); // nothing to send to yet

    await pc.attach('shell-1');
    await vi.waitFor(() => expect(inputs()).toEqual(['echo marker\r']));
  });

  it('a pane that was live and then dropped still refuses input', async () => {
    const pc = new PtyConnection('shell-2', 'node-1');
    await pc.attach('shell-2');
    pc.started = false; // the PTY went away
    await pc.sendInput('stale');
    pc.started = true;
    await pc.sendInput('fresh');
    expect(inputs()).toEqual(['fresh']);
  });
});

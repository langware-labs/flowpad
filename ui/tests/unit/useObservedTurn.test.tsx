/**
 * `useObservedTurn` opens the read-only `observe-turn` stream for ANY busy,
 * non-sending client — headless (`pty_mode === false`) included. That is the
 * only live source a client has for a turn a *different* client is driving
 * through its own `prompt()` (that path streams to the sender's own HTTP
 * response only; it never broadcasts over the WS) — the normal cross-browser
 * / second-tab case this hook exists for.
 *
 * A headless queue-drained turn is a separate case where the backend's
 * `emit_flow_data` DOES also broadcast the same content over the WS while
 * `observe-turn` is open, which is what produced the FLOWPAD-2022 double
 * render. That is fixed downstream, in `FlowDataStream` (see
 * `tests/unit/queued-turn-renders-once.test.ts`) — not by suppressing this
 * hook, which would silently break the cross-browser case this test guards.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, TypeId, dataManager } from '@sdk';
import { useObservedTurn } from '@src/components/entity-execution-panel/hooks/useObservedTurn';

const PROC_ID = '1c0f3e10-bea5-429e-8270-56dba77915b1';
const PROC_TYPEID = new TypeId(AgenticProcess.type, PROC_ID);

afterEach(async () => {
  vi.restoreAllMocks();
  await dataManager.clearCache();
});

describe.each([
  ['headless', false],
  ['PTY', true],
])('useObservedTurn — busy %s process this client did not start', (_label, pty_mode) => {
  it('opens observe-turn', async () => {
    const ap = new AgenticProcess({ id: PROC_ID, pty_mode, busy: true, visible: false });
    dataManager.register_new_entity(PROC_TYPEID, ap);
    const spy = vi.spyOn(ap, 'observeTurn').mockResolvedValue(undefined);

    renderHook(() => useObservedTurn(ap));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });
});

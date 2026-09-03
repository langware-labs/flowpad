/**
 * A SECOND signed-out turn must re-open the harness-login modal.
 *
 * The user logs out outside FlowPad (`claude /logout` in their own terminal),
 * types in vibe mode, and the turn is refused: the modal opens carrying "Claude
 * said: Not logged in · Please run /login". They dismiss it, type again, and the
 * turn is refused again — and nothing happens. Only the composer's small red
 * "Error" chip appears, which is driven by `worker_status` and is a different
 * field from the one the modal is triggered by.
 *
 * The trigger is `useHarnessLoginOnAuthError(process.worker_status_detail, …)`,
 * whose effect deps are `[detail, workerType]`. Every signed-out turn produces
 * the byte-identical sentence, so on the second refusal React sees unchanged
 * deps and skips the effect entirely — instrumenting the hook showed the second
 * turn emits no probe line at all, so it never even reaches the latch at :78.
 * `worker_status_detail` is NOT empty on that turn: the real backend
 * `tail_status_detail()` was run against the real transcript that opened the
 * modal, and against that transcript with a second signed-out turn appended,
 * and returned the same string both times.
 *
 * Entry is the real path: `ChatActivityLine` is what mounts the hook in the
 * product (`ChatActivityLine.tsx:98`, rendered by `EntityExecutionPanel:936`,
 * which vibe reaches through `vibe-chat-pane.tsx:209` passing `dense`). The
 * process is a real `AgenticProcess` entity watched through the real `useEntity`,
 * and every turn transition arrives as a real `data_op_msg` through
 * `ConnectionManager.onMessage` — the function the WebSocket calls with a
 * decoded backend frame — so each one runs the real DataManager merge and the
 * real subscriber notify.
 *
 * The ONE stand-in is the HTTP transport (`apiClient`), serving the rows a
 * backend would: jsdom has no server, and this bug is pure client-side state
 * derivation, so the transport is the boundary the harness has to supply.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, capabilityManager, CapabilityKinds, ConnectionManager, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { useEntity } from '@src/hooks/entity-hooks';
import { ChatActivityLine } from '@src/components/entity-execution-panel/ChatActivityLine';
import { useHarnessLoginStore } from '@src/components/harness-login/harness-login-store';

const CLAUDE = CapabilityKinds.ClaudeCode;
const CLAUDE_ID = '6f1a4f2e-8c5d-4c2b-9f77-2a0f5c9d3e11';
const PROCESS_ID = '9c2d7b10-4e3a-4a51-8f0b-1d6c4e7a9b22';

/** The sentence Claude Code writes on a signed-out turn. Byte-identical every
 *  time — confirmed on five real transcripts spanning 17 Aug → 1 Sep, each
 *  carrying `error: 'authentication_failed'` and its own entry `uuid`. */
const DENIAL = 'Not logged in · Please run /login';

const claudeRow = () => ({
  type: 'capability',
  id: CLAUDE_ID,
  name: 'Claude Code',
  kind: CLAUDE,
  state: 'ready',
  auth_mode: 'device',
  last_check: { available: true, message: '' },
});

const processRow = (overrides: Record<string, unknown> = {}) => ({
  type: AgenticProcess.type,
  id: PROCESS_ID,
  name: 'vibe chat',
  worker_type: 'claude_code',
  ...overrides,
});

/** A turn that was refused: the backend derives the detail only when the status
 *  is ERROR (`agentic_process.py:7142`). */
let turnNo = 0;
const refusedTurn = () =>
  processRow({
    worker_status: 'error',
    worker_status_detail: DENIAL,
    // The transcript entry's own uuid — different for each refused turn, which
    // is the whole point: the sentence above is identical on both.
    worker_status_detail_id: `4d4c5938-2558-4270-a084-dac90c7c6cd${++turnNo}`,
  });
/** A turn in flight: not ERROR, so the derived detail is null. */
const turnRunning = () => processRow({ worker_status: 'running', worker_status_detail: null });

/** Deliver a backend broadcast through the real WebSocket message handler. */
function broadcast(row: Record<string, unknown>) {
  ConnectionManager.getInstance().onMessage({
    message_type: 'data_op_msg',
    message_id: crypto.randomUUID(),
    to_entity: `${AgenticProcess.type}-${PROCESS_ID}`,
    op: 'update',
    data: row,
  } as never);
}

/** What `EntityExecutionPanel` does: watch the process entity and hand it to the
 *  activity line, which is where the auth-error hook is mounted. */
function ChatPane() {
  const { data } = useEntity<AgenticProcess>(new TypeId(AgenticProcess.type, PROCESS_ID));
  if (!data) return null;
  return <ChatActivityLine process={data} />;
}

const modalOpen = () => useHarnessLoginStore.getState().open;

describe('harness login — a second signed-out turn re-opens the modal', () => {
  beforeEach(async () => {
    vi.spyOn(apiClient, 'get').mockImplementation((path: string) => {
      if (path === '/graph/capability') return Promise.resolve([claudeRow()]) as never;
      if (path.endsWith('/lm_keys')) return Promise.resolve([]) as never;
      if (path.includes(PROCESS_ID)) return Promise.resolve(processRow()) as never;
      if (path.includes('auth-status')) return Promise.resolve({ status: 'logged_in', message: '' }) as never;
      return Promise.resolve(null) as never;
    });
    vi.spyOn(apiClient, 'post').mockResolvedValue(null as never);
    localStorage.setItem('llm-setup-modal-seen', 'true');
    await capabilityManager.load(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useHarnessLoginStore.setState({ open: false });
    localStorage.clear();
  });

  it('re-opens after the user dismisses it and the very next turn is refused again', async () => {
    render(
      <MemoryRouter>
        <ChatPane />
      </MemoryRouter>,
    );

    // Turn 1 is refused. The modal opens — this is the 22:41 screenshot.
    broadcast(refusedTurn());
    await waitFor(() => expect(modalOpen()).toBe(true));

    // The user dismisses it (Dialog onOpenChange → setOpen(false)).
    useHarnessLoginStore.getState().setOpen(false);
    expect(modalOpen()).toBe(false);

    // They type again. The turn goes in flight, then is refused with the same
    // sentence — because the sentence is the same every time.
    broadcast(turnRunning());
    broadcast(refusedTurn());

    await new Promise((r) => setTimeout(r, 50));
    expect(modalOpen()).toBe(true);
  });

  it('re-opens when the refusal arrives back-to-back, with no in-flight frame between', async () => {
    render(
      <MemoryRouter>
        <ChatPane />
      </MemoryRouter>,
    );

    broadcast(refusedTurn());
    await waitFor(() => expect(modalOpen()).toBe(true));

    useHarnessLoginStore.getState().setOpen(false);
    expect(modalOpen()).toBe(false);

    // The second refusal, with no intervening status change the client observes.
    broadcast(refusedTurn());

    await new Promise((r) => setTimeout(r, 50));
    expect(modalOpen()).toBe(true);
  });
});

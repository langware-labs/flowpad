/**
 * ChatComposerBar — the interactive-agent prompt composer.
 *
 * Three contracts, boundary-mock flavor (mirrors WorkerStatusChip.test.tsx):
 *   1. FLOWPAD-2006 — a turn in flight does NOT lock the composer. Mid-turn
 *      sends ENQUEUE onto the backend prompt queue (`process.enqueue`) instead
 *      of racing a second turn or being swallowed; an idle process still goes
 *      through `process.prompt`. The composer reads `isBusy(process)` — no
 *      worker-status derivation, and no client-side queue state.
 *   2. The queue chip reflects the backend-owned queue: the pending count when
 *      entries exist, nothing at all at zero.
 *   3. Plan-mode gating. The Plan pill + Shift+Tab toggle render ONLY when the
 *      chat-plan-mode context reports `enabled`, and `planPending` drives the
 *      pill's pressed state + the composer placeholder.
 *
 * NOTE (interface deviation): the coverage plan named "ProcessToolbar plan-mode
 * gating", but ProcessToolbar has no plan-mode concept — the plan toggle lives
 * on ChatComposerBar via `useChatPlanMode`. This tests the real owner.
 *
 * Everything below CompactExecutionInput is mocked so the composer renders
 * without a router/backend; we capture the props it hands down.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';

// useEntity(watch) → no live override, so `reflected = process` (the prop).
vi.mock('@sdk/react/hooks', () => ({
  useEntity: () => ({ data: undefined }),
}));

// Status indicator + label are decorative here.
vi.mock('@src/components/agentic-progress/shared/status-indicator', () => ({
  ProcessStatusIndicator: () => createElement('span', { 'data-testid': 'status-indicator' }),
  getStatusLabel: () => 'status',
}));

const notifyError = vi.fn();
vi.mock('@src/notifications/notify', () => ({ notify: { error: notifyError } }));

// Capture what ChatComposerBar hands the real input: `disabled`, `running`,
// `placeholder`, `onSend`, and the plan/queue `leadingSlot`. Holding the props
// in a box lets a test drive the send path the way the real input would.
const captured: { props: any } = { props: null };
vi.mock('@src/components/entity-execution-panel/CompactExecutionInput', () => ({
  CompactExecutionInput: (props: any) => {
    captured.props = props;
    return createElement(
      'div',
      { 'data-testid': 'composer' },
      createElement(
        'button',
        { 'data-testid': 'send-btn', disabled: !!props.disabled },
        props.placeholder,
      ),
      props.leadingSlot ?? null,
      props.statusSlot ?? null,
    );
  },
}));

// Plan-mode context — controlled per test.
const planState = {
  enabled: false,
  planPending: false,
  togglePlan: vi.fn(),
};
vi.mock('@src/components/terminal/interactive-terminal/chat-plan-mode-context', () => ({
  useChatPlanMode: () => planState,
}));

import { ProcessStatus } from '@sdk';
import { ChatComposerBar } from '@src/components/terminal/interactive-terminal/ChatComposerBar';

// A live process is always RUNNING now; readiness vs busy is the separate
// ``busy`` boolean the composer routes on via ``isBusy``.
function makeProcess(busy: boolean, entries: Array<{ id: string; prompt: string }> = []): any {
  return {
    id: 'proc-1',
    status: ProcessStatus.RUNNING,
    busy,
    session_id: 'sess-1',
    queue: { enabled: true, entries },
    prompt: vi.fn(async () => {}),
    enqueue: vi.fn(async () => {}),
    dequeue: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
  };
}
const readyProcess = () => makeProcess(false);
const busyProcess = (entries?: Array<{ id: string; prompt: string }>) => makeProcess(true, entries);

/** Drive the send path the way the real CompactExecutionInput would. */
async function send(text: string) {
  await act(async () => {
    await captured.props.onSend(text);
  });
}

afterEach(() => {
  cleanup();
  captured.props = null;
  notifyError.mockClear();
  planState.enabled = false;
  planState.planPending = false;
  planState.togglePlan.mockClear();
});

describe('ChatComposerBar — a turn in flight queues instead of locking (FLOWPAD-2006)', () => {
  it('ready process → composer enabled', () => {
    render(createElement(ChatComposerBar, { process: readyProcess() }));
    expect(screen.getByTestId('send-btn')).not.toBeDisabled();
  });

  // The regression itself: `disabled={sending || busy}` made the whole composer
  // inert mid-turn, so typing + Enter did nothing and no prompt ever reached the
  // backend queue. Busy must gate the ROUTE (prompt vs enqueue), never the input.
  it('busy process (turn in flight) → composer stays enabled', () => {
    render(createElement(ChatComposerBar, { process: busyProcess() }));
    expect(screen.getByTestId('send-btn')).not.toBeDisabled();
  });

  it('busy process → send enqueues, does not start a second turn', async () => {
    const proc = busyProcess();
    render(createElement(ChatComposerBar, { process: proc }));

    await send('queue me');

    expect(proc.enqueue).toHaveBeenCalledWith('queue me');
    expect(proc.prompt).not.toHaveBeenCalled();
  });

  it('ready process → send prompts, does not enqueue', async () => {
    const proc = readyProcess();
    render(createElement(ChatComposerBar, { process: proc }));

    await send('run me now');

    expect(proc.prompt).toHaveBeenCalled();
    expect(proc.prompt.mock.calls[0][0]).toBe('run me now');
    expect(proc.enqueue).not.toHaveBeenCalled();
  });

  it('enqueue failure surfaces a toast instead of throwing', async () => {
    const proc = busyProcess();
    proc.enqueue = vi.fn(async () => {
      throw new Error('queue is full');
    });
    render(createElement(ChatComposerBar, { process: proc }));

    await send('doomed');

    expect(notifyError).toHaveBeenCalled();
    expect(notifyError.mock.calls[0][0].message).toBe('queue is full');
  });
});

describe('ChatComposerBar — queue chip reflects the backend queue', () => {
  it('queued entries → chip shows the pending count', () => {
    const proc = busyProcess([
      { id: 'q1', prompt: 'first' },
      { id: 'q2', prompt: 'second' },
    ]);
    render(createElement(ChatComposerBar, { process: proc }));
    expect(screen.getByTestId('entity-execution-queue-count').textContent).toBe('2');
  });

  it('empty queue → no chip', () => {
    render(createElement(ChatComposerBar, { process: readyProcess() }));
    expect(screen.queryByTestId('entity-execution-queue-chip')).toBeNull();
  });
});

describe('ChatComposerBar — plan-mode gating', () => {
  it('plan disabled → no Plan pill', () => {
    planState.enabled = false;
    render(createElement(ChatComposerBar, { process: readyProcess() }));
    expect(screen.queryByTestId('plan-mode-pill')).toBeNull();
  });

  it('plan enabled → Plan pill rendered, not pressed when idle', () => {
    planState.enabled = true;
    planState.planPending = false;
    render(createElement(ChatComposerBar, { process: readyProcess() }));
    const pill = screen.getByTestId('plan-mode-pill');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveAttribute('aria-pressed', 'false');
  });

  it('plan pending → pill pressed and placeholder switches to plan copy', () => {
    planState.enabled = true;
    planState.planPending = true;
    render(createElement(ChatComposerBar, { process: readyProcess() }));
    expect(screen.getByTestId('plan-mode-pill')).toHaveAttribute('aria-pressed', 'true');
    // The plan-mode placeholder is distinct from the normal "Message the agent…".
    expect(screen.getByTestId('send-btn').textContent ?? '').toMatch(/plan/i);
  });
});

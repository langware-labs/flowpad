/**
 * ChatComposerBar — the interactive-agent prompt composer.
 *
 * Two contracts, boundary-mock flavor (mirrors WorkerStatusChip.test.tsx):
 *   1. Composer disabled-state tracks the single `busy` boolean: a busy process
 *      (a turn in flight — RUNNING + busy) disables send; a ready process
 *      (RUNNING, not busy) enables it. The composer reads `isBusy(process)` — no
 *      worker-status derivation.
 *   2. Plan-mode gating. The Plan pill + Shift+Tab toggle render ONLY when the
 *      chat-plan-mode context reports `planToggleEnabled`, and `planPending` drives the
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
import { render, screen, cleanup } from '@testing-library/react';

// useEntity(watch) → no live override, so `reflected = process` (the prop).
vi.mock('@sdk/react/hooks', () => ({
  useEntity: () => ({ data: undefined }),
}));

// Status indicator + label are decorative here.
vi.mock('@src/components/agentic-progress/shared/status-indicator', () => ({
  ProcessStatusIndicator: () => createElement('span', { 'data-testid': 'status-indicator' }),
  getStatusLabel: () => 'status',
}));

vi.mock('@src/notifications/notify', () => ({ notify: { error: vi.fn() } }));

// Capture what ChatComposerBar hands the real input: `disabled`, `running`,
// `placeholder`, and the plan `leadingSlot`.
vi.mock('@src/components/entity-execution-panel/CompactExecutionInput', () => ({
  CompactExecutionInput: (props: any) =>
    createElement(
      'div',
      { 'data-testid': 'composer' },
      createElement(
        'button',
        { 'data-testid': 'send-btn', disabled: !!props.disabled },
        props.placeholder,
      ),
      props.leadingSlot ?? null,
      props.statusSlot ?? null,
    ),
}));

// Plan-mode context — controlled per test.
const planState = {
  planToggleEnabled: false,
  planPending: false,
  togglePlan: vi.fn(),
};
vi.mock('@src/components/terminal/interactive-terminal/chat-plan-mode-context', () => ({
  useChatPlanMode: () => planState,
}));

import { ProcessStatus } from '@sdk';
import { ChatComposerBar } from '@src/components/terminal/interactive-terminal/ChatComposerBar';

// A live process is always RUNNING now; readiness vs busy is the separate
// ``busy`` boolean the composer gates on via ``isBusy``.
function makeProcess(busy: boolean): any {
  return {
    id: 'proc-1',
    status: ProcessStatus.RUNNING,
    busy,
    session_id: 'sess-1',
    prompt: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
  };
}
const readyProcess = () => makeProcess(false);
const busyProcess = () => makeProcess(true);

afterEach(() => {
  cleanup();
  planState.planToggleEnabled = false;
  planState.planPending = false;
  planState.togglePlan.mockClear();
});

describe('ChatComposerBar — composer disabled-state tracks worker readiness', () => {
  it('ready process → composer enabled', () => {
    render(createElement(ChatComposerBar, { process: readyProcess() }));
    expect(screen.getByTestId('send-btn')).not.toBeDisabled();
  });

  it('busy process (turn in flight) → composer disabled', () => {
    render(createElement(ChatComposerBar, { process: busyProcess() }));
    expect(screen.getByTestId('send-btn')).toBeDisabled();
  });
});

describe('ChatComposerBar — plan-mode gating', () => {
  it('plan disabled → no Plan pill', () => {
    planState.planToggleEnabled = false;
    render(createElement(ChatComposerBar, { process: readyProcess() }));
    expect(screen.queryByTestId('plan-mode-pill')).toBeNull();
  });

  it('plan enabled → Plan pill rendered, not pressed when idle', () => {
    planState.planToggleEnabled = true;
    planState.planPending = false;
    render(createElement(ChatComposerBar, { process: readyProcess() }));
    const pill = screen.getByTestId('plan-mode-pill');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveAttribute('aria-pressed', 'false');
  });

  it('plan pending → pill pressed and placeholder switches to plan copy', () => {
    planState.planToggleEnabled = true;
    planState.planPending = true;
    render(createElement(ChatComposerBar, { process: readyProcess() }));
    expect(screen.getByTestId('plan-mode-pill')).toHaveAttribute('aria-pressed', 'true');
    // The plan-mode placeholder is distinct from the normal "Message the agent…".
    expect(screen.getByTestId('send-btn').textContent ?? '').toMatch(/plan/i);
  });
});

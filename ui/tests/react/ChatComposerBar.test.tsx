/**
 * ChatComposerBar — the interactive-agent prompt composer.
 *
 * Two contracts, boundary-mock flavor (mirrors WorkerStatusChip.test.tsx):
 *   1. Composer disabled-state tracks the single logical `busy` wire status:
 *      a BUSY process (a turn in flight) disables send; a READY process enables
 *      it. The composer reads `isBusy(process)` — no worker-status derivation.
 *   2. Plan-mode gating. The Plan pill + Shift+Tab toggle render ONLY when the
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
  enabled: false,
  planPending: false,
  togglePlan: vi.fn(),
};
vi.mock('@src/components/terminal/interactive-terminal/chat-plan-mode-context', () => ({
  useChatPlanMode: () => planState,
}));

import { ProcessStatus } from '@sdk';
import { ChatComposerBar } from '@src/components/terminal/interactive-terminal/ChatComposerBar';

function makeProcess(status: ProcessStatus): any {
  return {
    id: 'proc-1',
    status,
    session_id: 'sess-1',
    prompt: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
  };
}

afterEach(() => {
  cleanup();
  planState.enabled = false;
  planState.planPending = false;
  planState.togglePlan.mockClear();
});

describe('ChatComposerBar — composer disabled-state tracks worker readiness', () => {
  it('ready process → composer enabled', () => {
    render(createElement(ChatComposerBar, { process: makeProcess(ProcessStatus.READY) }));
    expect(screen.getByTestId('send-btn')).not.toBeDisabled();
  });

  it('busy process (turn in flight) → composer disabled', () => {
    render(createElement(ChatComposerBar, { process: makeProcess(ProcessStatus.BUSY) }));
    expect(screen.getByTestId('send-btn')).toBeDisabled();
  });
});

describe('ChatComposerBar — plan-mode gating', () => {
  it('plan disabled → no Plan pill', () => {
    planState.enabled = false;
    render(createElement(ChatComposerBar, { process: makeProcess(ProcessStatus.READY) }));
    expect(screen.queryByTestId('plan-mode-pill')).toBeNull();
  });

  it('plan enabled → Plan pill rendered, not pressed when idle', () => {
    planState.enabled = true;
    planState.planPending = false;
    render(createElement(ChatComposerBar, { process: makeProcess(ProcessStatus.READY) }));
    const pill = screen.getByTestId('plan-mode-pill');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveAttribute('aria-pressed', 'false');
  });

  it('plan pending → pill pressed and placeholder switches to plan copy', () => {
    planState.enabled = true;
    planState.planPending = true;
    render(createElement(ChatComposerBar, { process: makeProcess(ProcessStatus.READY) }));
    expect(screen.getByTestId('plan-mode-pill')).toHaveAttribute('aria-pressed', 'true');
    // The plan-mode placeholder is distinct from the normal "Message the agent…".
    expect(screen.getByTestId('send-btn').textContent ?? '').toMatch(/plan/i);
  });
});

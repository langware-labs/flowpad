/**
 * Project setup begins only after the first-run wizard is done. The backend refuses (412,
 * `data.blocked == 'first_run_setup'`); a screen reads that, starts the first-run flow, and goes on by itself
 * once the gate is open.
 *
 * Real `FirstRunWaiting`, `useFirstRunResume` and `isFirstRunBlocked`.
 */
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The waiting line reads the gate; here the gate is closed, so it starts the flow.
vi.mock('@sdk/react/hooks', () => ({ useContext: () => ({ isDesktop: true }), useEntity: () => ({ data: null }) }));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  Wizard: { firstRunState: vi.fn(() => Promise.resolve('closed')) },
}));
vi.mock('@src/components/setup-incomplete/open-setup-wizard', () => ({
  findSetupWizard: () => Promise.resolve({ typeId: { toString: () => 'wizard-1' }, first_run_gate_open: false }),
  openSetupWizard: vi.fn(),
}));
import { useFirstRunFlowStore } from '@src/components/first-run-flow/first-run-flow-store';
import {
  FIRST_RUN_BLOCKED,
  FirstRunWaiting,
  isFirstRunBlocked,
  useFirstRunResume,
  useGateAnswerStore,
  type FirstRunGate,
} from '@src/components/project-setup/first-run-gate';

const refusal = { response: { status: 412, data: { data: { blocked: FIRST_RUN_BLOCKED } } } };

afterEach(() => {
  useGateAnswerStore.setState({ asked: null, started: false });
  cleanup();
  useFirstRunFlowStore.getState().end();
});

describe('reading the refusal', () => {
  it('knows the first-run refusal from any other failure', () => {
    expect(isFirstRunBlocked(refusal)).toBe(true);
    expect(isFirstRunBlocked({ response: { status: 409, data: { data: { suggested_name: 'x' } } } })).toBe(false);
    expect(isFirstRunBlocked(new Error('boom'))).toBe(false);
    expect(isFirstRunBlocked(null)).toBe(false);
  });
});

describe('a screen that waits for the first-run wizard', () => {
  it('says so in one line, and starts the first-run flow with the origin it was given', async () => {
    render(<FirstRunWaiting />);

    expect(screen.getByTestId('first-run-waiting')).toBeTruthy();
    await waitFor(() => expect(useFirstRunFlowStore.getState().step).toBe('wizard'));
    expect(useFirstRunFlowStore.getState().origin).toBe('project_setup');
  });

  it('a second screen waiting joins the flow already going rather than restarting it, and takes over its origin', async () => {
    useFirstRunFlowStore.getState().start('app_load');
    useFirstRunFlowStore.getState().setStep('skip-notice');

    render(<FirstRunWaiting />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useFirstRunFlowStore.getState().step).toBe('skip-notice');
    expect(useFirstRunFlowStore.getState().origin).toBe('project_setup');
  });
});

describe('going on by itself when the wizard is done', () => {
  const gate = (state: FirstRunGate['state']): FirstRunGate => ({
    state,
    
    continueAnyway: vi.fn(() => Promise.resolve(true)),
  });

  it('resumes once, when the gate turns from closed to open while refused', () => {
    const resume = vi.fn();
    const { rerender } = renderHook(({ g }) => useFirstRunResume(true, g, resume), {
      initialProps: { g: gate('closed') },
    });
    expect(resume).not.toHaveBeenCalled();

    rerender({ g: gate('open') });
    expect(resume).toHaveBeenCalledOnce();

    rerender({ g: gate('open') });
    expect(resume).toHaveBeenCalledOnce();
  });

  it('never loops: a gate that read open the whole time and was refused anyway does not resume', () => {
    const resume = vi.fn();
    const { rerender } = renderHook(({ g }) => useFirstRunResume(true, g, resume), {
      initialProps: { g: gate('open') },
    });
    rerender({ g: gate('open') });

    expect(resume).not.toHaveBeenCalled();
  });

  it('does nothing when nothing was refused', () => {
    const resume = vi.fn();
    const { rerender } = renderHook(({ g }) => useFirstRunResume(false, g, resume), {
      initialProps: { g: gate('closed') },
    });
    rerender({ g: gate('open') });

    expect(resume).not.toHaveBeenCalled();
  });
});

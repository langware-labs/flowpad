/**
 * The first-run gate as the app reads it: the BACKEND's answer first (held until the shipped wizard can be looked
 * up -- on a fresh database that is ~40 s after the app is serving), then the wizard's own entity.
 *
 * A gate that read "no wizard row yet" as open let a project setup, and an invitation's dialog, through ahead of
 * the wizard on a fresh install. Real `useFirstRunGate` and `FirstRunWaiting`; stand-ins: the backend's answer, the
 * wizard lookup and entity, and whether this is the desktop.
 */
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isDesktop: true,
  get: vi.fn(),
  find: vi.fn(),
  entity: null as { first_run_gate_open?: boolean } | null,
}));

vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  Wizard: { firstRunState: async () => (await h.get())?.state },
}));
vi.mock('@sdk/react/hooks', () => ({
  useContext: () => ({ isDesktop: h.isDesktop }),
  useEntity: () => ({ data: h.entity }),
}));
vi.mock('@src/components/setup-incomplete/open-setup-wizard', () => ({
  findSetupWizard: h.find,
  openSetupWizard: vi.fn(),
}));

import { useFirstRunFlowStore } from '@src/components/first-run-flow/first-run-flow-store';
import { FirstRunWaiting, useFirstRunGate, useGateAnswerStore } from '@src/components/project-setup/first-run-gate';

const wizard = (open: boolean) => ({ typeId: { toString: () => 'wizard-1' }, first_run_gate_open: open });

/** A backend answer the test releases itself, so "not answered yet" can be looked at. */
function slowAnswer() {
  let release: (state: string) => void = () => undefined;
  h.get.mockReturnValue(new Promise((resolve) => (release = (state) => resolve({ state }))));
  return (state: string) => release(state);
}

beforeEach(() => {
  useGateAnswerStore.setState({ asked: null, started: false }); // one answer per page load
  h.isDesktop = true;
  h.entity = null;
  h.get.mockReset();
  h.find.mockReset();
});

afterEach(() => {
  cleanup();
  useFirstRunFlowStore.getState().end();
});

describe('useFirstRunGate', () => {
  it('asks the backend ONCE however many screens read the gate, and they all read the same answer', async () => {
    h.find.mockResolvedValue(wizard(false));
    h.entity = { first_run_gate_open: false };
    h.get.mockResolvedValue({ state: 'closed' });
    const first = renderHook(() => useFirstRunGate());
    const second = renderHook(() => useFirstRunGate());

    await waitFor(() => expect(first.result.current.state).toBe('closed'));
    await waitFor(() => expect(second.result.current.state).toBe('closed'));
    expect(h.get).toHaveBeenCalledTimes(1);
  });

  it('is loading until the backend answers -- never open on a wizard row that is not there yet', async () => {
    const answer = slowAnswer();
    h.find.mockResolvedValue(wizard(false));
    h.entity = { first_run_gate_open: false };
    const { result } = renderHook(() => useFirstRunGate());

    expect(result.current.state).toBe('loading');
    expect(h.find, 'no wizard is looked up before the backend says it can be').not.toHaveBeenCalled();

    act(() => answer('closed'));
    await waitFor(() => expect(result.current.state).toBe('closed'));
  });

  it('is open when the backend says open, without looking for the wizard', async () => {
    h.get.mockResolvedValue({ state: 'open' });
    const { result } = renderHook(() => useFirstRunGate());

    await waitFor(() => expect(result.current.state).toBe('open'));
    expect(h.find).not.toHaveBeenCalled();
  });

  it('follows the wizard entity while the backend says closed: it opens the moment the entity says so', async () => {
    h.get.mockResolvedValue({ state: 'closed' });
    h.find.mockResolvedValue(wizard(false));
    h.entity = { first_run_gate_open: false };
    const { result, rerender } = renderHook(() => useFirstRunGate());
    await waitFor(() => expect(result.current.state).toBe('closed'));

    h.entity = { first_run_gate_open: true };
    rerender();

    expect(result.current.state).toBe('open');
  });

  it('is open when the backend cannot be asked -- a gate that cannot tell holds no one', async () => {
    h.get.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useFirstRunGate());

    await waitFor(() => expect(result.current.state).toBe('open'));
  });

  it('is open when the backend says closed but the wizard is not here after the index ended', async () => {
    h.get.mockResolvedValue({ state: 'closed' });
    h.find.mockResolvedValue(undefined);
    const { result } = renderHook(() => useFirstRunGate());

    await waitFor(() => expect(result.current.state).toBe('open'));
  });

  it('is open off the desktop, and asks nothing', () => {
    h.isDesktop = false;
    const { result } = renderHook(() => useFirstRunGate());

    expect(result.current.state).toBe('open');
    expect(h.get).not.toHaveBeenCalled();
  });
});

describe('a screen waiting for the wizard', () => {
  it('starts the flow only once the gate is KNOWN closed -- not while the wizard is still being indexed', async () => {
    const answer = slowAnswer();
    h.find.mockResolvedValue(wizard(false));
    h.entity = { first_run_gate_open: false };
    render(<FirstRunWaiting origin="invitation" />);

    expect(screen.getByTestId('first-run-waiting')).toBeTruthy();
    expect(useFirstRunFlowStore.getState().step, 'nothing to open yet').toBe('idle');

    act(() => answer('closed'));

    await waitFor(() => expect(useFirstRunFlowStore.getState().step).toBe('wizard'));
    expect(useFirstRunFlowStore.getState().origin).toBe('invitation');
  });
});

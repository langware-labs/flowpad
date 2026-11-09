/**
 * FLOWPAD-2249: before a project's setup, the first-run wizard — unless it is all green. Its window
 * closed (finished or not), the setup carries on.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExitCode } from '@sdk';

import { closeWizardPopup, useWizardPopupStore } from '@src/components/assets/editor/wizard/wizard-popup-store';
import { FirstRunGateRoot, firstRunFirst, pastFirstRun } from '@src/components/setup-incomplete/first-run-gate';

const h = vi.hoisted(() => ({ result: undefined as unknown, open: vi.fn(), closed: vi.fn() }));

vi.mock('@src/components/setup-incomplete/open-setup-wizard', () => ({
  findSetupWizard: () =>
    Promise.resolve({
      typeId: { toString: () => 'wizard-x' },
      run_state: { result: h.result },
      open: h.open,
      closed: h.closed,
    }),
}));

const held = Object.assign(new Error("Flowpad's setup comes first"), {
  response: { status: 412, data: { data: { error_code: 'first_run_setup' } } },
});
const flush = () => act(async () => {});

describe('first-run wizard before project setup', () => {
  beforeEach(() => {
    h.result = undefined;
    h.open.mockReset().mockResolvedValue({ opened: true });
    h.closed.mockReset().mockResolvedValue({ closed: true });
    closeWizardPopup();
  });
  afterEach(cleanup);

  it('shows the wizard, and the setup carries on once its window is closed — finished or not', async () => {
    render(<FirstRunGateRoot />);
    const shown = firstRunFirst();
    await flush();
    expect(useWizardPopupStore.getState()).toMatchObject({ open: true, payload: 'wizard-x' });

    act(() => closeWizardPopup());
    await expect(shown).resolves.toBe(true);
    expect(h.closed).toHaveBeenCalledTimes(1);
  });

  it('all green: nothing is shown, the setup goes straight on', async () => {
    h.result = { exit_code: ExitCode.OK, detail: '', ran: true, steps: {} };
    await expect(firstRunFirst()).resolves.toBe(false);
    expect(h.open).not.toHaveBeenCalled();
    expect(useWizardPopupStore.getState().open).toBe(false);
  });

  it('a start the backend held waits on the wizard, then is asked again', async () => {
    const start = vi.fn().mockRejectedValueOnce(held).mockResolvedValue('run-1');
    render(<FirstRunGateRoot />);
    const started = pastFirstRun(start);
    await flush();
    expect(start).toHaveBeenCalledTimes(1);

    act(() => closeWizardPopup());
    await expect(started).resolves.toBe('run-1');
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('any other refusal is passed through untouched', async () => {
    const other = new Error('boom');
    await expect(pastFirstRun(() => Promise.reject(other))).rejects.toBe(other);
    expect(h.open).not.toHaveBeenCalled();
  });
});

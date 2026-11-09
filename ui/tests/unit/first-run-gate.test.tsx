/**
 * FLOWPAD-2249: a project setup the backend held for first-run setup waits on the wizard, then
 * carries on by itself — or, the wizard left short of all green, does not start at all.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExitCode } from '@sdk';

import { closeWizardPopup, useWizardPopupStore } from '@src/components/assets/editor/wizard/wizard-popup-store';
import { FirstRunGateRoot, pastFirstRun } from '@src/components/setup-incomplete/first-run-gate';

const h = vi.hoisted(() => ({ result: undefined as unknown, live: false, open: vi.fn() }));

vi.mock('@src/components/setup-incomplete/open-setup-wizard', () => ({
  findSetupWizard: () => Promise.resolve({ typeId: { toString: () => 'wizard-x' }, open: h.open }),
}));
vi.mock('@src/components/setup-incomplete/use-first-run-wizard', () => ({
  useFirstRunWizard: () => ({ wizard: { run_state: { result: h.result } }, live: h.live }),
}));

const held = Object.assign(new Error('Finish setting up Flowpad first'), {
  response: { status: 412, data: { data: { error_code: 'first_run_setup' } } },
});
const result = (exit_code: ExitCode) => ({ exit_code, detail: '', ran: true, steps: {} });

describe('pastFirstRun', () => {
  beforeEach(() => {
    h.result = undefined;
    h.live = false;
    h.open.mockReset().mockResolvedValue({ opened: true });
    closeWizardPopup();
  });
  afterEach(cleanup);

  it('shows the wizard, and starts the setup once it ends all green', async () => {
    const start = vi.fn().mockRejectedValueOnce(held).mockResolvedValue('run-1');
    const view = render(<FirstRunGateRoot />);
    const started = pastFirstRun(start);
    await act(async () => {});
    expect(useWizardPopupStore.getState()).toMatchObject({ open: true, payload: 'wizard-x' });

    h.live = true;
    view.rerender(<FirstRunGateRoot />);
    expect(start).toHaveBeenCalledTimes(1);

    h.live = false;
    h.result = result(ExitCode.OK);
    view.rerender(<FirstRunGateRoot />);
    await expect(started).resolves.toBe('run-1');
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('a green this screen still holds from before is stale: it waits for a run', async () => {
    h.result = { ...result(ExitCode.OK), invocation_id: 'old' };
    const start = vi.fn().mockRejectedValueOnce(held).mockResolvedValue('run-1');
    const view = render(<FirstRunGateRoot />);
    const started = pastFirstRun(start);
    await act(async () => {});
    view.rerender(<FirstRunGateRoot />);
    expect(start).toHaveBeenCalledTimes(1);

    h.result = { ...result(ExitCode.OK), invocation_id: 'new' };
    view.rerender(<FirstRunGateRoot />);
    await expect(started).resolves.toBe('run-1');
  });

  it('closed short of all green: nothing starts, and the refusal is the answer', async () => {
    const start = vi.fn().mockRejectedValue(held);
    render(<FirstRunGateRoot />);
    const started = pastFirstRun(start);
    await act(async () => {});
    h.result = result(ExitCode.NOT_YET);
    act(() => closeWizardPopup());
    await expect(started).rejects.toBe(held);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('any other refusal is passed through untouched', async () => {
    const other = new Error('boom');
    await expect(pastFirstRun(() => Promise.reject(other))).rejects.toBe(other);
    expect(h.open).not.toHaveBeenCalled();
  });
});

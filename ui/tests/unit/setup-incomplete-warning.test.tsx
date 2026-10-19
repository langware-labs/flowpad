/**
 * The footer's "Setup did not finish successfully" warning: derived from the first-run wizard's last
 * run, shown only once a run has ENDED short of all green (a failed install, or one the person
 * cancelled), never while it is still working, and its button is the same "run setup again" door
 * Settings → General uses.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExitCode } from '@sdk';

import {
  setupIncomplete,
  useSetupIncompleteWarning,
} from '@src/components/setup-incomplete/use-setup-incomplete-warning';

const h = vi.hoisted(() => ({
  isDesktop: true,
  result: undefined as unknown,
  live: false,
  opened: true,
  openSetupWizard: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('@src/components/setup-incomplete/open-setup-wizard', () => ({
  findSetupWizard: () => Promise.resolve({ typeId: { toString: () => 'wizard-x' } }),
  openSetupWizard: (...args: unknown[]) => h.openSetupWizard(...args),
}));
vi.mock('@sdk/react/hooks', () => ({
  useContext: () => ({ isDesktop: h.isDesktop }),
  useEntity: () => ({
    data: { activity_path: 'wizard/x', typeId: { toString: () => 'wizard-x' }, run_state: { result: h.result } },
  }),
}));
// A run is live while an activity node is there and not terminal.
vi.mock('@src/store/activity-store', () => ({
  useActivitySpec: () => (h.live ? { id: 'run' } : null),
  pickLiveActivity: (scoped: unknown) => scoped,
}));
vi.mock('@sdk/activity', () => ({ isTerminal: () => false }));
vi.mock('@src/notifications', () => ({ notify: { error: (...args: unknown[]) => h.notifyError(...args) } }));

const result = (exit_code: ExitCode) => ({ exit_code, detail: '', ran: true, steps: {} });

describe('setupIncomplete', () => {
  it.each([
    ['never ran', undefined, false, false],
    ['ended all green', result(ExitCode.OK), false, false],
    ['ended short: a step failed or was cancelled', result(ExitCode.NOT_YET), false, true],
    ['still running (its partial writes are NOT_YET)', result(ExitCode.NOT_YET), true, false],
  ])('%s → %s', (_name, run, live, expected) => {
    expect(setupIncomplete(run as never, live)).toBe(expected);
  });
});

describe('useSetupIncompleteWarning', () => {
  beforeEach(() => {
    h.isDesktop = true;
    h.result = result(ExitCode.NOT_YET);
    h.live = false;
    h.opened = true;
    h.openSetupWizard.mockReset().mockImplementation(() => Promise.resolve(h.opened));
    h.notifyError.mockReset();
  });
  afterEach(cleanup);

  /** Render, then let the wizard lookup settle — the warning needs the wizard entity first. */
  const warning = async () => {
    const view = renderHook(() => useSetupIncompleteWarning());
    await act(async () => {});
    return view;
  };

  it('warns once a run ended short, with a button that runs setup again', async () => {
    const { result: out } = await warning();

    expect(out.current?.id).toBe('setup-incomplete');
    expect(out.current?.action?.label).toBe('Run setup again');

    act(() => out.current?.action?.onClick());
    await waitFor(() => expect(h.openSetupWizard).toHaveBeenCalledTimes(1));
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  it('is the same door as clicking the warning itself', async () => {
    const { result: out } = await warning();

    act(() => out.current?.onClick?.());

    await waitFor(() => expect(h.openSetupWizard).toHaveBeenCalledTimes(1));
  });

  it('says nothing when setup ended all green', async () => {
    h.result = result(ExitCode.OK);
    const { result: out } = await warning();
    expect(out.current).toBeNull();
  });

  it('says nothing while setup is still running', async () => {
    h.live = true;
    const { result: out } = await warning();
    expect(out.current).toBeNull();
  });

  it('says nothing when setup never ran', async () => {
    h.result = undefined;
    const { result: out } = await warning();
    expect(out.current).toBeNull();
  });

  it('says nothing off the desktop app, where there is no box to set up', async () => {
    h.isDesktop = false;
    const { result: out } = await warning();
    expect(out.current).toBeNull();
  });

  it('reports a missing wizard as an error toast, not silence', async () => {
    h.opened = false;
    const { result: out } = await warning();

    act(() => out.current?.action?.onClick());

    await waitFor(() => expect(h.notifyError).toHaveBeenCalledTimes(1));
    expect(h.notifyError.mock.calls[0][0]).toMatchObject({ title: 'Could not open setup' });
  });
});

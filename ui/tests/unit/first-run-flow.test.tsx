/**
 * The first-run flow, as the spec draws it (`agentic-assets/chart/first-run-wizard-flow`):
 *
 *   window 1 the wizard -> Skip or X -> window 2 (Run setup | Skip) -> window 3 (Continue anyway) -> the end
 *
 * Real `FirstRunFlowRoot`, its store and the wizard popup's store. The stand-ins are the gate (the wizard
 * entity's own state), the door that opens the wizard, and dock navigation.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  gate: { state: 'closed', continueAnyway: vi.fn() } as {
    state: 'loading' | 'closed' | 'open';
    continueAnyway: () => Promise<boolean>;
  },
  openSetupWizard: vi.fn(),
  goHome: vi.fn(),
  incomplete: null as object | null,
  // Where the tab is: the app root (the home page) or a page of the dock.
  dock: { isRoot: true } as { isRoot: boolean } | null,
}));

vi.mock('@src/components/project-setup/first-run-gate', () => ({ useFirstRunGate: () => h.gate }));
vi.mock('@src/components/setup-incomplete/open-setup-wizard', () => ({
  FIRST_RUN_WIZARD: 'llm-setup',
  openSetupWizard: h.openSetupWizard,
}));
vi.mock('@src/components/setup-incomplete/use-setup-incomplete-warning', () => ({
  useSetupIncompleteWarning: () => h.incomplete,
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { goHome: h.goHome }, currentDock: h.dock }),
}));

import { closeWizardPopup, openWizardPopup } from '@src/components/assets/editor/wizard/wizard-popup-store';
import { FirstRunFlowRoot } from '@src/components/first-run-flow/FirstRunFlow';
import {
  startFirstRunFlow,
  useDialogsAllowed,
  useFirstRunFlowStore,
} from '@src/components/first-run-flow/first-run-flow-store';
import { renderHook } from '@testing-library/react';

const step = () => useFirstRunFlowStore.getState().step;

beforeEach(() => {
  h.gate = { state: 'closed', continueAnyway: vi.fn(() => Promise.resolve(true)) };
  // Opening the wizard puts its popup up, as the real door does.
  h.openSetupWizard.mockReset().mockImplementation(() => {
    openWizardPopup('wizard-1');
    return Promise.resolve(true);
  });
  h.goHome.mockReset();
  h.incomplete = null;
  h.dock = { isRoot: true };
});

afterEach(() => {
  cleanup();
  closeWizardPopup();
  useFirstRunFlowStore.getState().end();
  vi.resetModules();
});

/** Window 1 on screen, then dismissed by Skip or X. */
async function skipWindowOne(origin: 'project_setup' | 'invitation' | 'app_load' = 'project_setup') {
  render(<FirstRunFlowRoot />);
  act(() => startFirstRunFlow(origin));
  await waitFor(() => expect(h.openSetupWizard).toHaveBeenCalledOnce());
  await waitFor(() => expect(useFirstRunFlowStore.getState().step).toBe('wizard'));
  await act(async () => {
    // The popup is up (the stand-in door opened it); closing it is Skip or X.
    await Promise.resolve();
    closeWizardPopup();
  });
}

/** Window 2's Continue anyway, then window 3's X: the only way out of the flow. */
async function leaveWindowThree() {
  fireEvent.click(await screen.findByTestId('first-run-continue-anyway'));
  const how = await screen.findByTestId('first-run-how-to');
  fireEvent.click(within(how).getByRole('button', { name: /close/i }));
}

describe('window 1 to window 3', () => {
  it('Skip or X on the wizard leads to window 2, which says what is missing and offers Run setup and Continue anyway', async () => {
    await skipWindowOne();

    expect(await screen.findByTestId('first-run-skip-notice')).toBeTruthy();
    expect(screen.getByTestId('first-run-run-setup')).toBeTruthy();
    expect(screen.getByTestId('first-run-continue-anyway')).toBeTruthy();
    expect(step()).toBe('skip-notice');
  });

  it('Run setup returns to the wizard', async () => {
    await skipWindowOne();
    fireEvent.click(await screen.findByTestId('first-run-run-setup'));

    await waitFor(() => expect(h.openSetupWizard).toHaveBeenCalledTimes(2));
    expect(step()).toBe('wizard');
  });

  it('Continue anyway on window 2 leads to window 3, which says where to run setup again and is left with X', async () => {
    await skipWindowOne();
    fireEvent.click(await screen.findByTestId('first-run-continue-anyway'));

    const how = await screen.findByTestId('first-run-how-to');
    expect(how.textContent).toContain('Settings → General → Run setup again');
    // No button to go on: X is the way out (Escape and X are the same close).
    expect(within(how).queryByTestId('first-run-continue-anyway')).toBeNull();
    expect(within(how).getByRole('button', { name: /close/i })).toBeTruthy();
    expect(step()).toBe('how-to');
  });
});

describe('the end of the flow', () => {
  it('X on window 3 opens the gate for this session and ends the flow; a project setup that waited goes on by itself', async () => {
    await skipWindowOne('project_setup');
    await leaveWindowThree();

    await waitFor(() => expect(step()).toBe('idle'));
    expect(h.gate.continueAnyway).toHaveBeenCalledOnce();
    expect(h.goHome).not.toHaveBeenCalled();
  });

  it('leaving a flow that began with an app load opens nothing: the next project setup meets the wizard again', async () => {
    await skipWindowOne('app_load');
    await leaveWindowThree();

    await waitFor(() => expect(step()).toBe('idle'));
    expect(h.gate.continueAnyway).not.toHaveBeenCalled();
  });

  it('a flow that began with an app load on another page lands on the home page', async () => {
    h.dock = { isRoot: false };
    await skipWindowOne('app_load');
    await leaveWindowThree();

    await waitFor(() => expect(h.goHome).toHaveBeenCalledWith({ homePage: true }));
    expect(step()).toBe('idle');
  });

  it('an app load already on the home page does not navigate there again -- that made the page flash', async () => {
    h.dock = { isRoot: true };
    await skipWindowOne('app_load');
    await leaveWindowThree();

    await waitFor(() => expect(step()).toBe('idle'));
    expect(h.goHome).not.toHaveBeenCalled();
  });

  it('stays on window 3 when the gate could not be opened -- ending would leave whoever waits, waiting', async () => {
    h.gate.continueAnyway = vi.fn(() => Promise.resolve(false));
    await skipWindowOne();
    await leaveWindowThree();

    await waitFor(() => expect(h.gate.continueAnyway).toHaveBeenCalledOnce());
    expect(step()).toBe('how-to');
    expect(screen.getByTestId('first-run-how-to')).toBeTruthy();
  });

  it('a wizard that ran fully ends the flow when its window closes -- no window 2', async () => {
    render(<FirstRunFlowRoot />);
    act(() => startFirstRunFlow('invitation'));
    await waitFor(() => expect(h.openSetupWizard).toHaveBeenCalledOnce());
    await act(async () => {
      await Promise.resolve();
    });

    h.gate = { ...h.gate, state: 'open' }; // every step finished OK
    act(() => closeWizardPopup());

    await waitFor(() => expect(step()).toBe('idle'));
    expect(screen.queryByTestId('first-run-skip-notice')).toBeNull();
  });

  it('there is nothing to wait for where the wizard is not installed', async () => {
    h.openSetupWizard.mockResolvedValue(false);
    render(<FirstRunFlowRoot />);
    act(() => startFirstRunFlow('project_setup'));

    await waitFor(() => expect(step()).toBe('idle'));
  });
});

describe('minimized while the installs run', () => {
  /** Window 1 up, then MINIMIZED (not closed): what the popup's minimize button does in the flow. */
  async function minimizeWindowOne() {
    render(<FirstRunFlowRoot />);
    act(() => startFirstRunFlow('project_setup'));
    await waitFor(() => expect(h.openSetupWizard).toHaveBeenCalledOnce());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      useFirstRunFlowStore.getState().setMinimized(true);
      closeWizardPopup();
    });
  }

  it('is not the way on to window 2: the flow waits for how the run ends', async () => {
    await minimizeWindowOne();

    expect(step()).toBe('wizard');
    expect(screen.queryByTestId('first-run-skip-notice')).toBeNull();
  });

  it('is not "in the middle of" an open window: other dialogs may show', async () => {
    const { result } = renderHook(() => useDialogsAllowed());
    await minimizeWindowOne();

    expect(result.current).toBe(true);
  });

  it('ends the flow when the run finishes all OK meanwhile', async () => {
    await minimizeWindowOne();
    act(() => {
      h.gate = { ...h.gate, state: 'open' };
    });
    // The gate is read on the next render: a change anywhere in the tree causes one.
    act(() => useFirstRunFlowStore.getState().setMinimized(true));

    await waitFor(() => expect(step()).toBe('idle'));
  });

  it('goes on to window 2 when the run ends short -- as if the person had closed the wizard then', async () => {
    await minimizeWindowOne();
    act(() => {
      h.incomplete = { id: 'setup-incomplete' };
    });
    act(() => useFirstRunFlowStore.getState().setMinimized(true));

    expect(await screen.findByTestId('first-run-skip-notice')).toBeTruthy();
    expect(step()).toBe('skip-notice');
  });

  it('reopening the wizard from the footer chip is window 1 again', async () => {
    await minimizeWindowOne();
    act(() => openWizardPopup('wizard-1'));

    await waitFor(() => expect(useFirstRunFlowStore.getState().minimized).toBe(false));
    expect(step()).toBe('wizard');
  });
});

describe('every other dialog waits', () => {
  it('none is allowed while the flow is up, and they are again once it ends', () => {
    const { result } = renderHook(() => useDialogsAllowed());
    expect(result.current).toBe(true);

    act(() => startFirstRunFlow('project_setup'));
    expect(result.current).toBe(false);

    act(() => useFirstRunFlowStore.getState().end());
    expect(result.current).toBe(true);
  });

  it('an invitation arriving with a load takes over the load\'s origin: the flow must end the way the invitation needs', () => {
    act(() => startFirstRunFlow('app_load'));
    act(() => startFirstRunFlow('invitation'));

    expect(useFirstRunFlowStore.getState().origin).toBe('invitation');
    expect(step()).toBe('wizard');
  });

  it('...and never the other way: a load does not take over an invitation\'s flow', () => {
    act(() => startFirstRunFlow('invitation'));
    act(() => startFirstRunFlow('app_load'));

    expect(useFirstRunFlowStore.getState().origin).toBe('invitation');
  });

  it('a flow taken over by an invitation opens the gate on the way out, as the invitation waits for it', async () => {
    render(<FirstRunFlowRoot />);
    act(() => startFirstRunFlow('app_load'));
    act(() => startFirstRunFlow('invitation'));
    await waitFor(() => expect(h.openSetupWizard).toHaveBeenCalledOnce());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => closeWizardPopup());
    await leaveWindowThree();

    await waitFor(() => expect(step()).toBe('idle'));
    expect(h.gate.continueAnyway).toHaveBeenCalledOnce();
  });

  it('a second start while one is going never restarts the flow under a person -- it stays where it is', () => {
    act(() => startFirstRunFlow('app_load'));
    act(() => useFirstRunFlowStore.getState().setStep('how-to'));
    act(() => startFirstRunFlow('invitation'));

    expect(step()).toBe('how-to');
    expect(useFirstRunFlowStore.getState().origin).toBe('invitation'); // only the origin is taken over
  });
});

describe('every app load', () => {
  it('starts the wizard when it has not run fully, once per page load', async () => {
    vi.resetModules();
    const flow = await import('@src/components/first-run-flow/FirstRunFlow');
    const store = await import('@src/components/first-run-flow/first-run-flow-store');
    render(<flow.FirstRunFlowRoot />);

    await waitFor(() => expect(store.useFirstRunFlowStore.getState().origin).toBe('app_load'));
    expect(store.useFirstRunFlowStore.getState().step).toBe('wizard');
    store.useFirstRunFlowStore.getState().end();
  });

  it('shows nothing when it already ran fully', async () => {
    vi.resetModules();
    h.gate = { ...h.gate, state: 'open' };
    const flow = await import('@src/components/first-run-flow/FirstRunFlow');
    const store = await import('@src/components/first-run-flow/first-run-flow-store');
    render(<flow.FirstRunFlowRoot />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(store.useFirstRunFlowStore.getState().step).toBe('idle');
    expect(h.openSetupWizard).not.toHaveBeenCalled();
  });
});

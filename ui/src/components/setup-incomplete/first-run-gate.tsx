import { isOk } from '@sdk';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

import { openWizardPopup, useWizardPopupStore } from '@src/components/assets/editor/wizard/wizard-popup-store';
import { describeApiError } from '@src/lib/error-message';

import { useAskModalStore } from '@src/components/ask/ask-modal-store';

import { findSetupWizard } from './open-setup-wizard';
import { useFirstRunWizard } from './use-first-run-wizard';

/**
 * First-run setup before project setup (FLOWPAD-2249).
 *
 * Before a project's setup appears, the first-run wizard does — unless its last run ended all green.
 * {@link firstRunFirst} puts it in front of the person and resolves once its window is closed, finished
 * or not (minimized mid-run, once that run ended); then the project's setup is shown. It is shown again before the next project setup while it
 * is not green.
 *
 * The backend keeps the same order for every caller (`flow_sdk/core/wizard/first_run.py`): until the
 * wizard is green or its window was closed, a setup call answers 412 `first_run_setup` and a load
 * answers `blocked: 'first_run_setup'`. A screen that meets that refusal shows the wizard, then asks again.
 */
export const FIRST_RUN_BLOCK = 'first_run_setup';

/** Whether a setup call was refused because first-run setup comes first. */
export const blockedByFirstRun = (error: unknown): boolean => describeApiError(error).code === FIRST_RUN_BLOCK;

type Settle = (shown: boolean) => void;
const useGate = create<{ waiting: Settle[] }>(() => ({ waiting: [] }));

/** Whether a project setup is waiting on the first-run wizard right now. */
export const useFirstRunAwaited = (): boolean => useGate((s) => s.waiting.length > 0);

function settle(shown: boolean): void {
  const { waiting } = useGate.getState();
  useGate.setState({ waiting: [] });
  for (const resolve of waiting) resolve(shown);
}

/**
 * Show the first-run wizard unless it is all green, and resolve once its window is closed: `true` when
 * it was shown, `false` when there was nothing to show. Several screens waiting share the one wizard.
 */
export function firstRunFirst(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const first = useGate.getState().waiting.length === 0;
    useGate.setState((s) => ({ waiting: [...s.waiting, resolve] }));
    if (!first) return;
    void findSetupWizard()
      .then(async (setup) => {
        if (!setup || isOk(setup.run_state?.result)) return settle(false);
        // A run already going (the first-run trigger's) is shown as it is, never restarted.
        if (!useWizardPopupStore.getState().open) await setup.open();
        openWizardPopup(setup.typeId.toString());
      })
      .catch(() => settle(false));
  });
}

/** Tells the backend the wizard's window was closed — project setup may go ahead — then settles. */
function closed(): void {
  void findSetupWizard()
    .then((setup) => setup?.closed())
    .catch(() => {
      // Not recorded: the backend then refuses the setup, and the screen says why.
    })
    .finally(() => settle(true));
}

/**
 * Settles the screens waiting in {@link firstRunFirst} once the wizard's window is closed. Minimized while
 * it runs, they wait for the run to end (whatever its result): project setup must not race the installs it
 * stands on. A question the run asks meanwhile brings the window back. Mounted once at the app root.
 */
export function FirstRunGateRoot() {
  const awaited = useFirstRunAwaited();
  const popupOpen = useWizardPopupStore((s) => s.open);
  const asking = useAskModalStore((s) => s.open);
  const { wizard, live } = useFirstRunWizard();
  const typeId = wizard?.typeId.toString();
  // Until the wizard has been on screen for this wait, a closed popup is one that has not opened yet.
  const seen = useRef(false);
  useEffect(() => {
    if (!awaited) {
      seen.current = false;
      return;
    }
    if (popupOpen) seen.current = true;
    else if (live && asking && typeId) openWizardPopup(typeId);
    else if (seen.current && !live) {
      seen.current = false;
      closed();
    }
  }, [awaited, popupOpen, live, asking, typeId]);
  return null;
}

/** Whether a project setup screen that is `active` may show: the first-run wizard came first. */
export function useFirstRunFirst(active: boolean): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    if (!active) return undefined;
    let live = true;
    void firstRunFirst().then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, [active]);
  return ready;
}

/**
 * `call` (a setup start), asked again after the first-run wizard when the backend held it for that —
 * once: a second refusal is the answer, thrown as it came so the screen says why nothing started.
 */
export async function pastFirstRun<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!blockedByFirstRun(error) || !(await firstRunFirst())) throw error;
    return await call();
  }
}

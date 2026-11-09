import { isOk } from '@sdk';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';

import { openWizardPopup, useWizardPopupStore } from '@src/components/assets/editor/wizard/wizard-popup-store';
import { describeApiError } from '@src/lib/error-message';

import { findSetupWizard } from './open-setup-wizard';
import { useFirstRunWizard } from './use-first-run-wizard';

/**
 * First-run setup before project setup (FLOWPAD-2249).
 *
 * The backend holds every project setup run until the first-run wizard's last run ended with every
 * step green (`flow_sdk/core/wizard/first_run.py`): a setup call answers 412 `first_run_setup`, a
 * load answers `blocked: 'first_run_setup'`. The screen that asked does not show that as an error —
 * it calls {@link whenFirstRunDone}, which puts the wizard in front of the person and resolves once
 * it is all green, and then asks again. So the person meets the wizard first, and the project's setup
 * carries on by itself after it.
 *
 * Closing the wizard short of all green resolves `false`: the setup does not start, and the screen
 * says why (the backend's refusal). There is no way round it — the gate is the backend's.
 */
export const FIRST_RUN_BLOCK = 'first_run_setup';

/** Whether a setup call was refused because first-run setup has not ended all green. */
export const blockedByFirstRun = (error: unknown): boolean => describeApiError(error).code === FIRST_RUN_BLOCK;

type Settle = (done: boolean) => void;
const useGate = create<{ waiting: Settle[] }>(() => ({ waiting: [] }));

/** Whether a project setup is waiting on first-run setup right now. */
export const useFirstRunAwaited = (): boolean => useGate((s) => s.waiting.length > 0);

function settle(done: boolean): void {
  const { waiting } = useGate.getState();
  useGate.setState({ waiting: [] });
  for (const resolve of waiting) resolve(done);
}

/**
 * Show the first-run wizard and resolve once its run ended all green (`true`), or once the person
 * left it short of that (`false`). Several screens waiting share the one wizard on screen.
 */
export function whenFirstRunDone(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const first = useGate.getState().waiting.length === 0;
    useGate.setState((s) => ({ waiting: [...s.waiting, resolve] }));
    if (!first) return;
    void findSetupWizard()
      .then(async (setup) => {
        // Not shipped here, the backend holds nothing for it: nothing to wait on.
        if (!setup) return settle(true);
        // A run already going (the first-run trigger's) is shown as it is, never restarted.
        if (!useWizardPopupStore.getState().open) await setup.open();
        openWizardPopup(setup.typeId.toString());
      })
      .catch(() => settle(false));
  });
}

/**
 * Settles the screens waiting in {@link whenFirstRunDone}, from the wizard's own watched record.
 * Mounted once at the app root, beside the wizard popup.
 */
export function FirstRunGateRoot() {
  const awaited = useFirstRunAwaited();
  const { wizard, live } = useFirstRunWizard();
  const popupOpen = useWizardPopupStore((s) => s.open);
  const result = wizard?.run_state?.result;
  const runId = result?.invocation_id ?? '';
  // Until the wizard has been on screen (or running) for this wait, a closed popup is one that has
  // not opened yet — not one the person closed.
  const seen = useRef(false);
  // Green counts only once a run happened in this wait (it went live, or its record changed): the
  // backend said "not green", so a green this screen still holds from before is stale, not an answer.
  const ran = useRef(false);
  const startedOn = useRef<string | null>(null);
  useEffect(() => {
    if (!awaited) {
      seen.current = ran.current = false;
      startedOn.current = null;
      return;
    }
    startedOn.current ??= runId;
    if (live || runId !== startedOn.current) ran.current = true;
    if (ran.current && !live && isOk(result)) return settle(true);
    if (popupOpen || live) seen.current = true;
    else if (seen.current) settle(false);
  }, [awaited, result, runId, popupOpen, live]);
  return null;
}

/**
 * `call` (a setup start), asked again once first-run setup is all green when the backend held it for
 * that — once: a second refusal is the answer. Left short of all green, the refusal is thrown as it
 * came, so the screen says why nothing started.
 */
export async function pastFirstRun<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!blockedByFirstRun(error) || !(await whenFirstRunDone())) throw error;
    return await call();
  }
}

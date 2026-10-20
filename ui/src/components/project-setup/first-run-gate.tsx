import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Trans, useLingui } from '@lingui/react/macro';
import { useContext, useEntity } from '@sdk/react/hooks';
import { Wizard } from '@sdk';
import { Loader2 } from 'lucide-react';
import { startFirstRunFlow, type FirstRunOrigin } from '@src/components/first-run-flow/first-run-flow-store';
import { findSetupWizard } from '@src/components/setup-incomplete/open-setup-wizard';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/**
 * Project setup begins only after the first-run wizard is done (`flow_sdk/core/wizard/first_run.py`).
 *
 * The backend refuses (412, `data.blocked == 'first_run_setup'`) and says so in a load's `blocked`; this is
 * how a screen reads that and offers the way on, instead of a spinner nobody can end or an error.
 */

/** What a refused request carries as `data.blocked`, and a load as `blocked`. */
export const FIRST_RUN_BLOCKED = 'first_run_setup';

/** Did this fail because the first-run wizard is not done? Reads the refusal from whatever a failed call threw. */
export function isFirstRunBlocked(error: unknown): boolean {
  const e = typeof error === 'object' && error !== null ? (error as { response?: { data?: { data?: { blocked?: unknown } } } }) : null;
  return e?.response?.data?.data?.blocked === FIRST_RUN_BLOCKED;
}

/** `loading`: still looking for the wizard. `closed`: it is not done. `open`: project setup may begin. */
export type FirstRunGateState = 'loading' | 'closed' | 'open';

export interface FirstRunGate {
  state: FirstRunGateState;
  /** Goes on without finishing it, for this session -- a declined install or a blocked policy never ends all
   *  green. Resolves whether the backend took it (a failure is told to the person, and the gate stays closed). */
  continueAnyway: () => Promise<boolean>;
}

/**
 * What the backend answered, shared by every `useFirstRunGate()` on the page -- the root's, a dialog's, a waiting
 * line's. They used to ask one GET each, so one that failed (or was lost to a restart) read `open` while another
 * read `closed`, and a screen could wait forever on a gate the root had written off. One question, one answer.
 */
interface GateAnswerStore {
  /** null: not answered yet. */
  asked: 'open' | 'closed' | null;
  /** The request in flight or done: asked once per page load, by whichever hook mounts first. */
  started: boolean;
  ask: () => void;
}

export const useGateAnswerStore = create<GateAnswerStore>((set, get) => ({
  asked: null,
  started: false,
  ask: () => {
    if (get().started) return;
    set({ started: true });
    Wizard.firstRunState()
      .then((answer) => set({ asked: answer }))
      // A gate that cannot tell must not hold anyone.
      .catch(() => set({ asked: 'open' }));
  },
}));

/**
 * The gate, live. Two answers make it:
 *
 * 1. The BACKEND's, asked once at load (`GET /wizard/first-run-state`). It answers only once the shipped wizard can be
 *    looked up: on a fresh database that row appears when the system-content index ends, some 40 seconds after
 *    the app is serving, and a gate that read "no wizard yet" as "open" let a project setup and an invitation's
 *    dialog through ahead of the wizard. Until it answers the gate is `loading`.
 * 2. Then, while the backend says closed, the wizard's own entity (the push the footer's setup warning already
 *    rides): the gate opens the moment it says so.
 *
 * Anything that cannot be told -- not a desktop, a failed request, a wizard that is not here after the index
 * ended -- is OPEN: a gate that cannot tell must not hold anyone.
 */
export function useFirstRunGate(): FirstRunGate {
  const { isDesktop } = useContext();
  const { t } = useLingui();
  // null: the backend has not answered yet.
  const asked = useGateAnswerStore((s) => s.asked);
  const ask = useGateAnswerStore((s) => s.ask);
  useEffect(() => {
    if (isDesktop) ask();
  }, [isDesktop, ask]);
  // undefined: still looking. null: no such wizard here (or the lookup failed).
  const [found, setFound] = useState<Wizard | null | undefined>(undefined);
  useEffect(() => {
    if (!isDesktop || asked !== 'closed') return undefined;
    let cancelled = false;
    findSetupWizard()
      .then((wizard) => {
        if (!cancelled) setFound(wizard ?? null);
      })
      .catch(() => {
        if (!cancelled) setFound(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktop, asked]);
  const { data: live } = useEntity<Wizard>(found?.typeId ?? null, { watch: true, enabled: Boolean(found) });
  const wizard = live ?? found ?? null;

  let state: FirstRunGateState = 'open';
  if (isDesktop) {
    if (asked === null) state = 'loading';
    else if (asked === 'closed') {
      if (found === undefined) state = 'loading';
      else if (wizard && wizard.first_run_gate_open === false) state = 'closed';
    }
  }

  const continueAnyway = useCallback(async () => {
    try {
      // No wizard to waive: the backend has not taken it, so say so rather than end the flow as if it had.
      if (!wizard) throw new Error('The setup wizard is not available.');
      await wizard.continueWithoutSetup();
      return true;
    } catch (err) {
      notify.error({ title: errorMessage(err, t`Could not continue`), forceToast: true });
      return false;
    }
  }, [wizard, t]);

  return { state, continueAnyway };
}

/**
 * Call `resume` once when a screen that was refused (`blocked`) sees the gate OPEN.
 *
 * Only on a change seen while waiting (closed -> open): a gate that read open the whole time and was refused
 * anyway would otherwise resume, be refused and resume again without end.
 */
export function useFirstRunResume(blocked: boolean, gate: FirstRunGate, resume: () => void): void {
  const latest = useRef(resume);
  latest.current = resume;
  const sawClosed = useRef(false);
  useEffect(() => {
    if (!blocked) {
      sawClosed.current = false;
      return;
    }
    if (gate.state !== 'open') {
      sawClosed.current = true;
      return;
    }
    if (!sawClosed.current) return;
    sawClosed.current = false;
    latest.current();
  }, [blocked, gate.state]);
}

/**
 * What a screen shows while its project setup waits for the first-run wizard: one line. It STARTS the first-run
 * flow (the wizard, and what Skip leads to), which ends with the gate open -- and the screen goes on by itself
 * (`useFirstRunResume`). The choices live in the flow's own windows, not on every screen that waits.
 */
export function FirstRunWaiting({ origin = 'project_setup' }: { origin?: FirstRunOrigin }) {
  const gate = useFirstRunGate();
  // Only once the gate is KNOWN closed: while it is still being told (a fresh database whose wizard is not
  // indexed yet) there is no wizard to open, and starting then would end the flow at once and leave this waiting.
  useEffect(() => {
    if (gate.state === 'closed') startFirstRunFlow(origin);
  }, [gate.state, origin]);
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status" data-testid="first-run-waiting">
      <Loader2 className="size-4 animate-spin" />
      <Trans>Finishing the first-time setup first…</Trans>
    </p>
  );
}

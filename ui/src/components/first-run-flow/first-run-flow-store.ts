import { create } from 'zustand';

/**
 * The first-run flow's state: which of its three windows is up, and where the person came from.
 *
 * The flow is what the product spec draws (`agentic-assets/chart/first-run-wizard-flow`): window 1 is the setup
 * wizard, window 2 says Flowpad was not installed with its dependencies (Run setup / Continue anyway; X is Continue
 * anyway), window 3 says where to run setup again (X is the only way out). Every path out of it ends with the backend's first-run gate OPEN -- the
 * wizard ran fully, or the person pressed Continue anyway -- so whoever started the flow waits on the gate, not
 * on a callback.
 *
 * Store-driven rather than URL-driven, like every transient overlay (`create-overlay-store.ts`): what a click
 * OPENS is still URL-first; the flow only decides when a dialog may show.
 */
export type FirstRunOrigin = 'app_load' | 'project_setup' | 'invitation';
export type FirstRunStep = 'idle' | 'wizard' | 'skip-notice' | 'how-to';

interface FirstRunFlowState {
  step: FirstRunStep;
  /** What started it: decides where the person lands when it ends. */
  origin: FirstRunOrigin | null;
  /** The wizard is minimized, its run going on in the background: neither Skip nor X (they lead on to window 2),
   *  and not "in the middle" of an open window either -- other dialogs may show. */
  minimized: boolean;
  setMinimized: (minimized: boolean) => void;
  setStep: (step: FirstRunStep) => void;
  /** Starts the flow at window 1. One already going is not restarted -- but a start that something WAITS on (a
   *  project setup, an invitation) takes over the origin of a flow begun by an app load, which waits on nothing:
   *  a load and an invitation arrive together, the load's check runs first, and the flow must end the way the
   *  invitation needs (the gate opened for it), not the way a bare load does. */
  start: (origin: FirstRunOrigin) => void;
  end: () => void;
  /** The app-load check runs once per page load, whichever component mounts first; `end` leaves it alone. */
  appLoadChecked: boolean;
  markAppLoadChecked: () => void;
}

export const useFirstRunFlowStore = create<FirstRunFlowState>((set, get) => ({
  step: 'idle',
  origin: null,
  minimized: false,
  setMinimized: (minimized) => set({ minimized }),
  setStep: (step) => set({ step, minimized: false }),
  start: (origin) => {
    const { step, origin: current } = get();
    if (step === 'idle') set({ step: 'wizard', origin, minimized: false });
    else if (current === 'app_load' && origin !== 'app_load') set({ origin });
  },
  end: () => set({ step: 'idle', origin: null, minimized: false }),
  appLoadChecked: false,
  markAppLoadChecked: () => set({ appLoadChecked: true }),
}));

export const startFirstRunFlow = (origin: FirstRunOrigin) => useFirstRunFlowStore.getState().start(origin);

/** Whether the flow is on screen (not minimized). While it is, no other dialog is shown: each waits and appears after. */
export const useFirstRunFlowActive = (): boolean =>
  useFirstRunFlowStore((state) => state.step !== 'idle' && !state.minimized);

/**
 * Whether a dialog may show right now. Every global dialog root asks, and renders nothing while the first-run
 * flow is up (it keeps its state, so what was opened meanwhile appears when the flow ends). Not for the wizard's
 * own windows and its questions -- they are the flow.
 */
export const useDialogsAllowed = (): boolean => !useFirstRunFlowActive();

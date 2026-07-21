import {
  AgenticProcess,
  awaitWizardResult,
  FlowElementTypes,
  launchWizard,
  type WizardData,
  type WizardLaunchRequest,
  type WizardProcessResult,
} from '@sdk';
import { attachWizardModal, type WizardModalAttachment } from '@src/components/wizard/wizard-modal';
import { startWizardProcess } from '@src/components/wizard/start-wizard-process';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { notify } from '@src/notifications';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const DOUBLE_CLICK_MS = 250;

export type WizardPhase = 'idle' | 'running';

export interface UseWizardRunOptions<T = unknown> {
  wizardName: string;
  /** Build the wizard request lazily at click time (fresh ids / latest state). */
  buildRequest: () => WizardData | Promise<WizardData>;
  /** Short, simple success popup — e.g. "Your git is ready". */
  successMessage: string | ((data: T | null) => string);
  errorTitle?: string;
  /** Fired with the final result IF the component is still mounted. */
  onResult?: (result: WizardProcessResult<T>) => void;
  doubleClickMs?: number;
  /**
   * An already-running wizard process (for this target) to reconnect to on
   * mount instead of starting fresh — the button reflects it (spinner + live
   * tool count) rather than showing idle. Pass null when none is running.
   */
  adopt?: WizardModalAttachment | null;
}

export interface WizardRun {
  phase: WizardPhase;
  /** Live count of tools the agent has used so far (drives the counter). */
  toolCount: number;
  /** Single click = run headless; double click = open the modal. */
  onClick: () => void;
}

/**
 * Runs a wizard agent inline from a button:
 *   - single click → run headless; the caller shows a spinner + `toolCount`.
 *   - double click → open the full wizard modal (behaviour as it was so far).
 *     While already running, a double click surfaces the running process.
 *
 * On completion, if the component is still mounted, a short success/error popup
 * fires. If the user navigated away, we stop listening but never abort — the
 * wizard finishes server-side so its outcome (cloned repo, report) still lands,
 * and on remount the button is idle and clickable again.
 */
export function useWizardRun<T = unknown>(options: UseWizardRunOptions<T>): WizardRun {
  const {
    wizardName,
    buildRequest,
    successMessage,
    errorTitle,
    onResult,
    adopt = null,
    doubleClickMs = DOUBLE_CLICK_MS,
  } = options;

  const [phase, setPhase] = useState<WizardPhase>('idle');
  const [process, setProcess] = useState<AgenticProcess | null>(null);

  const mountedRef = useRef(true);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set synchronously the moment a run begins — closes the window between the
  // click and `runningRef` being populated (which only happens after the async
  // process create resolves), so rapid clicks can't spawn a second process.
  const busyRef = useRef(false);
  // The live process kept for the double-click-while-running attach path.
  const runningRef = useRef<{ process: AgenticProcess; target: string; request: WizardLaunchRequest } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (clickTimer.current) clearTimeout(clickTimer.current);
      // NB: we intentionally do NOT abort the process on unmount — the wizard
      // keeps running server-side so its outcome still lands; we just stop
      // showing progress.
    };
  }, []);

  const items = useAgenticProcessStream(process);
  const toolCount = useMemo(() => items.filter((fd) => fd.elementType === FlowElementTypes.TOOL_CALL).length, [items]);

  const finishWithResult = useCallback(
    (res: WizardProcessResult<T>) => {
      if (!mountedRef.current) return;
      if (res.status === 'done') {
        const msg = typeof successMessage === 'function' ? successMessage(res.data) : successMessage;
        notify.success({ title: msg });
      } else if (res.status === 'error') {
        notify.error({ title: errorTitle ?? 'Wizard failed', message: res.errorStr ?? undefined });
      }
      onResult?.(res);
    },
    [successMessage, errorTitle, onResult],
  );

  const runHeadless = useCallback(async () => {
    if (busyRef.current) return; // already running / starting
    busyRef.current = true;
    let request: WizardLaunchRequest;
    try {
      request = { wizardName, wizardData: await buildRequest() };
    } catch (err) {
      busyRef.current = false;
      notify.error({ title: errorTitle ?? 'Could not start', message: err instanceof Error ? err.message : undefined });
      return;
    }
    setPhase('running');
    try {
      const started = await startWizardProcess<T>(request, { headless: true });
      runningRef.current = { process: started.process, target: started.target, request };
      if (mountedRef.current) setProcess(started.process);
      void started.result.then((res) => {
        busyRef.current = false;
        runningRef.current = null;
        if (!mountedRef.current) return; // left the page → outcome persists, no popup
        setPhase('idle');
        setProcess(null);
        finishWithResult(res);
      });
    } catch (err) {
      busyRef.current = false;
      runningRef.current = null;
      if (!mountedRef.current) return;
      setPhase('idle');
      setProcess(null);
      notify.error({ title: errorTitle ?? 'Wizard failed', message: err instanceof Error ? err.message : undefined });
    }
  }, [wizardName, buildRequest, errorTitle, finishWithResult]);

  const openModal = useCallback(async () => {
    const running = runningRef.current;
    if (running) {
      // Surface the already-running headless wizard in the modal viewer.
      attachWizardModal(running);
      return;
    }
    // Idle → classic modal launch (behaviour as it was so far).
    let data: WizardData;
    try {
      data = await buildRequest();
    } catch (err) {
      notify.error({ title: errorTitle ?? 'Could not start', message: err instanceof Error ? err.message : undefined });
      return;
    }
    void launchWizard<T>(wizardName, data).then(finishWithResult);
  }, [wizardName, buildRequest, errorTitle, finishWithResult]);

  // Reconnect to an already-running wizard process (e.g. an analyze run still
  // going when we navigate back to the task). Reflect it — spinner + live tool
  // count — instead of starting fresh; single-run is enforced via busyRef.
  // Refs keep the effect keyed on the process id alone (no per-render churn).
  const adoptRef = useRef(adopt);
  adoptRef.current = adopt;
  const finishRef = useRef(finishWithResult);
  finishRef.current = finishWithResult;
  const adoptId = adopt?.process.id ?? null;

  useEffect(() => {
    const a = adoptRef.current;
    if (!a || !adoptId) return;
    if (busyRef.current) return; // a run (self-started or adopted) is already in flight
    busyRef.current = true;
    runningRef.current = a;
    setProcess(a.process);
    setPhase('running');
    let cancelled = false;
    void awaitWizardResult<T>(a.process).then((res) => {
      if (cancelled) return;
      busyRef.current = false;
      runningRef.current = null;
      if (!mountedRef.current) return;
      setPhase('idle');
      setProcess(null);
      finishRef.current(res);
    });
    return () => {
      cancelled = true;
      // Parent stopped offering this process (it finished / changed) before
      // wizard.closed was caught → drop back to idle silently (no popup).
      if (runningRef.current?.process.id === a.process.id) {
        busyRef.current = false;
        runningRef.current = null;
        if (mountedRef.current) {
          setPhase('idle');
          setProcess(null);
        }
      }
    };
  }, [adoptId]);

  const onClick = useCallback(() => {
    if (clickTimer.current) {
      // Second click within the window → double click → modal.
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      void openModal();
      return;
    }
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      // Single click → headless run (ignored while one is already running).
      if (!runningRef.current) void runHeadless();
    }, doubleClickMs);
  }, [openModal, runHeadless, doubleClickMs]);

  return { phase, toolCount, onClick };
}

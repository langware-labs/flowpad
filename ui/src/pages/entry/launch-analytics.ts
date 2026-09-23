import { isHubOnly } from '@src/navigation/hub-runtime';
import type { Step } from '@src/hooks/use-sandboxes';
import { trackEvent } from '@src/utils/analytics';
import { injectGoogleTagManager } from '@src/utils/google-tag-manager';
import { useEffect, useRef } from 'react';

/**
 * The `/launch?agent=` funnel, as GA4 events pushed to the GTM data layer.
 *
 *   launch_view → launch_sign_in_start → launch_sign_in_complete → launch_setup_start
 *     → launch_setup_step (per row: started / success / error) → launch_setup_complete
 *     → launch_enter_machine
 *
 * plus `launch_setup_error` when the setup fails, `launch_agent_error` when the link can't be
 * launched, and `launch_abandon` when the page goes away before the machine is entered.
 *
 * GTM's `launch funnel events` trigger (`^launch_`) routes these to the `hub-launch-page-tag`
 * GA4 tag, which maps each param below through a Data Layer Variable of the same name. So the
 * names here are a wire contract with the GTM container: rename one and GA4 silently loses it.
 *
 * Every push carries EVERY param, `undefined` where it does not apply: the GTM data model is
 * cumulative, so a param left out would be read back from the previous push.
 */
export type LaunchEvent =
  | 'launch_view'
  | 'launch_sign_in_start'
  | 'launch_sign_in_complete'
  | 'launch_agent_error'
  | 'launch_setup_start'
  | 'launch_setup_step'
  | 'launch_setup_complete'
  | 'launch_setup_error'
  | 'launch_enter_machine'
  | 'launch_abandon';

/** Where the visitor is in the funnel — what `launch_abandon` reports they left from. */
export type LaunchStage = 'landing' | 'sign_in' | 'setup' | 'setup_complete' | 'failed' | 'entered';

type StepStatus = 'started' | 'success' | 'error';

interface LaunchParams {
  agent_id: string | undefined;
  signed_in: 'true' | 'false';
  method: string | undefined;
  flow: 'launch';
  workflow_stage: LaunchStage;
  workflow_step_name: string | undefined;
  workflow_step_index: number | undefined;
  workflow_step_status: string | undefined;
  workflow_step_duration_sec: number | undefined;
  workflow_step_elapsed_sec: number | undefined;
  elapsed_sec: number | undefined;
  elapsed_bucket: string | undefined;
}

type StepParams = Pick<
  LaunchParams,
  | 'workflow_step_name'
  | 'workflow_step_index'
  | 'workflow_step_status'
  | 'workflow_step_duration_sec'
  | 'workflow_step_elapsed_sec'
>;

const NO_STEP: StepParams = {
  workflow_step_name: undefined,
  workflow_step_index: undefined,
  workflow_step_status: undefined,
  workflow_step_duration_sec: undefined,
  workflow_step_elapsed_sec: undefined,
};

/** Upper edges (seconds) of the `elapsed_bucket` ranges. GA4 has no percentiles, so the
 *  "how long did they wait before quitting" histogram is built from these. */
const BUCKET_EDGES = [15, 30, 60, 120, 300];

export function elapsedBucket(sec: number): string {
  let low = 0;
  for (const edge of BUCKET_EDGES) {
    if (sec < edge) return `${low}-${edge}s`;
    low = edge;
  }
  return `${low}s+`;
}

/** Seconds, to one decimal: what the GA4 custom metrics are registered in. */
function seconds(ms: number): number {
  return Math.round(ms / 100) / 10;
}

/**
 * Measured on the hub only, and never from a dev server: the hub serves the desktop build, so
 * the page-wide PRODUCTION gate never loads GTM there. A dev server forcing hub mode would
 * otherwise write test traffic into the production property.
 */
function measured(): boolean {
  return isHubOnly() && !import.meta.env.DEV;
}

export class LaunchTracker {
  private stage: LaunchStage = 'landing';
  private signedIn = false;
  private setupStartedAt: number | null = null;
  private currentStep: { id: string; index: number; startedAt: number } | null = null;
  private abandonReported = false;

  constructor(
    private readonly agentId: string | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get currentStage(): LaunchStage {
    return this.stage;
  }

  view(signedIn: boolean): void {
    this.signedIn = signedIn;
    this.push('launch_view');
  }

  signInStart(): void {
    this.stage = 'sign_in';
    this.push('launch_sign_in_start', { method: 'cloud_login' });
  }

  /** The session appeared while this page was open. Login and sign-up are one popup, and the
   *  page can't tell them apart, so this is "signed in during the launch", not a sign-up count. */
  signInComplete(): void {
    this.signedIn = true;
    this.push('launch_sign_in_complete', { method: 'cloud_login' });
  }

  agentError(reason: string): void {
    this.stage = 'failed';
    this.push('launch_agent_error', { ...NO_STEP, workflow_step_name: 'agent', workflow_step_status: reason });
  }

  setupStart(): void {
    this.stage = 'setup';
    this.setupStartedAt = this.now();
    this.push('launch_setup_start');
  }

  /**
   * One setup row changed. `index` is the row's 1-based position in the planned rows, so a
   * funnel can order the steps without knowing their names.
   */
  step(id: string, index: number, status: StepStatus): void {
    const at = this.now();
    if (status === 'started') {
      this.currentStep = { id, index, startedAt: at };
      this.push('launch_setup_step', this.stepParams(id, index, status, undefined, at));
      return;
    }
    // A row can finish without its `loading` render ever being seen (React batches the two
    // patches of an instant step), so a missing start counts as zero time spent in the row.
    const startedAt = this.currentStep?.id === id ? this.currentStep.startedAt : at;
    this.currentStep = null;
    this.push('launch_setup_step', this.stepParams(id, index, status, seconds(at - startedAt), at));
  }

  setupComplete(): void {
    this.stage = 'setup_complete';
    this.push('launch_setup_complete');
  }

  setupError(): void {
    const failedStep = this.currentStep;
    this.stage = 'failed';
    this.push(
      'launch_setup_error',
      failedStep
        ? this.stepParams(failedStep.id, failedStep.index, 'error', seconds(this.now() - failedStep.startedAt))
        : undefined,
    );
  }

  /** Last event before the redirect. Flips the stage first so the redirect's own `pagehide`
   *  is not reported as an abandon. */
  enterMachine(): void {
    this.stage = 'entered';
    this.push('launch_enter_machine');
  }

  /** The page is going away. Reported unless the visitor made it into the machine. */
  abandon(): void {
    // Once per page: a bfcache restore followed by a second hide must not count twice.
    if (this.stage === 'entered' || this.abandonReported) return;
    this.abandonReported = true;
    const step = this.currentStep;
    this.push(
      'launch_abandon',
      step ? this.stepParams(step.id, step.index, 'abandoned', seconds(this.now() - step.startedAt)) : undefined,
    );
  }

  private stepParams(
    id: string,
    index: number,
    status: string,
    durationSec: number | undefined,
    at: number = this.now(),
  ): StepParams {
    return {
      workflow_step_name: id,
      workflow_step_index: index,
      workflow_step_status: status,
      workflow_step_duration_sec: durationSec,
      workflow_step_elapsed_sec: this.currentStep ? seconds(at - this.currentStep.startedAt) : durationSec,
    };
  }

  private push(event: LaunchEvent, extra?: Partial<LaunchParams>): void {
    const elapsed = this.setupStartedAt === null ? undefined : seconds(this.now() - this.setupStartedAt);
    const params: LaunchParams = {
      agent_id: this.agentId,
      signed_in: this.signedIn ? 'true' : 'false',
      method: undefined,
      flow: 'launch',
      workflow_stage: this.stage,
      ...NO_STEP,
      elapsed_sec: elapsed,
      elapsed_bucket: elapsed === undefined ? undefined : elapsedBucket(elapsed),
      ...extra,
    };
    trackEvent({ event, ...params });
  }
}

/**
 * The tracker for one `/launch?agent=` page: loads the container when this page is measured,
 * reports `launch_view` once, and `launch_abandon` on `pagehide`.
 *
 * `pagehide`, not `visibilitychange`: a setup runs for minutes, and switching tabs while it does
 * is waiting, not quitting. GA4 sends with the beacon transport, which survives the unload.
 */
export function useLaunchTracker(agentId: string | undefined, signedIn: boolean): LaunchTracker {
  const ref = useRef<LaunchTracker | null>(null);
  if (!ref.current) ref.current = new LaunchTracker(agentId);
  const tracker = ref.current;

  useEffect(() => {
    if (measured()) injectGoogleTagManager();
    tracker.view(signedIn);
    const onHide = () => tracker.abandon();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
    // Once per page: `signedIn` is only its value at landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracker]);

  // Signed in while this page was open — the popup, or the session refresh behind it.
  const wasSignedIn = useRef(signedIn);
  useEffect(() => {
    if (signedIn && !wasSignedIn.current) tracker.signInComplete();
    wasSignedIn.current = signedIn;
  }, [signedIn, tracker]);

  return tracker;
}

/**
 * Report each setup row's transitions, read off the rows `useSandboxes` already renders.
 *
 * Diffed against the previous render rather than hooked into the launch itself, so the
 * launch code carries no analytics. `loading` is the row starting; `success` / `error` end it.
 */
export function useSetupStepTracking(tracker: LaunchTracker, steps: Step[]): void {
  const seen = useRef<Record<string, string>>({});
  useEffect(() => {
    steps.forEach((s, i) => {
      const prev = seen.current[s.id];
      if (prev === s.status) return;
      seen.current[s.id] = s.status;
      if (s.status === 'loading') tracker.step(s.id, i + 1, 'started');
      else if (s.status === 'success' || s.status === 'error') tracker.step(s.id, i + 1, s.status);
    });
  }, [steps, tracker]);
}

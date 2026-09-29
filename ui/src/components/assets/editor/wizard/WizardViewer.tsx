import { useCallback, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Trans } from '@lingui/react/macro';
import { ActionInfo, AgenticProcess, dataManager, FSRef, TypeId, Wizard, isOk, type WizardResult } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import {
  Check,
  CheckCircle2,
  Circle,
  CircleDashed,
  Copy,
  ListTree,
  Loader2,
  Minus,
  PanelRightClose,
  RotateCcw,
  TriangleAlert,
  XCircle,
} from 'lucide-react';

import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { AdvancedOnly } from '@src/components/view-mode';
import { useIsAdvanced } from '@src/components/view-mode';
import { useClock } from '@src/hooks/useActivity';
import { useJsonDoc } from '@src/hooks/use-json-doc';
import { CollapsedSideRail, SideRailButton } from '@src/components/ui/collapsed-side-rail';
import { animateMinimizeToProcessChip } from '@src/lib/minimize-to-element';
import { TabbedSideDrawer, type TabDescriptor } from '@src/components/ui/side-drawer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useSideWindows } from '@src/navigation/useSideWindows';

import { WizardDebugger } from './WizardDebugger';
import { WizardForm } from './WizardForm';
import { useWizardDoc } from './useWizardDoc';
import { agentExecutorOf, declinedByUser, rungTrail, stepStatus, useWizardRun } from './useWizardRun';
import { LIVE_STATE, type WizardDoc } from './wizard-doc';

/** The document beside `wizard.json` — the file the editor owns. */
const MAIN_FILE = 'wizard.json';

/** This viewer's one side window. The id is dock state (`?sideWindows=…`), so
 *  it is opaque, stable, and must not be renamed — a persisted URL carries it. */
const RUN_DETAIL_WINDOW = 'wizard-run';

/** Per-outcome presentation. `satisfied` is a real success — the machine was
 *  already in the state the step wanted — so it reads as done, not as skipped
 *  work. `not_reached` deliberately renders as *pending*, never as a failure:
 *  the step never ran, and blaming it for an earlier step's abort is the
 *  clearest way to send someone debugging the wrong thing. */
const STEP_STYLE: Record<string, { Icon: typeof Circle; className: string }> = {
  completed: { Icon: CheckCircle2, className: 'text-green-500' },
  satisfied: { Icon: CheckCircle2, className: 'text-green-500/70' },
  not_applicable: { Icon: CircleDashed, className: 'text-muted-foreground/40' },
  running: { Icon: Loader2, className: 'text-amber-500' },
  failed: { Icon: TriangleAlert, className: 'text-destructive' },
  refused: { Icon: TriangleAlert, className: 'text-destructive' },
  not_found: { Icon: TriangleAlert, className: 'text-destructive' },
  busy: { Icon: TriangleAlert, className: 'text-amber-500' },
  timed_out: { Icon: TriangleAlert, className: 'text-amber-500' },
  cancelled: { Icon: CircleDashed, className: 'text-muted-foreground' },
  not_started: { Icon: TriangleAlert, className: 'text-destructive/70' },
  not_reached: { Icon: Circle, className: 'text-muted-foreground/30' },
  // The person said no to the install question: a decision, drawn as a red cross, not a warning.
  declined: { Icon: XCircle, className: 'text-destructive' },
};

/** Which statuses are actually a PROBLEM — the only ones whose detail is worth
 *  a "View error" tooltip. A satisfied/completed step's own detail is just its
 *  own success sentence ("already satisfied"); showing it the same way as a
 *  failure would make every row look like it might need reading. */
const ERROR_STATUSES = new Set(['failed', 'refused', 'not_found', 'busy', 'timed_out', 'not_started']);

/** How long a running step's own activity node can sit with no new tick before
 *  it is worth telling someone — a real install (`apt-get`) legitimately takes
 *  a while, but an agent call that has printed nothing for this long is the
 *  same shape as the rate-limit/network hangs this was written after seeing. */
/** What a step's live line says while it is parked on a question to the person
 *  (`compute_op/runner.py::_ask` — "<label>: waiting for you…"). Nothing is running then,
 *  so the row shows no spinner until the person answers. */
const WAITING_FOR_PERSON = /waiting for you/i;

const STUCK_AFTER_MS = 45_000;

// Resolved at render, never at module scope: before bootstrap `iconForType`
// answers lucide `FileText`, after it a FlowIcon wrapper. A capitalised
// module-level const is registered with Fast Refresh, so an HMR re-run would
// file both under one family and hand every `FileText` a non-forwardRef type
// ("Component is not a function").
function WizardIcon({ className }: { className?: string }) {
  const Icon = iconForType(Wizard.type);
  return <Icon className={className} />;
}

/** A friendly name for the harness that actually ran the agent rung. Local to this display —
 *  not `WORKER_LABELS` — because that table's names are chosen for the harness picker, not for
 *  reading beside a model slug ("Claude" there would read as a partial sentence here). */
const AGENT_HARNESS_LABEL: Record<string, string> = {
  claude_code: 'Claude Code',
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot',
  opencode: 'OpenCode',
  deepagents: 'Deep agent',
};

/** "(harness: model-slug)" beside the agent rung — the SETTLED answer to "which agent, which
 *  model actually ran", read off the executor process itself rather than re-derived, so it can
 *  never disagree with what the spawn's own env injection used (see
 *  `api_auth.py::binding_for_candidate`, the one place that resolves it). Watched, not a
 *  one-shot fetch: `resolved_model_slug` is written by `on_turn_finally`, which can land
 *  AFTER the wizard step's own trail already reads "completed" — a plain fetch made the
 *  moment the "agent" rung first appeared could win that race and cache the field still
 *  empty, showing no label at all until the page happened to reload. */
/** Copies a failed step's error text — the tooltip closes the moment the pointer leaves it, so
 *  the text itself is hard to select; this puts the whole of it on the clipboard. */
function CopyErrorButton({ text, testId }: { text: string; testId: string }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied (insecure context / no permission): nothing to confirm.
    }
  }, [text]);
  const Glyph = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={t`Copy error`}
      title={t`Copy error`}
      className="text-muted-foreground hover:text-foreground"
      data-testid={testId}
    >
      <Glyph className="h-3.5 w-3.5" />
    </button>
  );
}

function AgentRungLabel({ executorTypeId, rowLabel }: { executorTypeId: string; rowLabel: string }) {
  const typeId = useMemo(() => {
    try {
      return new TypeId(executorTypeId);
    } catch {
      return null;
    }
  }, [executorTypeId]);
  const { data: process } = useEntity<AgenticProcess>(typeId, { enabled: !!typeId, watch: true });
  if (!process?.resolved_model_slug) return null;
  const harness = (process.worker_type && AGENT_HARNESS_LABEL[process.worker_type]) || process.worker_type || 'agent';
  // The row already names the STEP ("Claude Code"); naming the harness too is
  // only useful when it differs (installing Python via a "Deep agent" says
  // something the row doesn't) — when the tool being installed and the agent
  // installing it happen to share a name, saying it twice is just noise.
  return (
    <span className="text-xs text-muted-foreground/60" data-testid="wizard-step-agent-model">
      ({harness === rowLabel ? '' : `${harness}: `}
      {process.resolved_model_slug})
    </span>
  );
}

export function WizardViewer({ wizard, fsRef }: { wizard: Wizard; fsRef: FSRef }) {
  const mainRef = useMemo(() => fsRef.child(MAIN_FILE), [fsRef]);
  const { doc, error } = useJsonDoc<WizardDoc>(mainRef);

  // A run started from ANYWHERE else — Settings' "Run setup again", a trigger,
  // another tab — writes `run_state` on this same entity, but the prop this
  // component was handed is a snapshot from whenever the page was opened. The
  // caller (`AssetEditorRouter`) does not watch it, so without this, this page
  // would go on showing that stale snapshot even after the run it reports on
  // has long finished. `watch: true` is what keeps it live regardless of who
  // started the run; the fallback to the prop is only for the render before
  // this subscription's first tick lands.
  const { data: liveWizard } = useEntity<Wizard>(wizard.typeId, { watch: true });
  const current = liveWizard ?? wizard;

  // Keyed on the path so a different wizard remounts with its own draft rather
  // than carrying the previous one's fields into it. The body renders BEFORE
  // the document arrives — the run panel is readable from the entity payload
  // alone, and a wizard whose document is broken is exactly the one someone
  // needs to open.
  //
  // The key is the PATH only. Folding "has the read landed" into it would
  // remount when the file arrives and discard anything already on screen — an
  // open approval panel, a half-typed answer — because the read resolves a tick
  // or two after the first paint. `useWizardDoc` adopts the document instead.
  return <WizardViewerBody key={mainRef.path} wizard={current} mainRef={mainRef} initial={doc} docError={error} />;
}

function WizardViewerBody({
  wizard,
  mainRef,
  initial,
  docError,
}: {
  wizard: Wizard;
  mainRef: FSRef;
  initial: WizardDoc | null;
  docError: string | null;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [askApproval, setAskApproval] = useState(false);

  const state = wizard.run_state ?? {};
  const conversational = Boolean(wizard.agent);
  const { navigation } = useDockNavigation();
  // A run that settled OK, not one merely mid-run: `on_step`'s own partial
  // writes are always NOT_YET (see `_report_progress`), so this is only true
  // once the REAL final result lands.
  const finished = !conversational && isOk(state.result);
  // The shared 1s clock — one subscription for the whole row list, not one
  // per row (`useActivity`'s own reason: a hook cannot be called inside a
  // `.map`). Only stuck-detection reads it; that math happens per row below,
  // as plain arithmetic against each row's own `live` node.
  const now = useClock();

  // A first-run/onboarding wizard is a popup, not a page — see
  // `WizardSpec.popup`. The dialog's own content node is the minimize
  // animation's source; `[data-minimize-anchor="process-chip"]` (the footer's
  // chip) is its target, resolved by the animation itself.
  const isPopup = Boolean(wizard.popup);
  const dialogContentRef = useRef<HTMLDivElement | null>(null);
  const minimizeAndLeave = useCallback(() => {
    // Nothing to pause: the run is entirely server-side and keeps going
    // whether or not this dialog is on screen. "Minimize" is just leaving —
    // the fly animation is what tells a person where it went.
    animateMinimizeToProcessChip(dialogContentRef.current);
    navigation.goHome({ homePage: true });
  }, [navigation]);

  // Both hooks run UNCONDITIONALLY. The advanced gate below is a skin — it
  // changes what is rendered, never which hooks execute or what data is
  // fetched. (docs/viewmodes.md; `AdvancedOnly` is documented the same way.)
  const editor = useWizardDoc({ wizard, mainRef, initial });
  const runView = useWizardRun(wizard);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  // URL-first, exactly like the markdown editor's and the terminal's side
  // windows: the open set lives on the DockPointer, so opening Run detail is
  // back-button-restorable and shareable.
  const { windows, open, close, closeAll, select } = useSideWindows();
  const isAdvanced = useIsAdvanced();

  // The DOCUMENT is the source of the step list, not the last run's steps. A
  // wizard that has never run used to show no steps at all; and the last run's
  // steps are its shape, which may predate the document being read here.
  const doc = editor.doc ?? initial;
  const stepIds = (doc?.steps ?? []).map((step) => step.id);
  const { steps: joinedSteps, orphaned } = runView.join(stepIds);
  // The document's own `label` ("Claude Code", "Python 3") over the bare step
  // id ("claude-code") — the id is a stable key, not something meant to be
  // read; falling back to it is only for a step the document does not (or no
  // longer) declare.
  const stepLabels = useMemo(() => new Map((doc?.steps ?? []).map((step) => [step.id, step.label])), [doc]);

  const refresh = useCallback(async () => {
    await dataManager.refreshByTypeId(new TypeId(Wizard.type, wizard.id)).catch(() => null);
  }, [wizard.id]);

  const reset = useCallback(async () => {
    setResetting(true);
    setResetError(null);
    try {
      await wizard.resetRun();
      await refresh();
      await runView.loadDetail();
    } catch (e) {
      setResetError(errorMessage(e, t`The run could not be reset`));
    } finally {
      setResetting(false);
    }
  }, [refresh, runView, t, wizard]);

  const call = useCallback(
    async (action: string, body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const info = new ActionInfo(action, Wizard.type, wizard.id, 'POST');
        info.bodyParameters = body;
        // Every answer is a 200 carrying the WizardResult — refused, disabled and
        // not-applicable included — so the verdict is READ here, not inferred
        // from a thrown status. A run that ran shows in the run panel; one that
        // never started would otherwise vanish without a word.
        const answer = await dataManager.callAction<Record<string, unknown>, WizardResult>(info);
        await refresh();
        if (answer && !isOk(answer) && answer.ran === false) {
          notify.error({ title: t`The wizard did not run`, message: answer.detail || t`The wizard did not run` });
        }
      } catch (e) {
        notify.error({ title: t`The wizard could not run`, message: errorMessage(e, t`The wizard could not run`) });
      } finally {
        setBusy(false);
      }
    },
    [refresh, t, wizard.id],
  );

  /** Starting a run REVEALS what it is doing.
   *
   *  Opening it is a navigation, not a local toggle — `open` pushes the dock
   *  with `?sideWindows=…`, and the drawer renders from the URL. That keeps the
   *  click handler URL-first like every other one in the app, and it means the
   *  panel a run opened is still there after a reload or a Back.
   *
   *  Only in Advanced, where the window is registered: stamping the id in
   *  Standard would put a param in the URL that nothing renders. And only when
   *  it is not already open — `open` pushes unconditionally, so re-running with
   *  the panel up would leave a history entry per click for a URL that never
   *  changed. */
  const revealRunDetail = useCallback(() => {
    if (isAdvanced && !windows.includes(RUN_DETAIL_WINDOW)) open(RUN_DETAIL_WINDOW);
  }, [isAdvanced, open, windows]);

  /** A wizard that is not shipped with Flowpad runs shell on this machine, so
   *  the backend refuses it without an explicit approval. The prompt is rendered
   *  IN the page, never `window.confirm`: a native modal blocks the whole
   *  renderer (nothing else in the app can paint, and automation deadlocks on
   *  it), and it cannot show what is about to run — which is the entire point of
   *  the gate. Approving blind is the same as no gate. */
  const run = useCallback(async () => {
    // `wizard.shipped` is the BACKEND's trust answer. Not the base entity's
    // `system` flag — that reads false even for a wizard under
    // `flow_sdk/system_projects/`, so gating on it prompted for the ones
    // Flowpad ships and trusts.
    const shipped = Boolean(wizard.shipped);
    if (!shipped && !state.approved) {
      setAskApproval(true);
      return;
    }
    // Drain any in-flight blur write first: the backend runs the FILE, so
    // starting a run mid-write would execute the previous document and report
    // a result for a wizard that no longer exists on disk.
    await editor.flush();
    revealRunDetail();
    await call('run', {});
  }, [call, editor, revealRunDetail, state.approved, wizard]);

  const approveAndRun = useCallback(async () => {
    setAskApproval(false);
    revealRunDetail();
    await call('run', { approved: true });
  }, [call, revealRunDetail]);

  // A POPUP wizard's own "Start": first-run setup, not the plain per-wizard
  // `run` action above — the LLM-source chooser only lives in front of THAT
  // sequence (`run_llm_setup`/`POST /wizard/<id>/start`), never inside a
  // single wizard's own run. The backend already waits for exactly this call
  // instead of racing itself onto the screen (`_run_llm_setup_trigger`); this
  // button is the OTHER half of that same design, not a separate one.
  const [starting, setStarting] = useState(false);
  const startSetup = useCallback(async () => {
    setStarting(true);
    try {
      // Settle an LLM source, then run the wizard. Resolves when the whole run has ended — its
      // progress arrives through the run record, not this reply.
      await wizard.start();
    } catch (e) {
      notify.error({ title: t`Setup could not start`, message: errorMessage(e, t`Setup could not start`) });
      setStarting(false);
    }
    // On success, `starting` stays true: there is nothing left for this button
    // to do once the call is accepted — `run_state`/the live activity tree
    // take over from here, the same way they do for any other run.
  }, [t, wizard]);
  const notYetStarted = isPopup && !starting && !runView.live && !state.result;
  // A settled run that fell short — a step failed, or the person declined one. Popup only: the
  // generic page has its own Run button.
  const notFinished = isPopup && !conversational && !runView.live && Boolean(state.result) && !isOk(state.result);

  const main = (
    <div className="flex flex-col gap-5 p-4" data-testid="wizard-viewer">
      <header className="flex items-start gap-3">
        {/* From the backend type registry — the project's rule for every per-type
            glyph. Hardcoding `Wand2` here made the wizard icon a third copy
            (TypeInfo, the WizardSpec default, this header) that could go stale. */}
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <WizardIcon className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1 pt-0.5">
          <h2 className="text-base font-medium leading-tight">{wizard.label || wizard.name}</h2>
          {wizard.description ? (
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{wizard.description}</p>
          ) : null}
        </div>
        {/* A CONVERSATIONAL wizard has no steps and cannot be run from here: its
            agent needs the caller's prompt and payload, which only the surface
            offering it has. The backend refuses such a run, so offering the
            button would be offering a guaranteed error. */}
        {conversational || isPopup ? null : (
          <>
            {/* Reset sits beside Run because they are the same decision made
                twice — start this wizard, or start it over. It is Advanced-only
                for the same reason the editor is: it discards a run record. */}
            <AdvancedOnly reserve={false}>
              <Button
                variant="ghost"
                onClick={() => void reset()}
                // A reset landing mid-run would have the runner write its
                // outcomes into the record just cleared; the backend refuses
                // with a 409, and this keeps the button from inviting it.
                disabled={resetting || runView.live}
                title={t`Archive this run and start the record fresh. It stays approved to run.`}
                data-testid="wizard-reset"
              >
                {resetting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                <Trans>Reset</Trans>
              </Button>
            </AdvancedOnly>
            <Button onClick={() => void run()} disabled={busy} data-testid="wizard-run">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              <Trans>Run</Trans>
            </Button>
          </>
        )}
      </header>

      {resetError && (
        <p className="text-xs text-destructive" data-testid="wizard-reset-error">
          {resetError}
        </p>
      )}

      {askApproval ? (
        <section className="rounded-lg border border-destructive/40 bg-destructive/5 p-3" data-testid="wizard-approval">
          <p className="text-sm">
            <Trans>
              "{wizard.label || wizard.name}" is not shipped with Flowpad. Running it executes commands on this machine.
            </Trans>
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => void approveAndRun()} data-testid="wizard-approve">
              <Trans>Run it</Trans>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAskApproval(false)}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </section>
      ) : null}

      {/* The reader SWALLOWS a malformed document — one bad file must not wedge
          an indexer walking a hundred assets — which made "I saved it and my
          wizard disappeared" indistinguishable from "there was never a wizard
          here". This is the diagnostic. */}
      {wizard.document_error || docError ? (
        <p
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
          data-testid="wizard-document-error"
        >
          {wizard.document_error || docError}
        </p>
      ) : null}

      {joinedSteps.length > 0 ? (
        <section data-testid="wizard-steps">
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border">
            {joinedSteps.map(({ step_id, live, outcome }) => {
              // The durable OUTCOME wins whenever it exists, whether or not the
              // wizard as a whole is still running: `on_step` writes a step's
              // own answer the moment THAT step settles, well before the last
              // step does, so it is never stale mid-run. `live` only fills in
              // for the one step actually in flight right now, which has
              // started but has no outcome yet — every step in the child-node
              // tree still counts as "live" for as long as the WHOLE run keeps
              // going, so gating on that (rather than on `outcome` existing)
              // used to blank out every already-finished step's status, trail
              // and detail until the entire run ended.
              const declined = declinedByUser(outcome);
              const waiting = !outcome && WAITING_FOR_PERSON.test(live?.current ?? '');
              const status = outcome
                ? declined
                  ? 'declined'
                  : stepStatus(outcome)
                : live
                  ? waiting
                    ? 'not_reached'
                    : LIVE_STATE[live.state]?.status
                  : undefined;
              const style = STEP_STYLE[status ?? ''] ?? STEP_STYLE.not_reached;
              const { Icon } = style;
              // A step still in flight spins.
              const spin = status === 'running';
              const trail = outcome ? rungTrail(outcome) : [];
              // A step that only ever needed its check reads "validated" — the check
              // is DONE, not something the row is about to do; a longer ladder keeps
              // the rung names, since those are the steps it actually went through.
              const trailText =
                trail.length === 1 && trail[0] === 'validation' && !ERROR_STATUSES.has(status ?? '')
                  ? 'validated'
                  : trail.join(' → ');
              const agentExecutor = trail.includes('agent') ? agentExecutorOf(outcome) : null;
              const rowLabel = stepLabels.get(step_id) || step_id;
              // A step actually in flight — no outcome yet — prints its live
              // phase inline: that is the one thing worth watching unfold in
              // real time, and hiding it behind a hover would mean there is
              // nothing to see while it runs. The trail and the agent-rung
              // label persist once the step settles, same as this — none of
              // them wait for the WHOLE wizard to finish.
              const liveText = outcome ? null : live?.current;
              // A tooltip only for an actual PROBLEM — never a satisfied/
              // completed step's own "already satisfied" sentence, which is
              // not something worth reading, let alone flagging.
              const tooltipDetail = outcome && ERROR_STATUSES.has(status ?? '') ? outcome.detail : null;
              // Parked on a question: a blank slot, not a spinner and not a grey circle.
              const icon = waiting ? (
                <span className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <Icon className={`h-4 w-4 shrink-0 ${style.className} ${spin ? 'animate-spin' : ''}`} />
              );
              // Told apart from a plain "still running" by TIME, not by a
              // status the backend does not have: `live`'s own last tick is
              // the same signal the footer chip already uses to grey a
              // stalled row (`useActivity`'s `sinceLastTickMs`) — this just
              // reads it off the node `useWizardRun` already fetched instead
              // of subscribing again.
              const liveTickAt = live ? Date.parse(live.updated_at || live.started_at || '') : NaN;
              const stuckMs = status === 'running' && !Number.isNaN(liveTickAt) ? now - liveTickAt : 0;
              const stuck = stuckMs > STUCK_AFTER_MS;
              return (
                <li
                  key={step_id}
                  className="flex min-w-0 flex-col gap-1 px-3 py-2.5 text-sm transition-colors hover:bg-accent/40"
                  data-testid={`wizard-step-${step_id}`}
                  data-status={status || 'not_reached'}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {icon}
                    {/* One line, trimmed with "…" — a failed row carries its whole
                        ladder plus the agent's model, which used to run under the
                        dialog's edge. The full text is one hover away; "View error"
                        below stays pinned and visible either way. */}
                    <Tooltip delayDuration={300}>
                      <TooltipTrigger asChild>
                        <span
                          className={`min-w-0 truncate ${liveText || declined ? '' : 'flex-1'}`}
                          data-testid={`wizard-step-${step_id}-summary`}
                        >
                          <span className="font-medium text-foreground">{rowLabel}</span>
                          {trail.length > 0 && (
                            <span
                              className="ml-2 text-xs text-muted-foreground/60"
                              data-testid={`wizard-step-${step_id}-rungs`}
                            >
                              ({trailText})
                            </span>
                          )}
                          {agentExecutor && (
                            <span className="ml-2">
                              <AgentRungLabel executorTypeId={agentExecutor} rowLabel={rowLabel} />
                            </span>
                          )}
                        </span>
                      </TooltipTrigger>
                      {(trail.length > 0 || agentExecutor) && (
                        <TooltipContent className="max-w-sm" data-testid={`wizard-step-${step_id}-summary-full`}>
                          <span className="font-medium">{rowLabel}</span>
                          {trail.length > 0 && <span className="ml-2">({trailText})</span>}
                          {agentExecutor && (
                            <span className="ml-2">
                              <AgentRungLabel executorTypeId={agentExecutor} rowLabel={rowLabel} />
                            </span>
                          )}
                        </TooltipContent>
                      )}
                    </Tooltip>
                    {declined ? (
                      <span
                        className="shrink-0 text-xs font-medium text-destructive"
                        data-testid={`wizard-step-${step_id}-declined`}
                      >
                        <Trans>Cancelled by user</Trans>
                      </span>
                    ) : null}
                    {liveText && <span className="min-w-0 flex-1 truncate text-muted-foreground">— {liveText}</span>}
                    {tooltipDetail ? (
                      // A visible label, not just a subtler cursor on the icon —
                      // "something failed here" should be obvious at a glance,
                      // not something you discover by hovering the right pixel.
                      <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        <Tooltip delayDuration={0}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="text-xs font-medium text-destructive hover:underline"
                              data-testid={`wizard-step-${step_id}-view-error`}
                            >
                              <Trans>View error</Trans>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-sm" data-testid={`wizard-step-${step_id}-detail`}>
                            {tooltipDetail}
                          </TooltipContent>
                        </Tooltip>
                        <CopyErrorButton text={tooltipDetail} testId={`wizard-step-${step_id}-copy-error`} />
                      </span>
                    ) : null}
                  </div>
                  {stuck && (
                    <p
                      className="ml-6 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400"
                      data-testid={`wizard-step-${step_id}-stuck`}
                    >
                      <TriangleAlert className="h-3 w-3 shrink-0" />
                      <Trans>
                        Taking longer than usual ({Math.round(stuckMs / 1000)}s with no update) — it may be stuck.
                      </Trans>
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : conversational ? (
        <p className="text-sm text-muted-foreground">
          <Trans>This wizard runs as a conversation with {wizard.agent}, started from wherever it is offered.</Trans>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Trans>This wizard declares no steps.</Trans>
        </p>
      )}

      {/* Below the steps, centred — the last thing read, after the list of what
          will be checked. A POPUP wizard's only button, and only before anything has
          run: the backend (`_run_llm_setup_trigger`) deliberately waits for this
          instead of racing an install question onto the screen before there was
          time to read what any of it is for. Once started (by this click, or
          because a headless box already ran it before anyone was watching) there
          is nothing left to offer — Reset/Run are the generic editor page's job. */}
      {!conversational && notYetStarted ? (
        <div className="flex justify-center">
          <Button onClick={() => void startSetup()} disabled={starting} data-testid="wizard-start">
            {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            <Trans>Start</Trans>
          </Button>
        </div>
      ) : null}

      {notFinished ? (
        <section
          className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-center"
          data-testid="wizard-not-finished"
        >
          <p className="text-sm">
            <Trans>Setup didn't finish successfully.</Trans>
          </p>
          <div className="flex items-center gap-2">
            <Button onClick={() => void startSetup()} data-testid="wizard-restart">
              <Trans>Restart setup</Trans>
            </Button>
            <Button variant="ghost" onClick={() => navigation.goHome({ homePage: true })} data-testid="wizard-go-home">
              <Trans>Go to homepage</Trans>
            </Button>
          </div>
        </section>
      ) : null}

      {/* No wizard or trigger today declares "where to send someone once this
          finishes" — there is nothing to read that from, so this always goes
          home. If that changes, this is the one place to branch on it and
          swap the label to "Continue". */}
      {finished ? (
        <section
          className="flex items-center gap-3 rounded-lg border border-green-500/30 bg-green-500/5 p-3"
          data-testid="wizard-finished"
        >
          <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
          <p className="flex-1 text-sm">
            <Trans>Setup finished — everything is installed.</Trans>
          </p>
          <Button size="sm" onClick={() => navigation.goHome({ homePage: true })} data-testid="wizard-go-home">
            <Trans>Go to homepage</Trans>
          </Button>
        </section>
      ) : null}

      {/* `reserve={false}`: the default keeps the subtree mounted and its inputs
          focusable in Standard view, which is wrong for a form — you would tab
          into fields nobody can see. */}
      {conversational || !doc ? null : (
        <AdvancedOnly reserve={false}>
          <WizardForm
            doc={doc}
            wizard={wizard}
            commit={editor.commit}
            validation={editor.validation}
            saveError={editor.saveError}
            saving={editor.saving}
            readOnly={editor.readOnly}
          />
        </AdvancedOnly>
      )}
    </div>
  );

  // Run detail is a SIDE WINDOW, not a panel under the form: it is a reference
  // surface you consult while editing the steps beside it, and the drawer is
  // the app's one place for that (`useSideWindows` — same architecture as the
  // markdown editor's backlinks and the terminal's windows).
  const railTabs: TabDescriptor[] =
    conversational || !isAdvanced
      ? []
      : [
          {
            id: RUN_DETAIL_WINDOW,
            label: t`Run detail`,
            icon: ListTree,
            description: t`Every command this wizard ran, and what it printed`,
          },
        ];
  const openTabs = railTabs.filter((tab) => windows.includes(tab.id)).map((tab) => ({ ...tab, closable: true }));

  // A popup wizard skips the side-drawer machinery below: `Run detail` is
  // Advanced-only and this presentation is for the quick, glanceable
  // first-run case, not for sitting beside a document editing it.
  if (isPopup) {
    return (
      // Non-modal on purpose. A modal Radix dialog blocks the rest of the page
      // and counts any click outside itself as "dismiss" — including a click on
      // the install question this very wizard raises, which would minimize the
      // wizard instead of answering the question (and, mounted later, would
      // also sit on top of it). Non-modal has neither problem; the backdrop
      // below stands in for the dimming a modal would have drawn.
      <Dialog open modal={false} onOpenChange={(wantsOpen) => !wantsOpen && minimizeAndLeave()}>
        <div className="fixed inset-0 z-50 bg-black/80" aria-hidden="true" />
        <DialogContent
          ref={dialogContentRef}
          hideClose
          onInteractOutside={(e) => e.preventDefault()}
          className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
          data-testid="wizard-popup"
        >
          {/* Radix wants an accessible name on the dialog; `main`'s own
              visible `<h2>` already says this out loud, so this is silent. */}
          <DialogHeader className="sr-only">
            <DialogTitle>{wizard.label || wizard.name}</DialogTitle>
          </DialogHeader>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-3 top-3 h-7 w-7 text-muted-foreground"
            onClick={minimizeAndLeave}
            title={t`Minimize — it keeps running in the background`}
            data-testid="wizard-minimize"
          >
            <Minus className="h-4 w-4" />
          </Button>
          {main}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <div className="flex h-full w-full" data-testid="wizard-viewer-shell">
      <div className="min-w-0 flex-1 overflow-y-auto">{main}</div>

      {openTabs.length > 0 && (
        <TabbedSideDrawer<string>
          open
          onOpenChange={closeAll}
          closeIcon={PanelRightClose}
          closeLabel={t`Collapse side window`}
          width="w-96"
          data-testid="wizard-side-window"
          tabTestIdPrefix="wizard-side-tab"
          tabs={openTabs}
          activeTab={RUN_DETAIL_WINDOW}
          onActiveTabChange={select}
          onCloseTab={close}
        >
          {{
            [RUN_DETAIL_WINDOW]: (
              <WizardDebugger
                steps={joinedSteps}
                docSteps={doc?.steps ?? []}
                orphaned={orphaned}
                loadingDetail={runView.loadingDetail}
                onExpand={() => void runView.loadDetail()}
              />
            ),
          }}
        </TabbedSideDrawer>
      )}

      {railTabs.length > 0 && (
        <CollapsedSideRail data-testid="wizard-side-window-collapsed">
          {railTabs.map((tab) => (
            <SideRailButton
              key={tab.id}
              icon={tab.icon}
              label={tab.label}
              active={windows.includes(tab.id)}
              onClick={() => open(tab.id)}
              testId={`wizard-side-tab-collapsed-${tab.id}`}
            />
          ))}
        </CollapsedSideRail>
      )}
    </div>
  );
}

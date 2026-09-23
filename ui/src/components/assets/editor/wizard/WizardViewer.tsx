import { useCallback, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Trans } from '@lingui/react/macro';
import { ActionInfo, dataManager, FSRef, TypeId, Wizard, isOk, type WizardResult } from '@sdk';
import {
  CheckCircle2,
  Circle,
  CircleDashed,
  ListTree,
  Loader2,
  PanelRightClose,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';

import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Button } from '@src/components/ui/button';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { AdvancedOnly } from '@src/components/view-mode';
import { useIsAdvanced } from '@src/components/view-mode';
import { useJsonDoc } from '@src/hooks/use-json-doc';
import { CollapsedSideRail, SideRailButton } from '@src/components/ui/collapsed-side-rail';
import { TabbedSideDrawer, type TabDescriptor } from '@src/components/ui/side-drawer';
import { useSideWindows } from '@src/navigation/useSideWindows';

import { WizardDebugger } from './WizardDebugger';
import { WizardForm } from './WizardForm';
import { useWizardDoc } from './useWizardDoc';
import { stepStatus, useWizardRun } from './useWizardRun';
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
  not_reached: { Icon: Circle, className: 'text-muted-foreground/30' },
};

// Resolved at render, never at module scope: before bootstrap `iconForType`
// answers lucide `FileText`, after it a FlowIcon wrapper. A capitalised
// module-level const is registered with Fast Refresh, so an HMR re-run would
// file both under one family and hand every `FileText` a non-forwardRef type
// ("Component is not a function").
function WizardIcon({ className }: { className?: string }) {
  const Icon = iconForType(Wizard.type);
  return <Icon className={className} />;
}

export function WizardViewer({ wizard, fsRef }: { wizard: Wizard; fsRef: FSRef }) {
  const mainRef = useMemo(() => fsRef.child(MAIN_FILE), [fsRef]);
  const { doc, error } = useJsonDoc<WizardDoc>(mainRef);
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
  return (
    <WizardViewerBody
      key={mainRef.path}
      wizard={wizard}
      mainRef={mainRef}
      initial={doc}
      docError={error}
    />
  );
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

  const main = (
    <div className="flex flex-col gap-4 p-4" data-testid="wizard-viewer">
      <header className="flex items-center gap-2">
        {/* From the backend type registry — the project's rule for every per-type
            glyph. Hardcoding `Wand2` here made the wizard icon a third copy
            (TypeInfo, the WizardSpec default, this header) that could go stale. */}
        <WizardIcon className="h-5 w-5 text-muted-foreground" />
        <div className="flex-1">
          <h2 className="text-base font-medium">{wizard.name}</h2>
          {wizard.description ? (
            <p className="text-sm text-muted-foreground">{wizard.description}</p>
          ) : null}
        </div>
        {/* A CONVERSATIONAL wizard has no steps and cannot be run from here: its
            agent needs the caller's prompt and payload, which only the surface
            offering it has. The backend refuses such a run, so offering the
            button would be offering a guaranteed error. */}
        {conversational ? null : (
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
                {resetting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="mr-2 h-4 w-4" />
                )}
                <Trans>Reset</Trans>
              </Button>
            </AdvancedOnly>
            <Button onClick={run} disabled={busy} data-testid="wizard-run">
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
        <section
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3"
          data-testid="wizard-approval"
        >
          <p className="text-sm">
            <Trans>
              "{wizard.name}" is not shipped with Flowpad. Running it executes commands on this
              machine.
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
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive" data-testid="wizard-document-error">
          {wizard.document_error || docError}
        </p>
      ) : null}

      {joinedSteps.length > 0 ? (
        <section data-testid="wizard-steps">
          <ul className="flex flex-col gap-1">
            {joinedSteps.map(({ step_id, live, outcome }) => {
              // Live wins while the run is in flight — it is the fresher of the
              // two — and the durable answer takes over once it settles.
              const status = live && runView.live ? LIVE_STATE[live.state]?.status : stepStatus(outcome);
              const style = STEP_STYLE[status ?? ''] ?? STEP_STYLE.not_reached;
              const { Icon } = style;
              // A step still in flight spins.
              const spin = status === 'running';
              return (
                <li key={step_id} className="flex items-center gap-2 text-sm" data-testid={`wizard-step-${step_id}`}>
                  <Icon className={`h-4 w-4 shrink-0 ${style.className} ${spin ? 'animate-spin' : ''}`} />
                  <span className="font-mono text-xs text-muted-foreground">{step_id}</span>
                  {live?.current || outcome?.detail ? (
                    <span className="text-muted-foreground">— {live?.current || outcome?.detail}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : conversational ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            This wizard runs as a conversation with {wizard.agent}, started from wherever it
            is offered.
          </Trans>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Trans>This wizard declares no steps.</Trans>
        </p>
      )}

      {/* What the RUN did, which is not a fact about the document's steps. This
          used to live inside the step list, and re-sourcing that list from the
          document made a completed run's answer vanish for any wizard whose
          steps had since changed. */}
      {state.result?.detail ? <p className="text-xs text-muted-foreground">{state.result.detail}</p> : null}

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
  const railTabs: TabDescriptor[] = conversational || !isAdvanced ? [] : [
    {
      id: RUN_DETAIL_WINDOW,
      label: t`Run detail`,
      icon: ListTree,
      description: t`Every command this wizard ran, and what it printed`,
    },
  ];
  const openTabs = railTabs
    .filter((tab) => windows.includes(tab.id))
    .map((tab) => ({ ...tab, closable: true }));

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

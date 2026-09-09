import { useCallback, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Trans } from '@lingui/react/macro';
import {
  ActionInfo,
  dataManager,
  FSRef,
  TypeId,
  Wizard,
  type WizardAwaiting,
  type WizardStepOutcome,
} from '@sdk';
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
import { Input } from '@src/components/ui/input';
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
import { useWizardRun } from './useWizardRun';
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
  awaiting_input: { Icon: Loader2, className: 'text-amber-500' },
  failed: { Icon: TriangleAlert, className: 'text-destructive' },
  not_reached: { Icon: Circle, className: 'text-muted-foreground/30' },
};

const WizardIcon = iconForType(Wizard.type);

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
  const [values, setValues] = useState<Record<string, string>>({});
  const [askApproval, setAskApproval] = useState(false);

  // The SDK entity already types this; a local re-declaration was both a
  // duplicate and weaker (plain `string` where the SDK has the union).
  const state = wizard.run_state ?? {};
  const awaiting: WizardAwaiting[] = state.awaiting ?? [];
  const pending = state.status === 'pending';
  const conversational = Boolean(wizard.agent);
  // What a previous run was told. Persisting these is what lets a PARKED run
  // resume without re-asking — but it also means a SETTLED run re-runs with the
  // same answers, silently, producing a result identical to the last one. So a
  // settled run has to show them and offer a way to change them.
  const answers = Object.entries(state.inputs ?? {});
  const settled = !pending && (state.outcomes?.length ?? 0) > 0;

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

  // The DOCUMENT is the source of the step list, not `state.outcomes`. A wizard
  // that has never run used to show no steps at all; and an outcome list is the
  // shape of the last run, which may predate the document being read here.
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
        await dataManager.callAction<Record<string, unknown>, unknown>(info);
        await refresh();
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

  const submit = useCallback(
    async (name: string) => {
      // What the field SHOWS, which may be the previous answer offered back and
      // never touched. Reading `values` alone would make Continue a no-op until
      // the user typed something, on a form that already looks filled in.
      const value = values[name] ?? String(state.inputs?.[name] ?? '');
      if (value === '') return;
      // `set-input` runs the wizard again, so this is a run start too.
      revealRunDetail();
      await call('set-input', { name, value });
      setValues((prev) => ({ ...prev, [name]: '' }));
    },
    [call, revealRunDetail, values, state.inputs],
  );

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
              {pending ? <Trans>Continue</Trans> : <Trans>Run</Trans>}
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

      {/* The form is rendered from what the RUN said it needs, not from a
          hand-written list — a wizard that declares a new input grows a field
          here with no change to this component. */}
      {pending && awaiting.length > 0 ? (
        <section className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3" data-testid="wizard-awaiting">
          <p className="mb-2 text-sm font-medium">
            <Trans>This wizard needs something from you</Trans>
          </p>
          {awaiting.map((item) => (
            <div key={item.name} className="mb-2 flex flex-col gap-1">
              <label className="text-sm" htmlFor={`wz-${item.name}`}>
                {item.label || item.name}
              </label>
              {item.description ? (
                <span className="text-xs text-muted-foreground">{item.description}</span>
              ) : null}
              <div className="flex gap-2">
                <Input
                  id={`wz-${item.name}`}
                  data-testid={`wizard-input-${item.name}`}
                  // Offer the previous answer back rather than making it be
                  // retyped: a fresh run ASKS, but it should not pretend the
                  // wizard has never been told anything.
                  value={values[item.name] ?? String(state.inputs?.[item.name] ?? '')}
                  onChange={(e) => setValues((prev) => ({ ...prev, [item.name]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') void submit(item.name); }}
                />
                <Button
                  variant="secondary"
                  disabled={busy || !(values[item.name] ?? state.inputs?.[item.name])}
                  onClick={() => void submit(item.name)}
                  data-testid={`wizard-submit-${item.name}`}
                >
                  <Trans>Continue</Trans>
                </Button>
              </div>
            </div>
          ))}
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
              // two — and the durable outcome takes over once it settles.
              const status = live && runView.live ? LIVE_STATE[live.state]?.status : outcome?.status;
              const style = STEP_STYLE[status ?? ''] ?? STEP_STYLE.not_reached;
              const { Icon } = style;
              // A running step maps to `awaiting_input` in LIVE_STATE, so this
              // one test covers both the live and the parked case.
              const spin = status === 'awaiting_input';
              return (
                <li key={step_id} className="flex items-center gap-2 text-sm" data-testid={`wizard-step-${step_id}`}>
                  <Icon className={`h-4 w-4 shrink-0 ${style.className} ${spin ? 'animate-spin' : ''}`} />
                  <span className="font-mono text-xs text-muted-foreground">{step_id}</span>
                  {live?.current || outcome?.message ? (
                    <span className="text-muted-foreground">— {live?.current || outcome?.message}</span>
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
          document made a completed run's answers vanish for any wizard whose
          steps had since changed. */}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}

      {settled && answers.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="wizard-answers">
          <span className="text-xs text-muted-foreground">
            <Trans>Answered with</Trans>
          </span>
          {answers.map(([name, value]) => (
            <span
              key={name}
              className="rounded border border-border px-1.5 py-0.5 font-mono text-xs"
              data-testid={`wizard-answer-${name}`}
            >
              {name}: {typeof value === 'string' ? value : JSON.stringify(value)}
            </span>
          ))}
        </div>
      ) : null}

      {/* `reserve={false}`: the default keeps the subtree mounted and its inputs
          focusable in Standard view, which is wrong for a form — you would tab
          into fields nobody can see. */}
      {conversational || !doc ? null : (
        <AdvancedOnly reserve={false}>
          <WizardForm
            doc={doc}
            assetRef={wizard.asset_ref ?? ''}
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

import { useCallback, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Trans } from '@lingui/react/macro';
import {
  ActionInfo,
  dataManager,
  TypeId,
  Wizard,
  type WizardAwaiting,
  type WizardStepOutcome,
} from '@sdk';
import { CheckCircle2, Circle, CircleDashed, Loader2, TriangleAlert } from 'lucide-react';

import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';

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

export function WizardViewer({ wizard }: { wizard: Wizard }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [askApproval, setAskApproval] = useState(false);

  // The SDK entity already types this; a local re-declaration was both a
  // duplicate and weaker (plain `string` where the SDK has the union).
  const state = wizard.run_state ?? {};
  const awaiting: WizardAwaiting[] = state.awaiting ?? [];
  const outcomes: WizardStepOutcome[] = state.outcomes ?? [];
  const pending = state.status === 'pending';

  const refresh = useCallback(async () => {
    await dataManager.refreshByTypeId(new TypeId(Wizard.type, wizard.id)).catch(() => null);
  }, [wizard.id]);

  const call = useCallback(
    async (action: string, body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const info = new ActionInfo(action, Wizard.type, wizard.id, 'POST');
        info.bodyParameters = body;
        const result = await dataManager.callAction<Record<string, unknown>, { status?: string; message?: string }>(info);
        await refresh();
        return result;
      } catch (e) {
        notify.error({ title: t`The wizard could not run`, message: errorMessage(e, t`The wizard could not run`) });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [refresh, t, wizard.id],
  );

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
    await call('run', {});
  }, [call, state.approved, wizard]);

  const approveAndRun = useCallback(async () => {
    setAskApproval(false);
    await call('run', { approved: true });
  }, [call]);

  const submit = useCallback(
    async (name: string) => {
      const value = values[name];
      if (value === undefined || value === '') return;
      await call('set-input', { name, value });
      setValues((prev) => ({ ...prev, [name]: '' }));
    },
    [call, values],
  );

  return (
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
        <Button onClick={run} disabled={busy} data-testid="wizard-run">
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {pending ? <Trans>Continue</Trans> : <Trans>Run</Trans>}
        </Button>
      </header>

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
                  value={values[item.name] ?? ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [item.name]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') void submit(item.name); }}
                />
                <Button
                  variant="secondary"
                  disabled={busy || !values[item.name]}
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

      {outcomes.length > 0 ? (
        <section data-testid="wizard-steps">
          <ul className="flex flex-col gap-1">
            {outcomes.map((o) => {
              const style = STEP_STYLE[o.status] ?? STEP_STYLE.not_reached;
              const { Icon } = style;
              return (
                <li key={o.step_id} className="flex items-center gap-2 text-sm" data-testid={`wizard-step-${o.step_id}`}>
                  <Icon className={`h-4 w-4 shrink-0 ${style.className}`} />
                  <span className="font-mono text-xs text-muted-foreground">{o.step_id}</span>
                  {o.message ? <span className="text-muted-foreground">— {o.message}</span> : null}
                </li>
              );
            })}
          </ul>
          {state.message ? (
            <p className="mt-2 text-xs text-muted-foreground">{state.message}</p>
          ) : null}
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Trans>This wizard has not run on this machine yet.</Trans>
        </p>
      )}
    </div>
  );
}

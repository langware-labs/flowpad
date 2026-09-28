import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { DataSource, ExitCode, Wizard, apiClient, dataManager, type SetupStageState, type WizardResult } from '@sdk';
import { CheckCircle2, Circle, Lock, Loader2 } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { AskForm } from '@src/components/ask/AskForm';
import { claimAskRun } from '@src/components/ask/ask-claims';
import { notify } from '@src/notifications';

/**
 * Set up one data source through the wizards its driver declares (`setup_wizards`): a WhatsApp
 * channel's `test` stage, then its `production` stage.
 *
 * The run happens on the backend, FOR this source (`Wizard.runFor(target)`), and running it again
 * is how it resumes — every step whose check already holds is skipped. So this screen stores
 * nothing: stages come from `source.setupStages()`, which reads each wizard's run for the source.
 *
 * While a stage runs, this screen claims the run's questions (`ask-claims.ts`) and draws each one
 * in place with its guide, instead of the tab being sent to `win/ask`.
 */

interface QuestionRow {
  id: string;
  run?: string;
}

async function wizardNamed(name: string): Promise<Wizard | null> {
  // Shipped wizards surface only with `include_system` — the same read `start-wizard-process` makes.
  const rows = await apiClient.get<unknown[]>('/graph/wizard', { params: { include_system: true } });
  const wizards = (rows ?? []).map((row) => dataManager.updateEntityFromJson<Wizard>(row));
  return wizards.find((w) => w.name === name) ?? null;
}

const STATE_ICON = { done: CheckCircle2, pending: Circle, locked: Lock } as const;

export function SetupWizardDialog({
  source,
  title,
  open,
  onOpenChange,
}: {
  source: DataSource;
  /** What is being set up, for the heading (the driver's title). */
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const [stages, setStages] = useState<SetupStageState[] | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [questionId, setQuestionId] = useState<string | null>(null);
  const [last, setLast] = useState<WizardResult | null>(null);

  const load = useCallback(async () => {
    setStages(await source.setupStages());
  }, [source]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const run = async (stage: SetupStageState) => {
    const wizard = await wizardNamed(stage.wizard);
    if (!wizard) {
      notify.error({ title: t`No wizard named ${stage.wizard} is installed.` });
      return;
    }
    const target = source.typeId.toString();
    // The address the run reports under — also what its questions name. Claimed BEFORE the run
    // starts, so its first question is drawn here rather than sending the tab away.
    const { activity_path: path = '' } = await wizard.runDetail(target);
    const release = path ? claimAskRun(path, setQuestionId) : () => {};
    setRunning(stage.stage);
    setLast(null);
    try {
      const pending = wizard.runFor(target, { source: source.id, owner: source.owner ?? '' });
      // A question raised before the claim landed is still waiting: pick it up.
      const open = await apiClient.get<{ questions: QuestionRow[] }>('/api/v1/ask').catch(() => null);
      const mine = open?.questions?.find((q) => q.run === path);
      if (mine) setQuestionId(mine.id);
      setLast(await pending);
    } catch (e) {
      notify.error({ title: e instanceof Error ? e.message : String(e) });
    } finally {
      release();
      setQuestionId(null);
      setRunning(null);
      await load();
    }
  };

  const current = stages?.find((s) => s.state === 'pending');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="setup-wizard-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Set up {title}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Each stage is a guided run. Close it any time — running it again picks up where it stopped.</Trans>
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-1" data-testid="setup-stages">
          {(stages ?? []).map((stage) => {
            const Icon = running === stage.stage ? Loader2 : STATE_ICON[stage.state];
            return (
              <li
                key={stage.stage}
                className="flex items-center gap-2 rounded border px-3 py-2 text-sm"
                data-testid={`setup-stage-${stage.stage}`}
                data-state={stage.state}
              >
                <Icon className={`size-4 shrink-0 ${running === stage.stage ? 'animate-spin' : ''}`} />
                <span className="font-medium">{stage.label}</span>
                <span className="flex-1 truncate text-xs text-muted-foreground">{stage.detail}</span>
                {stage === current && !running && (
                  <Button size="sm" data-testid={`setup-stage-run-${stage.stage}`} onClick={() => void run(stage)}>
                    {stage.detail ? t`Resume` : t`Start`}
                  </Button>
                )}
              </li>
            );
          })}
          {stages && stages.length === 0 && (
            <li className="text-sm text-muted-foreground">
              <Trans>Nothing to set up.</Trans>
            </li>
          )}
        </ul>

        {running && (
          <div className="border-t pt-3" data-testid="setup-running">
            {questionId ? (
              <AskForm questionId={questionId} showOp={false} onSettled={() => setQuestionId(null)} />
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <Trans>Working…</Trans>
              </p>
            )}
          </div>
        )}

        {!running && last && (
          <ul className="flex flex-col gap-1 border-t pt-3 text-xs" data-testid="setup-last-run">
            {Object.entries(last.steps ?? {}).map(([id, step]) => (
              <li key={id} className={step.exit_code === ExitCode.OK ? 'text-muted-foreground' : 'text-destructive'}>
                {step.exit_code === ExitCode.OK ? '✓' : '•'} {step.detail || id}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

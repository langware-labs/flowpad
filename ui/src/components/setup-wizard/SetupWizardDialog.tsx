import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { DataSource, ExitCode, Wizard, apiClient, dataManager, type SetupStageState, type WizardResult } from '@sdk';
import { CheckCircle2, Circle, Lock, Loader2 } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Dialog } from '@src/components/ui/dialog';
import { SteppedDialogContent } from '@src/components/ui/stepped-dialog';
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

/** How often a running stage looks for its open question (see the effect in ``SetupWizardPanel``). */
const QUESTION_LOOK_MS = 1500;

const STATE_ICON = { done: CheckCircle2, pending: Circle, locked: Lock } as const;

/** A source's setup as its own dialog (the source row's Connect button): the same steps the add flow ends in,
 *  under the trail "<source> › Connect". */
export function SetupWizardDialog({
  source,
  open,
  onOpenChange,
}: {
  source: DataSource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SteppedDialogContent
        data-testid="setup-wizard-dialog"
        crumbs={[{ label: source.name || source.provider }, { label: t`Connect` }]}
      >
        {open && <SetupWizardPanel source={source} />}
      </SteppedDialogContent>
    </Dialog>
  );
}

/**
 * The setup itself, drawn inside whatever dialog step holds it: the stages, the running stage's question in
 * place, and what the last run did. ``autoStart`` begins the first pending stage at once — a person who just
 * pressed "Connect" should not have to press "Start" too.
 */
export function SetupWizardPanel({ source, autoStart = false }: { source: DataSource; autoStart?: boolean }) {
  const { t } = useLingui();
  const [stages, setStages] = useState<SetupStageState[] | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [questionId, setQuestionId] = useState<string | null>(null);
  const [last, setLast] = useState<WizardResult | null>(null);
  // The running stage's address, while it runs: what its questions name.
  const [runPath, setRunPath] = useState('');

  const load = useCallback(async () => {
    setStages(await source.setupStages());
  }, [source]);

  useEffect(() => {
    void load();
  }, [load]);

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
    setRunPath(path);
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
      // The server's own sentence rides the response ("… is already running on this machine"); the error's
      // message is only "Request failed with status code 409".
      const said = (e as { response?: { data?: { message?: string; detail?: string } } })?.response?.data;
      const message = said?.message || said?.detail || (e instanceof Error ? e.message : String(e));
      // Reopened while the run still waits on its person (a phone sending a code): there is nothing to start —
      // the run is THERE. Show its question here until it closes, instead of an error and a dead Resume.
      if (/already running/i.test(message)) await attach(path);
      else notify.error({ title: message });
    } finally {
      release();
      setRunPath('');
      setQuestionId(null);
      setRunning(null);
      await load();
    }
  };

  const mounted = useRef(true);
  useEffect(() => {
    // Set on every mount, not only at creation: React's development double-mount runs the cleanup once
    // before the real mount, and a ref left false there stopped every attach at its first look.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** Follow a run this screen did not start: its open question is drawn here; it is over when that closes. */
  const attach = async (path: string) => {
    let seen = false;
    while (mounted.current) {
      const open = await apiClient.get<{ questions: QuestionRow[] }>('/api/v1/ask').catch(() => null);
      const mine = open?.questions?.find((q) => q.run === path);
      if (mine) {
        seen = true;
        setQuestionId((id) => (id === mine.id ? id : mine.id));
      } else if (seen) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, QUESTION_LOOK_MS));
    }
  };

  // The push that hands this screen its question goes to the ACTIVE tab and can miss it (another tab was in
  // front, the socket was reconnecting): the screen then sat on "Working…" while the question waited. So while
  // a stage runs it also looks for its run's open question itself — a missed push costs a moment, not the run.
  useEffect(() => {
    if (!runPath) return;
    const look = async () => {
      const open = await apiClient.get<{ questions: QuestionRow[] }>('/api/v1/ask').catch(() => null);
      const mine = open?.questions?.find((q) => q.run === runPath);
      if (mine) setQuestionId((id) => (id === mine.id ? id : mine.id));
    };
    const timer = setInterval(() => void look(), QUESTION_LOOK_MS);
    return () => clearInterval(timer);
  }, [runPath]);

  const current = stages?.find((s) => s.state === 'pending');
  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current || !current || running) return;
    started.current = true;
    void run(current);
    // `run` is a closure over this render's state; starting once is the whole point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, current, running]);

  return (
    <div className="flex flex-col gap-3" data-testid="setup-wizard-panel">
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
              {/* Done is what the last run found, not a promise about now: the far side can undo it (a
                    phone that sent "stop", a revoked token). Running it again re-checks every step and
                    redoes only those that no longer hold. */}
              {stage.state === 'done' && !running && (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`setup-stage-rerun-${stage.stage}`}
                  onClick={() => void run(stage)}
                >
                  <Trans>Run again</Trans>
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
    </div>
  );
}

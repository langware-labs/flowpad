import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import apiClient from '@sdk/client';
import {
  ExitCode,
  Project,
  recheckProjectReadiness,
  type ProjectReadiness,
  type ProjectSetupRun,
} from '@sdk';
import { AlertTriangle, CheckCircle2, Circle, KeyRound, Link2, Loader2 } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { AskForm } from '@src/components/ask/AskForm';
import { claimAskRun } from '@src/components/ask/ask-claims';
import { notify } from '@src/notifications';
import { useProjectSetupStore } from './project-setup-store';

/**
 * The project's setup wizard, run in the app: what the footer's "Project setup required" opens.
 *
 * The run is the backend's (`POST project/<id>/setup` — the same wizard `flow project setup` runs),
 * so closing this loses nothing: starting again picks up where it stopped, every step whose check
 * already holds skipped. While it runs, this screen claims the run's questions (`ask-claims.ts`) and
 * draws each one in place — a secret masked, a key file as a file picker — instead of the tab being
 * sent to `win/ask`.
 */

/** How often the run's steps are re-read while it is going. A display refresh, not a wait. */
const POLL_MS = 1000;

interface QuestionRow {
  id: string;
  run?: string;
}

export function ProjectSetupDialogRoot() {
  const { open, payload, setOpen } = useProjectSetupStore();
  if (!payload) return null;
  return <ProjectSetupDialog projectId={payload.projectId} projectName={payload.projectName} open={open} onOpenChange={setOpen} />;
}

export function ProjectSetupDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
}: {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const [readiness, setReadiness] = useState<ProjectReadiness | null>(null);
  const [run, setRun] = useState<ProjectSetupRun | null>(null);
  const [questionId, setQuestionId] = useState<string | null>(null);
  const release = useRef<() => void>(() => {});

  const load = useCallback(async () => {
    setReadiness(await Project.setupRequirements(projectId));
  }, [projectId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // While the run is going: re-read its steps, and when it ends re-check the project everywhere.
  useEffect(() => {
    if (!run?.running) return;
    const timer = setInterval(async () => {
      const next = await Project.setupRun(projectId).catch(() => null);
      if (!next) return;
      setRun(next);
      if (!next.running) {
        release.current();
        setQuestionId(null);
        await Promise.all([load(), recheckProjectReadiness()]);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [run?.running, projectId, load]);

  useEffect(() => () => release.current(), []);

  const start = async () => {
    try {
      const address = await Project.startSetup(projectId);
      // Claimed at once, so the first question is drawn here rather than sending the tab away.
      release.current();
      release.current = address ? claimAskRun(address, setQuestionId) : () => {};
      setRun({ run: address, running: true, result: null });
      // A question raised before the claim landed is still waiting: pick it up.
      const waiting = await apiClient.get<{ questions: QuestionRow[] }>('/api/v1/ask').catch(() => null);
      const mine = waiting?.questions?.find((q) => q.run === address);
      if (mine) setQuestionId(mine.id);
    } catch (e) {
      notify.error({ title: e instanceof Error ? e.message : String(e) });
    }
  };

  const running = !!run?.running;
  const steps = Object.entries(run?.result?.steps ?? {});

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="project-setup-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Set up {projectName}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              What this project needs before it can run here. Close it any time — starting again picks up where it
              stopped.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        {readiness?.ready ? (
          <p className="flex items-center gap-2 text-sm text-emerald-600" data-testid="project-setup-ready">
            <CheckCircle2 className="size-4" />
            <Trans>Everything is set up.</Trans>
          </p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="project-setup-requirements">
            {(readiness?.to_do ?? []).map((req) => {
              const Icon = req.kind === 'oauth' ? Link2 : KeyRound;
              return (
                <li
                  key={`${req.kind}-${req.name}`}
                  className="flex items-center gap-2 rounded border px-3 py-2 text-sm"
                  data-testid={`project-setup-req-${req.name}`}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium">{req.title || req.name}</span>
                  <span className="flex-1 truncate text-xs text-muted-foreground">
                    {req.vars
                      .filter((v) => !v.present)
                      .map((v) => v.label || v.env_var)
                      .join(', ')}
                  </span>
                </li>
              );
            })}
            {(readiness?.gaps ?? []).map((gap) => (
              <li
                key={`gap-${gap.name}`}
                className="flex items-center gap-2 px-3 py-1 text-xs text-amber-700 dark:text-amber-400"
                data-testid={`project-setup-gap-${gap.name}`}
              >
                <AlertTriangle className="size-3.5 shrink-0" />
                {gap.note}
              </li>
            ))}
          </ul>
        )}

        {!readiness?.ready && !running && (
          <div>
            <Button data-testid="project-setup-start" disabled={!readiness} onClick={() => void start()}>
              {steps.length ? t`Continue` : t`Start`}
            </Button>
          </div>
        )}

        {running && (
          <div className="border-t pt-3" data-testid="project-setup-running">
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

        {steps.length > 0 && (
          <ul className="flex flex-col gap-1 border-t pt-3 text-xs" data-testid="project-setup-steps">
            {steps.map(([id, step]) => {
              const ok = step.exit_code === ExitCode.OK;
              const Icon = ok ? CheckCircle2 : Circle;
              return (
                <li key={id} className={`flex items-center gap-1.5 ${ok ? 'text-muted-foreground' : 'text-destructive'}`}>
                  <Icon className="size-3.5 shrink-0" />
                  {step.detail || id}
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

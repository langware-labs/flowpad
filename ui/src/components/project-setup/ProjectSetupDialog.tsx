import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Project, recheckProjectReadiness, setProjectReadiness, type ProjectReadiness } from '@sdk';
import { AlertTriangle, AppWindow, CheckCircle2, KeyRound, Link2, Loader2, Package, Radio } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { AskForm } from '@src/components/ask/AskForm';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { useProjectSetupStore } from './project-setup-store';
import { SetupTreeView } from './SetupTreeView';
import { useSetupRun } from './use-setup-run';

/**
 * The project's setup, run in the app: what the footer's "Project setup required" opens.
 *
 * The run is the backend's (`POST project/<id>/setup` — the project's setup TREE, the same one `flow
 * project setup` runs): every credential, connection, source and web app, each after what it needs.
 * Closing this loses nothing: starting again picks up where it stopped, every step whose check already
 * holds skipped. While it runs, its questions are drawn in place (`useSetupRun`) — a secret masked, a
 * key file as a file picker — instead of the tab being sent to `win/ask`.
 */

/** The glyph of what is left, by its kind; a credential (`pack`) is the key. */
const REQUIREMENT_ICONS: Partial<Record<string, typeof KeyRound>> = {
  oauth: Link2,
  dependency: Package,
  source: Radio,
  webapp: AppWindow,
};

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
  const [skipping, setSkipping] = useState<string | null>(null);

  const load = useCallback(async () => {
    setReadiness(await Project.setupRequirements(projectId));
  }, [projectId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // When the run ends, re-check the project here and everywhere it is shown.
  const setup = useSetupRun(projectId, '', async () => {
    await Promise.all([load(), recheckProjectReadiness()]);
  });

  const start = async () => {
    try {
      await setup.start();
    } catch (e) {
      notify.error({ title: errorMessage(e, t`Could not start the setup`) });
    }
  };

  // A credential the person does not need here leaves the setup: its values become OPTIONAL.
  const skip = async (name: string) => {
    setSkipping(name);
    try {
      // The skip answers with the readiness that follows: the dialog and the footer take it as is.
      const next = await Project.skipSetup(projectId, name);
      setReadiness(next);
      if (next) setProjectReadiness(next);
    } catch (e) {
      notify.error({ title: errorMessage(e, t`Could not skip ${name}`) });
    } finally {
      setSkipping(null);
    }
  };

  const running = setup.running;
  const questionId = setup.questionId;

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
              const Icon = REQUIREMENT_ICONS[req.kind] ?? KeyRound;
              // A missing dependency, a source in setup or a site that is down names itself, and the
              // reason it is not ready is its note; a credential lists the values it still needs.
              const isDependency = req.kind === 'dependency' || req.kind === 'source' || req.kind === 'webapp';
              return (
                <li
                  key={`${req.kind}-${req.name}`}
                  className="flex items-center gap-2 rounded border px-3 py-2 text-sm"
                  data-testid={`project-setup-req-${req.name}`}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium">{isDependency ? req.name : req.title || req.name}</span>
                  <span
                    className="flex-1 truncate text-xs text-muted-foreground"
                    title={isDependency ? [req.title, req.note].filter(Boolean).join(' — ') : undefined}
                  >
                    {isDependency
                      ? req.note || req.title
                      : req.vars
                          .filter((v) => !v.present)
                          .map((v) => v.label || v.env_var)
                          .join(', ')}
                  </span>
                  {req.kind === 'pack' && !running && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      data-testid={`project-setup-skip-${req.name}`}
                      title={t`Not needed here: mark its values optional`}
                      disabled={skipping !== null}
                      onClick={() => void skip(req.name)}
                    >
                      {skipping === req.name ? <Loader2 className="size-3 animate-spin" /> : <Trans>Skip</Trans>}
                    </Button>
                  )}
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
              {setup.tree ? t`Continue` : t`Start`}
            </Button>
          </div>
        )}

        {running && (
          <div className="border-t pt-3" data-testid="project-setup-running">
            {questionId ? (
              <AskForm questionId={questionId} showOp={false} onSettled={setup.settleQuestion} />
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <Trans>Working…</Trans>
              </p>
            )}
          </div>
        )}

        {setup.tree && (
          <div className="border-t pt-3" data-testid="project-setup-steps">
            <SetupTreeView tree={setup.tree} hideRoot />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

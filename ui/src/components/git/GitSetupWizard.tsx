import { t as tCore } from '@lingui/core/macro';
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { launchWizard, type Project } from '@sdk';
import { GitRepoPicker, type GitTarget } from '@src/components/git/GitRepoPicker';
import { ProjectCloudLinkButton } from '@src/components/project-home/ProjectCloudLinkButton';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { useEntity } from '@src/hooks/entity-hooks';
import { invalidateGitPreflight } from '@src/hooks/use-git-share-preflight';
import { notify } from '@src/notifications';

type WizardStep = 'where' | 'setup' | 'done';

/**
 * Give a project's own folder a git repository, for GitHub or "Flowpad git".
 *
 * GitHub (existing / new repo) runs the `git-dependency` wizard agent in
 * `adopt` mode — init, commit, push. The payload is the contract; the prompt
 * does not restate it, so the two cannot disagree about the remote or branch.
 */
async function runProjectGitSetup(project: Project, target: Exclude<GitTarget, { mode: 'flowpad' }>): Promise<boolean> {
  const path = project.fs_storage_mount_path;
  if (!path) return false;
  const result = await launchWizard('git-dependency', {
    title: tCore`Set up Git for project sharing`,
    targetTypeId: project.typeId.toString(),
    payload: {
      projectId: project.id,
      optional: false,
      mode: 'adopt',
      path,
      // Names a NEW repo only; an existing one is named by its own URL.
      ...(target.mode === 'new'
        ? { name: target.name }
        : { url: target.url, ...(target.branch ? { branch: target.branch } : {}) }),
    },
    prompt: `Set up Git in the exact project folder ${path} for sharing, as the wizard data specifies.`,
  });
  // The wizard changed this folder's git state, and nothing announces
  // filesystem changes — tell every mounted preflight to ask again.
  invalidateGitPreflight(project.typeId);
  if (result.status === 'error') throw new Error(result.errorStr ?? 'Git setup failed');
  return result.status === 'done';
}

export interface GitSetupWizardProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Git is set up — the caller resumes what the wizard stood in front of. */
  onDone?: () => void;
}

/**
 * THE git setup flow, opened nested over whatever needed git:
 * where the repo lives (`GitRepoPicker`) → set up → done.
 */
export function GitSetupWizard({ project, open, onOpenChange, onDone }: GitSetupWizardProps): React.ReactElement {
  const { t } = useLingui();
  const [step, setStep] = useState<WizardStep>('where');
  const [target, setTarget] = useState<GitTarget | null>(null);
  const [inBranchPicker, setInBranchPicker] = useState(false);
  // Live row: "Flowpad git" is done once the project's hub repo exists.
  const { data } = useEntity<Project>(project.typeId);
  const live = data ?? project;

  useEffect(() => {
    if (open && step === 'setup' && target?.mode === 'flowpad' && live.remote === true) setStep('done');
  }, [open, step, target, live.remote]);

  const start = useCallback(() => {
    if (!target) return;
    setStep('setup');
    if (target.mode === 'flowpad') return; // the step renders the hub-repo link
    void runProjectGitSetup(live, target)
      .then((ok) => setStep(ok ? 'done' : 'where'))
      .catch((err: unknown) => {
        notify.error({ title: t`Git setup failed`, message: err instanceof Error ? err.message : undefined });
        setStep('where');
      });
  }, [target, live, t]);

  const finish = useCallback(() => {
    onOpenChange(false);
    onDone?.();
  }, [onOpenChange, onDone]);

  const path = live.fs_storage_mount_path;
  return (
    <Dialog open={open} onOpenChange={(next) => step !== 'setup' && onOpenChange(next)}>
      <DialogContent className="sm:max-w-2xl" data-testid="git-setup-wizard">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add git</Trans>
          </DialogTitle>
          <DialogDescription>
            {path ? (
              <Trans>
                Choose where <span className="font-mono text-xs">{path}</span> keeps its git repository.
              </Trans>
            ) : (
              <Trans>Choose where this project keeps its git repository.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        {step === 'where' && (
          <GitRepoPicker
            modes={['existing', 'new', 'flowpad']}
            onChange={setTarget}
            onStepChange={setInBranchPicker}
            onEnter={start}
            nameSeed={live.name ?? undefined}
            urlLabel={t`Remote repository`}
            enabled={open}
            testIdPrefix="git-setup"
          />
        )}
        {step === 'setup' &&
          (target?.mode === 'flowpad' ? (
            <div className="flex flex-col items-start gap-2 text-sm" data-testid="git-setup-flowpad">
              <Trans>Link the project to Flowpad cloud — Flowpad hosts its repository.</Trans>
              <ProjectCloudLinkButton project={live} />
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="git-setup-running">
              <Loader2 className="h-4 w-4 animate-spin" />
              <Trans>Setting up git…</Trans>
            </div>
          ))}
        {step === 'done' && (
          <div className="flex items-center gap-2 text-sm" data-testid="git-setup-done">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <Trans>Git is set up.</Trans>
          </div>
        )}

        {!inBranchPicker && (
          <DialogFooter>
            {step === 'where' && (
              <>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button type="button" onClick={start} disabled={!target} data-testid="git-setup-next">
                  <Trans>Set up</Trans>
                </Button>
              </>
            )}
            {step === 'setup' && target?.mode === 'flowpad' && (
              <Button type="button" variant="outline" onClick={() => setStep('where')}>
                <Trans>Back</Trans>
              </Button>
            )}
            {step === 'done' && (
              <Button type="button" onClick={finish} data-testid="git-setup-finish">
                <Trans>Done</Trans>
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default GitSetupWizard;

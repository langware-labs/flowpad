import { formatGitOrigin, gitOriginCloneUrl } from '@sdk/models/GitOrigin';
import { Project, type GitOrigin } from '@sdk';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { useCloneGitProjectAndOpen, useInstallSharedProjectAndOpen } from '@src/components/project-selector';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { AlertTriangle, CheckCircle2, GitBranch, Loader2 } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/**
 * "X shared a project with you" — the landing for a project that arrived.
 *
 * Two arrivals wear it, and they differ only in what "set up" means:
 *   * a shared project (`projectId`) already exists locally as a row with no
 *     files, so it is materialized IN PLACE and keeps the id both ends share;
 *   * a template deep link has no row yet, so it is cloned into a fresh Project
 *     (`create-project-from-git`), with the 409 collision path letting the user
 *     accept a suggested `<leaf>-N` folder name.
 * Both end in the same place: an indexed project, opened.
 */
type Step = 'confirm' | 'cloning' | 'collision' | 'success' | 'error';

interface Props {
  open: boolean;
  gitOrigin: GitOrigin;
  projectName: string;
  senderName: string;
  /** A shared project's id: install it in place instead of cloning a template. */
  projectId?: string;
  onClose: () => void;
}

export function IncomingProjectDialog({ open, gitOrigin, projectName, senderName, projectId, onClose }: Props) {
  const { t } = useLingui();
  const { computeNode } = useAgentContext();
  const cloneGitProject = useCloneGitProjectAndOpen();
  const installSharedProject = useInstallSharedProjectAndOpen();

  const [step, setStep] = useState<Step>('confirm');
  const [errorMsg, setErrorMsg] = useState('');
  const [suggestedName, setSuggestedName] = useState('');
  const [attemptedName, setAttemptedName] = useState('');
  const [nameOverride, setNameOverride] = useState('');
  const startedRef = useRef(false);

  const originLabel = formatGitOrigin(gitOrigin);
  const branch = gitOrigin.branch || '';

  // Reset when the dialog closes so a second share opens clean.
  const handleClose = useCallback(() => {
    startedRef.current = false;
    setStep('confirm');
    setErrorMsg('');
    setSuggestedName('');
    setAttemptedName('');
    setNameOverride('');
    onClose();
  }, [onClose]);

  /**
   * A shared project is materialized IN PLACE: the row already exists locally
   * (the hub pushed it on the grant), it just has no files yet. Installing
   * clones into the workspace, binds this id to that checkout and indexes it —
   * so the agents the project ships with are rows before we navigate, which is
   * what lets auto-launch find them on arrival.
   */
  const runInstallShared = useCallback(
    async (id: string) => {
      setStep('cloning');
      try {
        // The watcher that raised this dialog already held the row; prefer the
        // cache and only pay for a fetch when this came from a cold start.
        const project = Project.getByIdFromCache(id) ?? (await Project.getById(id));
        if (!project) throw new Error(t`That project is no longer available.`);
        await installSharedProject(project);
        setStep('success');
        setTimeout(handleClose, 600);
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setStep('error');
      }
    },
    [handleClose, installSharedProject, t],
  );

  const runClone = useCallback(
    async (targetName?: string) => {
      if (!computeNode) {
        setErrorMsg(t`No compute node available in this workspace.`);
        setStep('error');
        return;
      }
      setStep('cloning');
      // Clone + index + open, via the shared handler (also used by QuickCreate).
      const result = await cloneGitProject(computeNode.id, gitOriginCloneUrl(gitOrigin), {
        targetName,
        branch: branch || undefined,
      });
      if (result.kind === 'ok') {
        setStep('success');
        setTimeout(handleClose, 600);
        return;
      }
      if (result.kind === 'collision') {
        setSuggestedName(result.suggestedName);
        setAttemptedName(result.attemptedName);
        setNameOverride(result.suggestedName);
        setStep('collision');
        return;
      }
      setErrorMsg(result.message);
      setStep('error');
    },
    [computeNode, gitOrigin, branch, cloneGitProject, handleClose, t],
  );

  const handleConfirm = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    // Two different things wear this one dialog: a shared project is installed
    // in place, a template is cloned into a new one.
    void (projectId ? runInstallShared(projectId) : runClone());
  }, [projectId, runClone, runInstallShared]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-lg" data-testid="incoming-project-dialog">
        {/* Confirm — "would you like to set up X" */}
        {step === 'confirm' && (
          <>
            <DialogHeader>
              <DialogTitle>
                <Trans>
                  <strong>{senderName}</strong> shared a project with you
                </Trans>
              </DialogTitle>
              <DialogDescription>
                <Trans>
                  Set up <em>{projectName}</em> in this workspace. We'll clone the repo and index it so it's ready to use.
                </Trans>
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
              {originLabel && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="shrink-0"><Trans>Repo:</Trans></span>
                  <code className="truncate text-foreground">{originLabel}</code>
                </div>
              )}
              {branch && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <GitBranch className="h-3.5 w-3.5 shrink-0" />
                  <code className="text-foreground">{branch}</code>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={handleClose}><Trans>Cancel</Trans></Button>
              <Button onClick={handleConfirm} data-testid="incoming-project-install">
                <Trans>Set up project</Trans>
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Cloning */}
        {step === 'cloning' && (
          <>
            <DialogHeader>
              <DialogTitle><Trans>Setting up your project…</Trans></DialogTitle>
              <DialogDescription>
                <Trans>Cloning the repo and indexing it.</Trans>
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          </>
        )}

        {/* Collision — the folder name is taken, offer a free one */}
        {step === 'collision' && (
          <>
            <DialogHeader>
              <DialogTitle><Trans>A project with that name exists</Trans></DialogTitle>
              <DialogDescription>
                <Trans>
                  <code>{attemptedName}</code> already exists in this workspace. Choose a different folder name.
                </Trans>
              </DialogDescription>
            </DialogHeader>
            <Input
              value={nameOverride}
              onChange={(e) => setNameOverride(e.target.value)}
              placeholder={suggestedName}
              className="text-sm"
            />
            <DialogFooter>
              <Button variant="ghost" onClick={handleClose}><Trans>Cancel</Trans></Button>
              <Button
                onClick={() => void runClone(nameOverride.trim() || suggestedName)}
                disabled={!nameOverride.trim() && !suggestedName}
              >
                <Trans>Set up as this name</Trans>
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Success */}
        {step === 'success' && (
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              <Trans>Ready!</Trans>
            </DialogTitle>
            <DialogDescription><Trans>Opening your project…</Trans></DialogDescription>
          </DialogHeader>
        )}

        {/* Error */}
        {step === 'error' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-destructive" />
                <Trans>Couldn't set up the project</Trans>
              </DialogTitle>
              <DialogDescription asChild>
                <div>
                  <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted px-3 py-2 text-xs text-foreground whitespace-pre-wrap">
                    {errorMsg}
                  </pre>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={handleClose}><Trans>Close</Trans></Button>
              <Button onClick={() => void runClone()}><Trans>Retry</Trans></Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

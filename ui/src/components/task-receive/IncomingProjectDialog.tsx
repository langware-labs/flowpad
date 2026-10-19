import { gitOriginCloneUrl } from '@sdk/models/GitOrigin';
import { formatFSOrigin, isGitOrigin, type ProjectOrigin } from '@sdk/models/FSOrigin';
import { Project } from '@sdk';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { nameConflictOf } from '@src/components/conversation/asset-review/ProjectInstallAction';
import { useCloneGitProjectAndOpen, useInstallSharedProjectAndOpen } from '@src/components/project-selector';
import { useSelectExistingProject } from '@src/components/project-selector/use-ensure-project';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { errorMessage } from '@src/lib/error-message';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { withHomePage } from '@src/project-home-page/home-page-state';
import { declineSetup } from '@src/store/use-incoming-project-store';
import { AlertTriangle, CheckCircle2, GitBranch, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
 *
 * A shared project whose name is already a project here (`nameTaken`) opens on
 * the choice instead: open that project, or install the shared one under
 * another name (`Project.installFromHub`).
 */
type Step = 'confirm' | 'name-taken' | 'cloning' | 'collision' | 'success' | 'error';

interface Props {
  open: boolean;
  gitOrigin: ProjectOrigin;
  projectName: string;
  senderName: string;
  /** A shared project's id: install it in place instead of cloning a template. */
  projectId?: string;
  /** Its name is already a project here: ask instead of setting it up. */
  nameTaken?: { existingProjectId: string; suggestedName: string };
  onClose: () => void;
}

export function IncomingProjectDialog({
  open,
  gitOrigin,
  projectName,
  senderName,
  projectId,
  nameTaken,
  onClose,
}: Props) {
  const { t } = useLingui();
  const { computeNode } = useAgentContext();
  const { navigation, currentDock } = useDockNavigation();
  const here = currentDock?.toUrl() ?? '';
  const cloneGitProject = useCloneGitProjectAndOpen();
  const installSharedProject = useInstallSharedProjectAndOpen();
  const landInProject = useSelectExistingProject();

  const firstStep: Step = nameTaken && projectId ? 'name-taken' : 'confirm';
  const [step, setStep] = useState<Step>(firstStep);
  const [newName, setNewName] = useState(nameTaken?.suggestedName ?? '');
  const [takenAgain, setTakenAgain] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [suggestedName, setSuggestedName] = useState('');
  const [attemptedName, setAttemptedName] = useState('');
  const [nameOverride, setNameOverride] = useState('');
  const [dontAskAgain, setDontAskAgain] = useState(true);
  const startedRef = useRef(false);
  /** The location a set-up started on: once it succeeds, the dialog stays up until the app has left it. */
  const [setupFrom, setSetupFrom] = useState<string | null>(null);

  const originLabel = formatFSOrigin(gitOrigin);
  const branch = isGitOrigin(gitOrigin) ? gitOrigin.branch || '' : '';

  // Reset when the dialog closes so a second share opens clean.
  const handleClose = useCallback(() => {
    startedRef.current = false;
    setStep('confirm');
    setTakenAgain('');
    setErrorMsg('');
    setSuggestedName('');
    setAttemptedName('');
    setNameOverride('');
    setSetupFrom(null);
    setDontAskAgain(true);
    onClose();
  }, [onClose]);

  /** Closed without setting up it (cancelled, or opened the project that holds its name): with
   *  "Don't ask me again" ticked, this project is not offered again. */
  const handleDecline = useCallback(() => {
    if (projectId && dontAskAgain && (step === 'confirm' || step === 'name-taken')) declineSetup(projectId);
    handleClose();
  }, [projectId, dontAskAgain, step, handleClose]);

  const dontAskAgainField = projectId && (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <Checkbox
        checked={dontAskAgain}
        onCheckedChange={(checked) => setDontAskAgain(checked === true)}
        data-testid="incoming-project-dont-ask-again"
      />
      <Trans>Don't ask me again</Trans>
    </label>
  );

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
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setStep('error');
      }
    },
    [installSharedProject, t],
  );

  const runClone = useCallback(
    async (targetName?: string) => {
      if (!computeNode) {
        setErrorMsg(t`No compute node available in this workspace.`);
        setStep('error');
        return;
      }
      if (!isGitOrigin(gitOrigin)) {
        // A hub-hosted copy is only ever a SHARED project, installed in place.
        setErrorMsg(t`This project can only be opened from its share.`);
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
    [computeNode, gitOrigin, branch, cloneGitProject, t],
  );

  /** The name is taken here: open the project that holds it. */
  const openExisting = useCallback(() => {
    if (!nameTaken) return;
    navigation.openDock(withHomePage(DockPointer.forProject(nameTaken.existingProjectId)));
    handleDecline();
  }, [nameTaken, navigation, handleDecline]);

  /** The name is taken here: install the shared project under the receiver's name. */
  const runInstallAsName = useCallback(
    async (id: string, name: string) => {
      setStep('cloning');
      setTakenAgain('');
      try {
        const project = await Project.installFromHub(id, name);
        if (!project) throw new Error(t`That project is no longer available.`);
        await landInProject(project);
        setStep('success');
      } catch (e) {
        const taken = nameConflictOf(e);
        if (taken) {
          setTakenAgain(taken.attempted_name);
          setNewName(taken.suggested_name);
          setStep('name-taken');
          return;
        }
        setErrorMsg(errorMessage(e, String(e)));
        setStep('error');
      }
    },
    [landInProject, t],
  );

  // Close only once the app has left the page the set-up started on. Landing in the project
  // redirects to its home page, which may be an agent's chat or an app rather than the project
  // dock, and on a slow machine that loader takes a while: a dialog that closed on a timer left
  // the app home showing, with a prompt box that looked usable but was about to be navigated away.
  useEffect(() => {
    if (step === 'cloning') setSetupFrom((from) => from ?? here);
  }, [step, here]);
  useEffect(() => {
    if (step === 'success' && setupFrom !== null && here !== setupFrom) handleClose();
  }, [step, setupFrom, here, handleClose]);

  const handleConfirm = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    // Two different things wear this one dialog: a shared project is installed
    // in place, a template is cloned into a new one.
    void (projectId ? runInstallShared(projectId) : runClone());
  }, [projectId, runClone, runInstallShared]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) handleDecline();
      }}
    >
      {/* Only its own buttons close it: another dialog opening over it (the first-run setup
          wizard) counts as a click outside, and would otherwise dismiss it unseen. */}
      <DialogContent
        className="max-w-lg"
        data-testid="incoming-project-dialog"
        onInteractOutside={(e) => e.preventDefault()}
      >
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
                  Set up <em>{projectName}</em> in this workspace. We'll clone the repo and index it so it's ready to
                  use.
                </Trans>
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
              {originLabel && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="shrink-0">
                    <Trans>Repo:</Trans>
                  </span>
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
            {dontAskAgainField}
            <DialogFooter>
              <Button variant="ghost" onClick={handleDecline}>
                <Trans>Cancel</Trans>
              </Button>
              <Button onClick={handleConfirm} data-testid="incoming-project-install">
                <Trans>Set up project</Trans>
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Name taken — the shared project's name is already a project here */}
        {step === 'name-taken' && nameTaken && projectId && (
          <>
            <DialogHeader>
              <DialogTitle>
                <Trans>
                  <strong>{senderName}</strong> shared a project with you
                </Trans>
              </DialogTitle>
              <DialogDescription>
                <Trans>
                  You already have a project named <strong>{projectName}</strong>. Open it, or set this one up under
                  another name.
                </Trans>
              </DialogDescription>
            </DialogHeader>
            {originLabel && (
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                <span className="shrink-0">
                  <Trans>Repo:</Trans>
                </span>
                <code className="truncate text-foreground">{originLabel}</code>
              </div>
            )}
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={nameTaken.suggestedName}
              className="text-sm"
              data-testid="incoming-project-new-name"
            />
            {takenAgain && (
              <p className="text-xs text-destructive" role="alert">
                <Trans>
                  <code>{takenAgain}</code> is taken too. Choose another name.
                </Trans>
              </p>
            )}
            {dontAskAgainField}
            <DialogFooter>
              <Button variant="ghost" onClick={handleDecline}>
                <Trans>Cancel</Trans>
              </Button>
              <Button variant="secondary" onClick={openExisting} data-testid="incoming-project-open-existing">
                <Trans>Open my project</Trans>
              </Button>
              <Button
                onClick={() => void runInstallAsName(projectId, newName.trim())}
                disabled={!newName.trim()}
                data-testid="incoming-project-install-as-name"
              >
                <Trans>Set up as this name</Trans>
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Cloning */}
        {step === 'cloning' && (
          <>
            <DialogHeader>
              <DialogTitle>
                <Trans>Setting up your project…</Trans>
              </DialogTitle>
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
              <DialogTitle>
                <Trans>A project with that name exists</Trans>
              </DialogTitle>
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
              <Button variant="ghost" onClick={handleClose}>
                <Trans>Cancel</Trans>
              </Button>
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
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                <Trans>Ready!</Trans>
              </DialogTitle>
              <DialogDescription>
                <Trans>Opening your project…</Trans>
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          </>
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
                  <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted px-3 py-2 text-xs text-foreground">
                    {errorMsg}
                  </pre>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={handleClose}>
                <Trans>Close</Trans>
              </Button>
              <Button
                onClick={() => {
                  // Retry must take the SAME branch the confirm took. Calling
                  // runClone() here minted a brand-new project from the template
                  // path and discarded the shared id both ends agree on.
                  startedRef.current = false;
                  if (nameTaken && projectId) setStep('name-taken');
                  else void (projectId ? runInstallShared(projectId) : runClone());
                }}
              >
                <Trans>Retry</Trans>
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

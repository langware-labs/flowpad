import { dataContext } from '@sdk';
import { findProjectForTask, pullForTask, cloneForTask } from '@sdk/entities/task-receive';
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
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { AlertTriangle, CheckCircle2, FolderOpen, GitBranch, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Step =
  | 'checking'
  | 'found'
  | 'not_found'
  | 'pulling'
  | 'cloning'
  | 'conflict'
  | 'success'
  | 'error';

interface KnownProject {
  name: string;
  path: string;
}

interface FindResult {
  found: boolean;
  local_path: string | null;
  repo_url: string;
  branch: string;
  known_projects: KnownProject[];
}

interface Props {
  open: boolean;
  taskId: string;
  taskTitle: string;
  senderName: string;
  projectUrl?: string;
  branch?: string;
  repoId?: string;
  onClose: () => void;
}

export function IncomingTaskDialog({ open, taskId, taskTitle, senderName, projectUrl, branch, repoId, onClose }: Props) {
  const { navigation } = useDockNavigation();
  const [step, setStep] = useState<Step>('checking');
  const [findResult, setFindResult] = useState<FindResult | null>(null);
  const [localPath, setLocalPath] = useState('');
  const [cloneTarget, setCloneTarget] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const hasChecked = useRef(false);

  const computeNode = useMemo(() => dataContext.computeNode, []);

  // Run find-project on open
  useEffect(() => {
    if (!open || !taskId) return;
    if (hasChecked.current) return;
    hasChecked.current = true;

    setStep('checking');
    setFindResult(null);
    setErrorMsg('');

    findProjectForTask(taskId, { projectUrl, branch, repoId })
      .then((result) => {
        setFindResult(result);
        setLocalPath(result.local_path ?? '');
        setStep(result.found ? 'found' : 'not_found');
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Failed to look up project.';
        setErrorMsg(msg);
        setStep('error');
      });
  }, [open, taskId]);

  // Reset when dialog closes
  const handleClose = useCallback(() => {
    hasChecked.current = false;
    setStep('checking');
    setFindResult(null);
    setCloneTarget('');
    setErrorMsg('');
    onClose();
  }, [onClose]);

  const handleConfirmPull = useCallback(async () => {
    setStep('pulling');
    try {
      const result = await pullForTask(taskId, localPath || undefined, { projectUrl, branch });
      if (result.conflicts) {
        setStep('conflict');
      } else if (result.success) {
        setStep('success');
        setTimeout(() => {
          navigation.openDock(DockPointer.fromUrl('tasks', taskId));
          handleClose();
        }, 800);
      } else {
        setErrorMsg(result.error ?? 'Pull failed.');
        setStep('error');
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Pull failed.');
      setStep('error');
    }
  }, [taskId, localPath, projectUrl, branch, navigation, handleClose]);

  const handleConfirmClone = useCallback(async () => {
    if (!cloneTarget) return;
    setStep('cloning');
    try {
      const result = await cloneForTask(taskId, cloneTarget, { projectUrl, branch });
      if (result.conflicts) {
        setLocalPath(result.cloned_path ?? cloneTarget);
        setStep('conflict');
      } else if (result.success) {
        setStep('success');
        setTimeout(() => {
          navigation.openDock(DockPointer.fromUrl('tasks', taskId));
          handleClose();
        }, 800);
      } else {
        setErrorMsg(result.error ?? 'Clone failed.');
        setStep('error');
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Clone failed.');
      setStep('error');
    }
  }, [taskId, cloneTarget, projectUrl, branch, navigation, handleClose]);

  const handlePickFolder = useCallback(async () => {
    if (!computeNode) return;
    try {
      const selected = await computeNode.openPathDialog();
      if (selected) setCloneTarget(selected);
    } catch {
      // user cancelled or picker unavailable
    }
  }, [computeNode]);

  const resolvedBranch = findResult?.branch || branch || '';
  const repoUrl = findResult?.repo_url || '';
  const knownProjects = findResult?.known_projects ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-lg">
        {/* Checking */}
        {step === 'checking' && (
          <>
            <DialogHeader>
              <DialogTitle>Looking up project…</DialogTitle>
              <DialogDescription>
                Checking if you have a local clone of the repository.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          </>
        )}

        {/* Found — confirm pull */}
        {step === 'found' && (
          <>
            <DialogHeader>
              <DialogTitle>Pull and open task</DialogTitle>
              <DialogDescription>
                <strong>{senderName}</strong> shared <em>{taskTitle}</em> with you.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
              {repoUrl && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="shrink-0">Repo:</span>
                  <code className="truncate text-foreground">{repoUrl}</code>
                </div>
              )}
              {resolvedBranch && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <GitBranch className="h-3.5 w-3.5 shrink-0" />
                  <code className="text-foreground">{resolvedBranch}</code>
                </div>
              )}
              {localPath && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                  <code className="truncate text-foreground">{localPath}</code>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={handleClose}>Cancel</Button>
              <Button onClick={() => void handleConfirmPull()}>Pull &amp; Open</Button>
            </DialogFooter>
          </>
        )}

        {/* Pulling */}
        {step === 'pulling' && (
          <>
            <DialogHeader>
              <DialogTitle>Pulling…</DialogTitle>
            </DialogHeader>
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          </>
        )}

        {/* Not found — offer clone or known projects */}
        {step === 'not_found' && (
          <>
            <DialogHeader>
              <DialogTitle>Project not found locally</DialogTitle>
              <DialogDescription>
                <strong>{senderName}</strong> shared <em>{taskTitle}</em> with you, but we couldn't
                find a local clone of the repository. Clone it to see the task.
              </DialogDescription>
            </DialogHeader>

            {knownProjects.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Known projects (click to clone alongside):</p>
                <div className="max-h-28 overflow-y-auto rounded-md border text-xs">
                  {knownProjects.map((p) => (
                    <button
                      key={p.path}
                      type="button"
                      className="w-full px-3 py-1.5 text-left hover:bg-accent truncate"
                      onClick={() => setCloneTarget(p.path.replace(/[/\\][^/\\]+$/, ''))}
                    >
                      <span className="font-medium">{p.name}</span>{' '}
                      <span className="text-muted-foreground">{p.path}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Input
                placeholder="Parent folder to clone into…"
                value={cloneTarget}
                onChange={(e) => setCloneTarget(e.target.value)}
                className="flex-1 text-sm"
              />
              {computeNode && (
                <Button variant="outline" size="icon" onClick={() => void handlePickFolder()} title="Browse…">
                  <FolderOpen className="h-4 w-4" />
                </Button>
              )}
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={handleClose}>Cancel</Button>
              <Button onClick={() => void handleConfirmClone()} disabled={!cloneTarget}>
                Clone &amp; Open
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Cloning */}
        {step === 'cloning' && (
          <>
            <DialogHeader>
              <DialogTitle>Cloning…</DialogTitle>
            </DialogHeader>
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          </>
        )}

        {/* Success */}
        {step === 'success' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                Done!
              </DialogTitle>
              <DialogDescription>Opening task…</DialogDescription>
            </DialogHeader>
          </>
        )}

        {/* Conflict */}
        {step === 'conflict' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-yellow-500" />
                Merge conflicts
              </DialogTitle>
              <DialogDescription>
                There are merge conflicts in <code>{localPath}</code>. Please resolve them and try again.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={handleClose}>Close</Button>
              <Button onClick={() => void handleConfirmPull()}>Retry pull</Button>
            </DialogFooter>
          </>
        )}

        {/* Error */}
        {step === 'error' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-destructive" />
                Something went wrong
              </DialogTitle>
              <DialogDescription asChild>
                <div>
                  <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted px-3 py-2 text-xs text-foreground whitespace-pre-wrap">
                    {errorMsg}
                  </pre>
                  <p className="mt-3 text-sm text-muted-foreground">
                    Please fix the issue in your repository and try again.
                  </p>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={handleClose}>Close</Button>
              <Button onClick={() => void handleConfirmPull()}>Retry</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

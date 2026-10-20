import { useEffect, useRef } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { onDependencyLoaded } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { AskForm } from '@src/components/ask/AskForm';
import { SetupFailureActions } from './SetupFailureActions';
import { useSetupFix } from './use-setup-fix';
import { SetupTreeView } from './SetupTreeView';
import { useDialogsAllowed } from '@src/components/first-run-flow/first-run-flow-store';
import { FIRST_RUN_BLOCKED, FirstRunWaiting, useFirstRunGate, useFirstRunResume } from './first-run-gate';
import { useProjectLoad } from './use-project-load';
import { openProjectLoad, useProjectLoadStore, type ProjectLoadPayload } from './project-load-store';

export function ProjectLoadDialogRoot() {
  const { open, payload, setOpen } = useProjectLoadStore();
  // Hidden, not unmounted, while the first-run flow is up: the dialog remembers it was refused and goes on by itself.
  const dialogsAllowed = useDialogsAllowed();
  useEffect(
    () =>
      onDependencyLoaded((dependency) => {
        if (dependency.project_id && dependency.lifecycle && dependency.lifecycle.state !== 'ready') {
          openProjectLoad({
            projectId: dependency.project_id,
            projectName: dependency.label || dependency.name,
            initial: dependency.lifecycle,
          });
        }
      }),
    [],
  );
  return open && payload ? (
    <ProjectLoadDialog key={payload.projectId} {...payload} hidden={!dialogsAllowed} onClose={() => setOpen(false)} />
  ) : null;
}

function ProjectLoadDialog({
  projectId,
  projectName,
  initial,
  hidden,
  onClose,
}: ProjectLoadPayload & { hidden: boolean; onClose: () => void }) {
  const { t } = useLingui();
  // The question was asked about one app when the verdict names one: the approval is for that app too.
  const load = useProjectLoad(projectId, initial, '', true, initial.asset ?? '');
  const state = load.result?.state;
  const fix = useSetupFix(projectId, load.result, load.error, (approved) => load.load(approved));
  const needsSetup = state === 'setup_required';
  // Refused because the first-run wizard is not done: a wait with a way on, begun again once it is.
  const gate = useFirstRunGate();
  const blocked = load.result?.blocked === FIRST_RUN_BLOCKED;
  useFirstRunResume(blocked, gate, () => void load.load(true));
  // Set up and ready: there is nothing left to say. Only a run this dialog watched closes it.
  const watched = useRef(false);
  if (state === 'running') watched.current = true;
  useEffect(() => {
    if (state === 'ready' && watched.current) onClose();
  }, [state, onClose]);
  // The backend dropped the verdict this question was asked from (what it was checked against changed).
  // Ask again — a check, never an approval — and close if the question is no longer true.
  const { result, load: check } = load;
  useEffect(() => {
    if (result !== null) return;
    void check().then((next) => next?.state === 'ready' && onClose());
  }, [result, check, onClose]);
  return (
    <Dialog
      open={!hidden}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-testid="project-load-dialog" className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{needsSetup ? t`${projectName} requires setup` : projectName}</DialogTitle>
          <DialogDescription>{load.result?.detail || t`Preparing this project for use.`}</DialogDescription>
        </DialogHeader>
        {load.error && (
          <p role="alert" className="text-sm text-destructive">
            {load.error}
          </p>
        )}
        {blocked && <FirstRunWaiting />}
        {load.questionId && <AskForm questionId={load.questionId} showOp={false} onSettled={load.settleQuestion} />}
        {/* Before Set up: what it would do, one level deep. */}
        {!load.questionId && <SetupTreeView tree={load.tree} hideRoot={needsSetup} overview={needsSetup} />}
        {(load.starting || state === 'running') && (
          <p role="status">
            <Trans>Preparing…</Trans>
          </p>
        )}
        {fix.show ? (
          <SetupFailureActions
            fix={fix}
            busy={load.starting}
            onCancel={onClose}
          />
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {needsSetup ? t`Not now` : t`Close`}
            </Button>
            {needsSetup && (
              <Button disabled={load.starting} onClick={() => void load.load(true)}>
                <Trans>Set up</Trans>
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

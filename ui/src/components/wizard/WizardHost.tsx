import { t } from '@lingui/core/macro';
import {
  AgenticProcess,
  awaitWizardResult,
  completeWizard,
  ProcessKind,
  setWizardLauncher,
  type WizardLaunchRequest,
  type WizardProcessResult,
} from '@sdk';
import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { notify } from '@src/notifications/notify';
import { useEffect, useRef, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { startWizardProcess } from './start-wizard-process';
import { setWizardModalAttach } from './wizard-modal';

interface ActiveWizard {
  request: WizardLaunchRequest;
  process: AgenticProcess;
  target: string;
  resolve: (result: WizardProcessResult<unknown>) => void;
}

export function WizardHost() {
  const [active, setActive] = useState<ActiveWizard | null>(null);
  const activeRef = useRef<ActiveWizard | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Modal launcher — the double-click-from-idle path (`launchWizard`). Creates a
  // fresh wizard process and shows its live session in the modal.
  useEffect(() => {
    const restoreLauncher = setWizardLauncher(
      async <T,>(request: WizardLaunchRequest): Promise<WizardProcessResult<T>> => {
        if (activeRef.current) {
          return { status: 'error', data: null, errorStr: 'Another wizard is already open' };
        }
        try {
          const { process, target, result } = await startWizardProcess<T>(request);
          return await new Promise<WizardProcessResult<T>>((resolve) => {
            const finish = (r: WizardProcessResult<unknown>) => {
              setActive((current) => (current?.process.id === process.id ? null : current));
              resolve(r as WizardProcessResult<T>);
            };
            setActive({ request, process, target, resolve: finish });
            void result.then(finish);
          });
        } catch (err) {
          return {
            status: 'error',
            data: null,
            errorStr: err instanceof Error ? err.message : String(err),
          };
        }
      },
    );

    return () => {
      restoreLauncher();
    };
  }, []);

  // Attach path — a running headless wizard (started by a WizardButton) asks to
  // be surfaced in the modal (double-click while running). We mount the viewer
  // on the existing process; the button keeps awaiting the result independently.
  // Auto-close the modal when the agent self-closes, matching the launcher path.
  useEffect(() => {
    const restore = setWizardModalAttach(({ process, target, request }) => {
      if (activeRef.current) return; // one modal at a time
      setActive({
        request,
        process,
        target,
        resolve: () => setActive((c) => (c?.process.id === process.id ? null : c)),
      });
      void awaitWizardResult(process).then(() => {
        setActive((c) => (c?.process.id === process.id ? null : c));
      });
    });
    return () => {
      restore();
    };
  }, []);

  const closeWith = async (status: 'done' | 'cancel') => {
    if (!active) return;
    try {
      await completeWizard(active.process, { status, data: null, errorStr: null });
    } catch (err) {
      notify.error({ title: t`Wizard close failed`, message: err instanceof Error ? err.message : String(err) });
      active.resolve({ status: 'error', data: null, errorStr: err instanceof Error ? err.message : String(err) });
      setActive(null);
    }
  };

  // Dismiss the modal when the work is finished, for EVERY wizard.
  //
  // The signal is the process entity's own `busy` (`is_turn_busy`) going false
  // after a turn actually ran — nothing wizard-specific, and nothing each agent
  // has to be told to do in prose. An agent that finishes and stops is the
  // overwhelmingly common case, and leaving its transcript on screen made the
  // user dismiss a window that had nothing left to say; worse, the only button
  // offered was `Done`, which REPORTS SUCCESS to the caller — so a click while
  // the agent was still mid-run resolved the wizard with a result it had not
  // reached yet.
  //
  // Dismissing is not killing: `wizard.close` resolves the caller's promise and
  // unmounts the modal, but the AgenticProcess is a normal entity that stays
  // alive and reachable, so an agent that ended its turn to ASK something is
  // still there to answer. That is what makes settling a safe trigger.
  useEffect(() => {
    if (!active) return;
    const { process } = active;
    // A turn must have started before its end can mean anything: a wizard is
    // mounted before the worker's first turn, when `busy` is legitimately false.
    let turnStarted = process.busy;
    const unsubscribe = process.on('state_change', (change: { field?: string; newValue?: unknown }) => {
      if (change?.field !== 'busy') return;
      if (change.newValue === true) {
        turnStarted = true;
        return;
      }
      if (turnStarted) void closeWith('done');
    });
    return unsubscribe;
    // `closeWith` closes over `active`, which is this effect's only dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return (
    <Dialog
      open={!!active}
      onOpenChange={(open) => {
        if (!open) void closeWith('cancel');
      }}
    >
      {/* A wizard hosts a LIVE agent session, so a stray Esc or a click on the
          backdrop would tear it down mid-run and lose the transcript. Dismiss is
          therefore explicit only: the X, Cancel, or Done. */}
      <DialogContent
        className="flex h-[min(780px,calc(100vh-4rem))] max-w-4xl flex-col p-0"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-sm">
            {active?.request.wizardData?.title || active?.request.wizardName || <Trans>Wizard</Trans>}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {active && (
            <EntityExecutionPanel
              target={active.target}
              processType={ProcessKind.Wizard}
              initialProcessId={active.process.id}
              dense
              emptyStateText="The wizard is starting."
              placeholder="Message the setup wizard..."
            />
          )}
        </div>
        <DialogFooter className="border-t px-4 py-3">
          <Button variant="ghost" onClick={() => void closeWith('cancel')}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void closeWith('done')}>
            <Trans>Done</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

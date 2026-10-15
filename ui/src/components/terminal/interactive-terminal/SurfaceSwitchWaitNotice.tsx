import { AgenticProcess, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useLingui } from '@lingui/react/macro';
import { Hourglass } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { notify } from '@src/notifications/notify';
import { useSurfaceSwitchWait } from './use-process-surface';

/**
 * Says why a session has not switched to chat/vibe yet. Chat/vibe and the
 * terminal are mutually exclusive, so the switch kills the PTY — and while the
 * agent is mid-turn, or background work it launched still runs there, that
 * would kill the work with it. `useProcessSurface` holds the switch back and the
 * terminal stays on screen; without this line the user's click looks ignored.
 *
 * The other direction has a way out. A chat worker the agent left background work
 * running in (`background_work`) can never hand that work to a terminal — the work
 * belongs to its process — so waiting for it can take forever (a dev server never
 * finishes). The notice then offers the switch anyway, behind a confirmation that
 * says the work ends: it stops the work, and the surface's own retry completes the switch.
 */
export function SurfaceSwitchWaitNotice({ processId }: { processId: string | null | undefined }) {
  const { t } = useLingui();
  const wait = useSurfaceSwitchWait(processId);
  const typeId = useMemo(() => (processId ? new TypeId(AgenticProcess.type, processId) : null), [processId]);
  const { data: process } = useEntity<AgenticProcess>(typeId, { watch: true });
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  // `switching` is a request in flight — too brief to explain.
  if (!wait || wait === 'switching') return null;
  const canEndBackgroundWork = wait === 'background' && !!process?.background_work;

  const endWorkAndSwitch = async () => {
    setStopping(true);
    try {
      await process?.stopBackground();
    } catch (err) {
      console.error('[SurfaceSwitchWaitNotice] stopping background work failed', err);
      notify.error({ title: t`Could not stop`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setStopping(false);
    }
  };

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b bg-background px-4 py-2 text-[13px] text-foreground"
      data-testid="surface-switch-wait-notice"
      data-wait={wait}
    >
      <Hourglass className="h-4 w-4 flex-shrink-0 animate-pulse text-amber-400" />
      <span className="min-w-0 flex-1">
        {canEndBackgroundWork
          ? t`The agent has background work running. It cannot move to the terminal with you.`
          : wait === 'background'
            ? t`Background tasks are still running. The session will switch over as soon as they finish.`
            : t`The agent is still working, or waiting for your answer in the terminal. The session will switch over as soon as it finishes.`}
      </span>
      {canEndBackgroundWork && (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={stopping}
            onClick={() => setConfirming(true)}
            data-testid="surface-switch-end-background"
          >
            {t`Switch anyway`}
          </Button>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={t`Switch to the terminal?`}
            description={t`Switching to the terminal will end the background work. Continue?`}
            confirmLabel={t`Switch and end background work`}
            cancelLabel={t`Cancel`}
            variant="destructive"
            onConfirm={() => void endWorkAndSwitch()}
          />
        </>
      )}
    </div>
  );
}

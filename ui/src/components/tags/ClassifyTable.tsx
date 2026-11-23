import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { Conversation, FlowMessage, TypeId } from '@sdk';
import type { ClassificationRun } from '@sdk/entities/flow-message';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { SourceChip, useChannelAttribution } from '@src/components/conversation/channel-attribution';
import { formatTimeAgo } from '@src/components/project-activity-strip/project-activity-utils';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { AUTOMATIONS_CHANNEL } from '@src/components/stream-inbox-view/channel-owner';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';

/** How often a run still at work is read again. */
const READ_EVERY_MS = 2000;

/** A classification run lives in the URL (`classify=<call id>`): started here, reopened by a reload, closed
 *  by dropping the option. The run itself is durable — closing the table does not stop it. */
export function useClassifyRun() {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const set = (callId: string | null) => currentDock && navigation.openDock(currentDock.withOption('classify', callId));
  return {
    callId: currentDock?.options?.classify || null,
    start: (conversations: string[]) => {
      void FlowMessage.classifyConversations(conversations).then(
        (run) => set(run.call_id),
        (e: unknown) =>
          notify.error({
            title: t`Could not start the classification`,
            message: errorMessage(e, t`It did not work`),
            forceToast: true,
          }),
      );
    },
    close: () => set(null),
  };
}

/**
 * A classification run in progress. Nobody waits here: the run posts its proposal as the classifier automation's
 * message, where it is reviewed and applied (the review nano-app), so this window only says so and can be closed.
 * The run's one line and, behind Details, the conversations being read are for someone who chooses to watch;
 * the window closes itself when the message has been posted.
 */
export function ClassifyDialog({ callId, onClose }: { callId: string; onClose: () => void }) {
  const { t } = useLingui();
  const { attributionFor } = useChannelAttribution();
  const { data: run, error: readError } = useQuery<ClassificationRun>({
    queryKey: ['tags', 'classification-run', callId],
    queryFn: () => FlowMessage.classificationRun(callId),
    retry: false,
    // Read again while it is at work; a run that cannot be read (a stale id in the URL) is not asked again.
    refetchInterval: ({ state }) =>
      state.status !== 'error' && (!state.data || state.data.state === 'running') ? READ_EVERY_MS : false,
  });
  const [details, setDetails] = useState(false);
  // The Automations chip as an inbox row wears it: the channel's name, the automation type's own icon.
  const channel = attributionFor({ kind: AUTOMATIONS_CHANNEL, namespace: '', key: '', url: null });
  const automations = channel && { ...channel, icon: iconForType('trigger') };
  const asked = (run?.input as { conversations?: string[] } | null | undefined)?.conversations ?? [];
  const handedIn = run?.state === 'completed' && run.result?.exit_code === 0 && !!run.result.value;
  // The proposal is in the automation's conversation now: there is nothing left to say here.
  useEffect(() => {
    if (handedIn) onClose();
  }, [handedIn]); // eslint-disable-line react-hooks/exhaustive-deps
  const failure =
    readError || (run && run.state !== 'running' && !handedIn)
      ? errorMessage(readError, run?.error || run?.result?.detail || t`The classification did not finish.`)
      : null;
  const started = run?.created_at ? formatTimeAgo(run.created_at) : '';

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-5xl" data-testid="classify-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Classify {asked.length} conversations</Trans>
          </DialogTitle>
          <DialogDescription asChild>
            <div className="text-sm text-muted-foreground" data-testid="classify-notice">
              <Trans>
                Classification is in progress. An{' '}
                <SourceChip attribution={automations} className="mx-0.5" />{' '}
                message will be sent once it is done. You can close this window.
              </Trans>
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-border">
          <div
            className={cn('flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground', details && 'border-b border-border')}
            data-testid="classify-run-line"
          >
            {!failure && <Loader2 className="size-3 animate-spin" />}
            <span className="font-medium text-foreground">{run?.block ?? 'stream-inbox-classifier'}</span>
            <span>
              {failure ? <Trans>Stopped</Trans> : <Trans>Running</Trans>} · <Trans>{asked.length} conversations</Trans>
              {started && (
                <>
                  {' · '}
                  <Trans>started {started}</Trans>
                </>
              )}
            </span>
            <Button
              variant="outline"
              size="sm"
              className={cn('ms-auto h-6', details && 'bg-accent')}
              onClick={() => setDetails(!details)}
              data-testid="classify-details"
            >
              <Trans>Details</Trans>
            </Button>
          </div>
          {details && (
            <div className="max-h-[60vh] overflow-auto">
              <Table data-testid="classify-table">
                <TableHeader>
                  <TableRow className="text-xs hover:bg-transparent">
                    <TableHead className="h-9 px-3">
                      <Trans>Conversation</Trans>
                    </TableHead>
                    <TableHead className="h-9 px-3">
                      <Trans>Current</Trans>
                    </TableHead>
                    <TableHead className="h-9 px-3">
                      <Trans>Proposed</Trans>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {asked.map((id) => (
                    <WaitingRow key={id} id={id} failed={!!failure} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
        {failure && (
          <p role="alert" className="text-xs text-destructive" data-testid="classify-error">
            {failure}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground" data-testid="classify-summary">
            {!failure && <Trans>Agents are reading — closing keeps it running</Trans>}
          </span>
          <Button variant="outline" size="sm" onClick={onClose} data-testid="classify-close">
            <Trans>Close</Trans>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A conversation an agent is still reading. */
function WaitingRow({ id, failed }: { id: string; failed: boolean }) {
  const conversation = useEntity<Conversation>(new TypeId(Conversation.type, id)).data;
  return (
    <TableRow data-testid={`classify-row-${id}`}>
      <TableCell className="max-w-md px-3">
        <div className="truncate font-semibold">{conversation?.title || '…'}</div>
      </TableCell>
      <TableCell className="px-3" />
      <TableCell className="px-3">
        {!failed && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            <Trans>Classifying…</Trans>
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

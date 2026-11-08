import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Plus } from 'lucide-react';
import type { HelpOrigin, TypeId } from '@sdk';
import { FlowIcon } from '@sdk/react/FlowIcon';
import { chromeEntityActionClassName } from '@src/components/entity-actions/action-button-styles';
import { NavBadge } from '@src/components/ui/nav-badge';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useMyVibeTasks, type VibeTaskRow } from '@src/hooks/use-my-vibe-tasks';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { AskForHelpDialog } from './AskForHelpDialog';
import { HelpRequestList, useHelpRequests } from './MyHelpRequests';
import { useUiActionRequest } from '@src/navigation/ui-actions';

/**
 * "Count me in" — the app's SINGLE get-help affordance, in the top bar, marked by
 * the raised-hand figure (the collaborate glyph this replaces; there is no
 * second button beside it). One click, one simple dialog: it creates a TASK,
 * assigns it (so the work lands on the other person's board), and sends them a
 * message carrying the issue plus the task chips and the session transcript.
 *
 * It is also the CURRENT TASK button: while help tasks I opened in this
 * project are still open, a click lists them — each opens the conversation it was
 * asked in — with "New request" beside them, and the icon counts the messages
 * waiting across them. Open desk tickets are listed with them: they have no task, so they come
 * from `helpRequests()`, read again when the list or the dialog opens or closes.
 */
export function AskForHelpButton({
  projectId,
  sessionTypeId,
  origin,
}: {
  projectId: string | null;
  /** The session on screen — what the diagnostic says the person was in. */
  sessionTypeId: TypeId | null;
  /** Where the ask is made from. */
  origin: HelpOrigin;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { rows, unread } = useMyVibeTasks(projectId);
  const [listOpen, setListOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const requests = useHelpRequests(`${listOpen}:${dialogOpen}`);
  const tickets = requests.filter((row) => row.kind === 'desk' && row.status === 'open');
  const hasList = rows.length + tickets.length > 0;
  // "ask someone for help" (smart navigation): the same dialog the button opens.
  useUiActionRequest(['ask-for-help-dialog'], () => setDialogOpen(true));

  const button = (
    <button
      type="button"
      onClick={hasList ? undefined : () => setDialogOpen(true)}
      title={hasList ? t`Your help requests` : t`Ask someone for help`}
      className={cn(chromeEntityActionClassName, 'relative', hasList && 'text-primary')}
      data-testid="vibe-assign-task"
      data-open-tasks={rows.length}
    >
      <FlowIcon icon="flowpad.person-raised-hand" className="h-3.5 w-3.5" />
      <NavBadge count={unread + tickets.reduce((sum, row) => sum + row.unread, 0)} className="-end-1.5 -top-1.5" />
    </button>
  );

  // URL-first: a row only navigates; the conversation's loader and view do the rest.
  const openRow = (row: VibeTaskRow) => {
    setListOpen(false);
    navigation.openDock(
      row.conversationId
        ? DockPointer.forConversation(row.conversationId)
        : DockPointer.forAssetEditorByTypeId('task', row.task.typeId),
    );
  };

  return (
    <>
      {hasList ? (
        <Popover open={listOpen} onOpenChange={setListOpen}>
          <PopoverTrigger asChild>{button}</PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-1" data-testid="vibe-help-tasks">
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              <Trans>Your help requests</Trans>
            </div>
            {rows.map((row) => (
              <button
                key={row.task.id}
                type="button"
                onClick={() => openRow(row)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-accent"
                data-testid={`vibe-help-task-${row.task.id}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{row.task.title || t`Untitled request`}</span>
                  {row.task.assignee && (
                    <span className="block truncate text-xs text-muted-foreground">{row.task.assignee}</span>
                  )}
                </span>
                <NavBadge
                  count={row.unread}
                  className="static shrink-0"
                  testId={`vibe-help-task-unread-${row.task.id}`}
                />
              </button>
            ))}
            <HelpRequestList
              rows={tickets}
              onOpen={(row) => {
                setListOpen(false);
                navigation.openDock(DockPointer.forConversation(row.conversation_id));
              }}
            />
            <div className="my-1 border-t" />
            <button
              type="button"
              onClick={() => {
                setListOpen(false);
                setDialogOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
              data-testid="vibe-help-new"
            >
              <Plus className="h-3.5 w-3.5" />
              <Trans>New request</Trans>
            </button>
          </PopoverContent>
        </Popover>
      ) : (
        button
      )}

      {dialogOpen && (
        <AskForHelpDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          projectId={projectId}
          sessionTypeId={sessionTypeId}
          origin={origin}
          openTasks={rows}
          onOpenExisting={(row) => {
            setDialogOpen(false);
            openRow(row);
          }}
        />
      )}
    </>
  );
}

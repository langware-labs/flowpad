import { useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { ConversationPanel } from './ConversationPanel';
import { useConversation } from './useConversation';

/**
 * Top-level renderer for the `/dock/conversation/<id>` route.
 *
 * Loads the Conversation + parent Task and embeds the same `ConversationPanel`
 * that task views use, with a thin header (back arrow + subject). Drop-in
 * landing target for inbox clicks and the email "view task" deep-link.
 *
 * Self-contained pointer resolution — matches the convention used by every
 * other dock tab (TasksViewer, LensViewer, SessionViewer, …): read
 * `currentDock` directly, parse the pointer's first segment as the entity id,
 * and treat anything else as "no entity". Safe against the all-tabs-mounted
 * issue where a hidden tab would otherwise see another route's pointer.
 */
export function ConversationRoute() {
  const { navigation, currentDock } = useDockNavigation();

  // Take only the first path segment as the conversation id. Hidden tabs see
  // pointers from whatever route is currently active (e.g. project's
  // `<projId>/conversation/<convId>`); we ignore everything past the first
  // slash so we never feed a multi-segment string into useConversation.
  const conversationId = useMemo(() => {
    const pointer = currentDock?.pointer;
    if (!pointer) return null;
    const head = pointer.split('/')[0];
    return head || null;
  }, [currentDock?.pointer]);

  const { conversation, task, senderName, taskMissing } = useConversation(conversationId);

  const goBack = () => navigation.openDock(DockPointer.forInbox());

  if (!conversationId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No conversation specified.
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading conversation…
      </div>
    );
  }

  // Task is optional: project-scoped conversations don't have one. Only block
  // on "loading task" when the conversation references a task that hasn't
  // materialised locally yet.
  if (taskMissing) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading task context…
      </div>
    );
  }

  const subject = task?.title?.trim() || 'Conversation';

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <button
          type="button"
          onClick={goBack}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Back to inbox"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="truncate text-sm font-semibold">{subject}</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <ConversationPanel
          task={task}
          conversationId={conversationId}
          senderName={senderName}
        />
      </div>
    </div>
  );
}

import { ArrowLeft } from 'lucide-react';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { ConversationPanel } from './ConversationPanel';
import { useConversation } from './useConversation';

interface ConversationRouteProps {
  /** Conversation id from the dock URL (`/dock/conversation/:id`). */
  conversationId: string | null;
}

/**
 * Top-level renderer for the `/dock/conversation/<id>` route.
 *
 * Loads the Conversation + parent Task and embeds the same `ConversationPanel`
 * that task views use, with a thin header (back arrow + subject). Drop-in
 * landing target for inbox clicks and the email "view task" deep-link.
 */
export function ConversationRoute({ conversationId }: ConversationRouteProps) {
  const { navigation } = useDockNavigation();
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

  if (taskMissing || !task) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading task context…
      </div>
    );
  }

  const subject = task.title?.trim() || 'Conversation';

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

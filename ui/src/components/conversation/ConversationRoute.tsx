import { useCallback, useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Conversation, TypeId } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { LoginRequiredOverlay } from '@src/components/login-required-overlay';
import { ConversationPanel, EditableConversationTitle } from './ConversationPanel';
import { MembersAvatarStack } from './MembersAvatarStack';
import { useConversation } from './useConversation';

/**
 * Top-level renderer for the `/dock/conversation/<id>` route.
 *
 * Loads the Conversation + parent Task and embeds the same `ConversationPanel`
 * that task views use, with a thin header (back arrow + subject). Drop-in
 * landing target for inbox clicks and the email "view task" deep-link.
 *
 * Self-contained pointer resolution — matches the convention used by every
 * other dock tab (TasksViewer, LensViewer, …): read
 * `currentDock` directly, parse the pointer's first segment as the entity id,
 * and treat anything else as "no entity". Safe against the all-tabs-mounted
 * issue where a hidden tab would otherwise see another route's pointer.
 */
export function ConversationRoute() {
  const { navigation, currentDock } = useDockNavigation();
  const { cloudUser } = useAuth();

  // Hidden tabs are kept mounted by Radix Tabs (data-[state=inactive]:hidden),
  // so when the URL points at a different view this component still re-renders
  // — and currentDock.pointer is whatever the *active* tab's pointer is (e.g.
  // an agentic_process or shell id). Bail unless the dock is actually pointing
  // at a conversation; otherwise we'd feed a foreign id into useConversation
  // and TypeId would throw "Invalid type-id: conversation, agentic_process-…".
  const { conversationId, messageId } = useMemo(() => {
    if (currentDock?.viewType !== ViewType.CONVERSATION) {
      return { conversationId: null, messageId: null };
    }
    // Pointer grammar: <conversationId>[/message/<messageId>]. The message
    // segment deep-links a specific bubble — selection + scroll derive from it.
    return DockPointer.parseConversationPointer(currentDock?.pointer);
  }, [currentDock?.viewType, currentDock?.pointer]);

  const { conversation, task, senderName, taskMissing } = useConversation(conversationId);

  // Stable TypeId for the members stack — useMembers' fetch effect depends on
  // the typeid by reference, so an inline `new TypeId(...)` would re-arm it on
  // every render.
  const convTypeId = useMemo(
    () => (conversationId ? new TypeId(Conversation.type, conversationId) : null),
    [conversationId],
  );

  // URL-first message selection: a bubble click only navigates — the URL
  // change flows back down as `selectedMessageId`, which drives the
  // highlight + scroll-into-view (no optimistic local selection writes).
  const handleMessageNavigate = useCallback(
    (id: string) => {
      if (!conversationId) return;
      navigation.openDock(DockPointer.forConversation(conversationId, { messageId: id }));
    },
    [navigation, conversationId],
  );

  const goBack = () => navigation.openDock(DockPointer.forInbox());

  if (!conversationId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No conversation specified.
      </div>
    );
  }

  // Thin header (back arrow + subject) shared by the logged-out and loaded
  // states so the back affordance + styling stay in one place. The subject is
  // the conversation's own click-to-rename title (same component as the panel
  // header) — a rename here saves with Hub-Reflect and fans out to every
  // member. Task displayName is only the fallback for untitled conversations.
  const header = (
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
      <button
        type="button"
        onClick={goBack}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Back to inbox"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <EditableConversationTitle
        conv={conversation ?? null}
        fallback={task?.displayName ?? 'Conversation'}
        className="min-w-0 flex-1 truncate text-sm font-semibold"
      />
      {/* Roster fetch is pointless under the logged-out overlay — skip it. */}
      {cloudUser && convTypeId && <MembersAvatarStack typeId={convTypeId} />}
    </div>
  );

  // Logged out → don't get stuck on "Loading conversation…" (the hub fetch
  // 401s and never resolves). Show the standard chrome with a Login CTA
  // overlay instead, regardless of whether the conversation is cached locally.
  if (!cloudUser) {
    return (
      <div className="relative flex h-full flex-col">
        <LoginRequiredOverlay description="Sign in to your Flowpad Cloud account to view and reply to this conversation." />
        {header}
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

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="flex min-h-0 flex-1 flex-col">
        <ConversationPanel
          task={task}
          conversationId={conversationId}
          senderName={senderName}
          // Title + members stack live in the route header above — suppress
          // the panel's own header row so the subject isn't rendered twice.
          headerLabel={null}
          selectedMessageId={messageId}
          onMessageNavigate={handleMessageNavigate}
        />
      </div>
    </div>
  );
}

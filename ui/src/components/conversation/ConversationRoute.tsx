import { useCallback, useMemo, useState } from 'react';
import { ArrowLeft, FolderOpen, Loader2 } from 'lucide-react';
import { Conversation, Project, type Task, TypeId } from '@sdk';
import { useAuth, useProject } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { LoginRequiredOverlay } from '@src/components/login-required-overlay';
import { ProjectSelectorModal, projectListToSelectorItems } from '@src/components/project-selector';
import {
  canonicalPath,
  selectProjectContext,
  useEnsureProject,
} from '@src/components/project-selector/use-ensure-project';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { notify } from '@src/notifications';
import { ConversationPanel, EditableConversationTitle } from './ConversationPanel';
import { ConversationHeaderSession } from './ConversationHeaderSession';
import { MembersAvatarStack } from './MembersAvatarStack';
import {
  applyProjectToConversation,
  applyProjectToTask,
  persistRemoteToLocalMapping,
} from './apply-project-choice';
import { useConversation } from './useConversation';

function conversationHasPrivateProject(conversation: Conversation | null | undefined): boolean {
  if (!conversation) return false;
  if (conversation.project_id) return true;
  return (conversation.privateContextEntities ?? []).some((typeId) => typeId.type === Project.type);
}

function ConversationSetProjectButton({
  conversation,
  task,
}: {
  conversation: Conversation;
  task?: Task | null;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const { projects, isLoading } = useAllProjects({ enabled: open });
  const projectItems = useMemo(() => projectListToSelectorItems(projects), [projects]);
  const ensureProject = useEnsureProject();
  const { project: currentProject } = useProject();

  const selectedId = useMemo(() => {
    const currentPath = currentProject?.fs_storage_mount_path || currentProject?.name || '';
    return currentPath ? canonicalPath(currentPath) : null;
  }, [currentProject?.fs_storage_mount_path, currentProject?.name]);

  const handleSelect = useCallback(
    async (id: string) => {
      const picked = projectItems.find((item) => item.id === id);
      if (!picked?.path || !conversation.id || saving) return;
      setSaving(true);
      try {
        const project = await ensureProject(picked.path, { select: false });
        const selectedProjectId = project.id ?? null;
        const existingProjectId = task?.project_id ?? conversation.project_id ?? null;

        const result = task?.id
          ? await applyProjectToTask(task.id, project)
          : await applyProjectToConversation(conversation.id, project);
        if (!result.saved && (!selectedProjectId || existingProjectId !== selectedProjectId)) {
          throw new Error('Project selection did not persist');
        }

        await persistRemoteToLocalMapping(conversation.remote_project_id, project.id);
        await selectProjectContext(project);
        notify.success({ title: 'Conversation project set', message: project.displayName });
      } catch (err) {
        console.error('[conversation] set project failed', err);
        notify.error({ title: 'Failed to set project' });
      } finally {
        setSaving(false);
      }
    },
    [
      conversation.id,
      conversation.project_id,
      conversation.remote_project_id,
      ensureProject,
      projectItems,
      saving,
      task?.id,
      task?.project_id,
    ],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={saving}
        title="Set conversation project"
        className="inline-flex h-7 items-center gap-1.5 rounded border border-dashed border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
        <span>Set project</span>
      </button>
      <ProjectSelectorModal
        open={open}
        onOpenChange={setOpen}
        projects={projectItems}
        selectedId={selectedId}
        onSelect={(id) => void handleSelect(id)}
        isLoading={isLoading}
        title="Set project"
      />
    </>
  );
}

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
  // member. Untitled conversations fall back to the generic "Conversation".
  const header = (
    <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
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
          fallback="Conversation"
          className="min-w-0 flex-1 truncate text-sm font-semibold"
        />
      </div>
      <div className="flex justify-center">
        {conversation && !conversationHasPrivateProject(conversation) && (
          <ConversationSetProjectButton conversation={conversation} task={task} />
        )}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-2">
        {/* Open-the-session / launch-a-worker — the conversation always shows
            exactly one of the two (never neither). Logged-out skips it. */}
        {cloudUser && conversation && (
          <ConversationHeaderSession conversation={conversation} task={task} />
        )}
        {/* Roster fetch is pointless under the logged-out overlay — skip it. */}
        {cloudUser && convTypeId && <MembersAvatarStack typeId={convTypeId} />}
      </div>
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

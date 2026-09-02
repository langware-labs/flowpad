import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, FolderOpen, Loader2 } from 'lucide-react';
import { Agent, Conversation, Project, type Task, TypeId } from '@sdk';
import { useAuth, useProject } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
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
import { Button } from '@src/components/ui/button';
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
  const { t } = useLingui();
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
        notify.success({ title: t`Conversation project set`, message: project.displayName });
      } catch (err) {
        console.error('[conversation] set project failed', err);
        notify.error({ title: t`Failed to set project` });
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
      t,
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
        title={t`Set conversation project`}
        className="inline-flex h-7 items-center gap-1.5 rounded border border-dashed border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
        <span><Trans>Set project</Trans></span>
      </button>
      <ProjectSelectorModal
        open={open}
        onOpenChange={setOpen}
        projects={projectItems}
        selectedId={selectedId}
        onSelect={(id) => void handleSelect(id)}
        isLoading={isLoading}
        title={t`Set project`}
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
  const { t } = useLingui();
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

  // Which thread the feed is filtered to. OPTIONS, not the pointer — so the
  // filter is linkable and reload-safe without minting a second tab.
  const threadId =
    currentDock?.viewType === ViewType.CONVERSATION ? (currentDock.threadId ?? null) : null;
  const agentId = currentDock?.viewType === ViewType.CONVERSATION ? currentDock.agentScopeId : null;

  const scopeKey = agentId && conversationId ? `${agentId}:${conversationId}` : null;
  const [scopeDecision, setScopeDecision] = useState<{ key: string; allowed: boolean | null } | null>(null);
  const scopeAllowed = !scopeKey ? true : scopeDecision?.key === scopeKey ? scopeDecision.allowed : null;
  useEffect(() => {
    let live = true;
    if (!agentId || !conversationId || !scopeKey) return;
    setScopeDecision({ key: scopeKey, allowed: null });
    let scopedAgent: Agent;
    try {
      scopedAgent = new Agent({ id: agentId });
    } catch {
      setScopeDecision({ key: scopeKey, allowed: false });
      return;
    }
    void scopedAgent
      .inboxScope()
      .then((scope) => {
        if (live) setScopeDecision({ key: scopeKey, allowed: scope.conversation_ids.includes(conversationId) });
      })
      .catch(() => {
        if (live) setScopeDecision({ key: scopeKey, allowed: false });
      });
    return () => {
      live = false;
    };
  }, [agentId, conversationId, scopeKey]);

  const { conversation, task, senderName, taskMissing } = useConversation(scopeAllowed ? conversationId : null);

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
      navigation.openDock(DockPointer.forConversation(conversationId, { messageId: id, agentId }));
    },
    [navigation, conversationId, agentId],
  );

  // Opening / closing a thread is a NAVIGATION, like every other selection
  // here — the view never filters itself.
  const handleThreadNavigate = useCallback(
    (id: string | null) => {
      if (!conversationId) return;
      navigation.openDock(DockPointer.forConversation(conversationId, { thread: id, agentId }));
    },
    [navigation, conversationId, agentId],
  );

  const goBack = () => navigation.openDock(agentId ? DockPointer.forAgentInbox(agentId) : DockPointer.forInbox());

  if (!conversationId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>No conversation specified.</Trans>
      </div>
    );
  }

  if (agentId && scopeAllowed === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Loading conversation…</Trans>
      </div>
    );
  }

  if (agentId && !scopeAllowed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <Trans>This conversation is not in this Agent inbox.</Trans>
        <Button variant="outline" size="sm" onClick={goBack}>
          <ArrowLeft className="me-1.5 h-3.5 w-3.5" />
          <Trans>Back to inbox</Trans>
        </Button>
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
          title={t`Back to inbox`}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <EditableConversationTitle
          conv={conversation ?? null}
          fallback={t`Conversation`}
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
        <LoginRequiredOverlay description={t`Sign in to your Flowpad Cloud account to view and reply to this conversation.`} />
        {header}
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Loading conversation…</Trans>
      </div>
    );
  }

  // Task is optional: project-scoped conversations don't have one. Only block
  // on "loading task" when the conversation references a task that hasn't
  // materialised locally yet.
  if (taskMissing) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Loading task context…</Trans>
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
          threadId={threadId}
          onThreadNavigate={handleThreadNavigate}
          agentId={agentId}
        />
      </div>
    </div>
  );
}

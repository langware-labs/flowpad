import {
  Conversation,
  FlowMessage,
  Invitation,
  Project,
  QueryRequest,
  Task,
  TypeId,
  acceptInvitation,
  syncFromHub,
} from '@sdk';
import { uploadFlowMessage, type UploadConflict } from '@sdk/entities/flow-message';
import { useEntitiesQuery, useEntity } from '@src/hooks/entity-hooks';
import { NewConversationDialog } from '@src/components/new-conversation-dialog/NewConversationDialog';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { MailPlus, MessageSquare, Plus, RefreshCw, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { formatTimeAgo } from './project-activity-utils';

const VISIBLE_COUNT = 5;

interface RecentConversationsStripProps {
  /** Optional cap on rows visible before "Open all" appears. Defaults to 5. */
  visibleCount?: number;
}

export function RecentConversationsStrip({ visibleCount = VISIBLE_COUNT }: RecentConversationsStripProps) {
  const { navigation } = useDockNavigation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadConflicts, setUploadConflicts] = useState<UploadConflict[] | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [newConvOpen, setNewConvOpen] = useState(false);

  const request = useMemo(() => new QueryRequest({ type: Conversation.type }), []);
  const { data: conversations = [], refetch, isLoading } = useEntitiesQuery<Conversation>(request);

  // Pending invitations live as separate Invitation entities; they appear in
  // a sibling block above the conversation list. Materialized locally with
  // remote=true by `conversation-sync` after the user clicks Refresh.
  const invitationsRequest = useMemo(() => new QueryRequest({ type: Invitation.type }), []);
  const { data: invitations = [], refetch: refetchInvitations } =
    useEntitiesQuery<Invitation>(invitationsRequest);

  const pendingInvitations = useMemo(
    () => invitations.filter((inv) => !inv.accepted),
    [invitations],
  );

  const sorted = useMemo(() => {
    const list = [...conversations];
    list.sort((a, b) => {
      const ta = a.updated_date ? new Date(a.updated_date).getTime() : 0;
      const tb = b.updated_date ? new Date(b.updated_date).getTime() : 0;
      return tb - ta;
    });
    return list;
  }, [conversations]);

  const visible = sorted.slice(0, visibleCount);
  const hasMore = sorted.length > visibleCount;

  const [hubSyncing, setHubSyncing] = useState(false);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  const handleRefresh = async () => {
    setHubSyncing(true);
    try {
      // Best-effort hub sync; if the user isn't logged in to the cloud the
      // backend returns FAIL but the local refetch still works.
      try {
        await syncFromHub();
      } catch (e) {
        // ignore — hub may be unavailable / not configured
      }
      await Promise.all([refetch(), refetchInvitations()]);
    } finally {
      setHubSyncing(false);
    }
  };

  const handleAcceptInvitation = async (invId: string) => {
    setAcceptingId(invId);
    try {
      await acceptInvitation({ invitation_id: invId });
      await Promise.all([refetch(), refetchInvitations()]);
    } catch (e) {
      // surface in console; UI doesn't have a per-row error slot yet
      console.error('[RecentConversationsStrip] acceptInvitation failed', e);
    } finally {
      setAcceptingId(null);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploadError(null);
    setUploadConflicts(null);
    try {
      const result = await uploadFlowMessage(file);
      if (result.task_id) {
        navigation.openDock(DockPointer.forTasks(result.task_id));
      }
      void refetch();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number; data?: { data?: { conflicts?: UploadConflict[] } } } };
      if (axiosErr?.response?.status === 409) {
        setPendingFile(file);
        setUploadConflicts(axiosErr.response.data?.data?.conflicts ?? []);
      } else {
        const msg = err instanceof Error ? err.message : 'Upload failed.';
        setUploadError(msg);
      }
    }
  };

  const handleOverwrite = async () => {
    if (!pendingFile) return;
    setUploadError(null);
    try {
      const result = await uploadFlowMessage(pendingFile, { overwrite: true });
      setPendingFile(null);
      setUploadConflicts(null);
      if (result.task_id) {
        navigation.openDock(DockPointer.forTasks(result.task_id));
      }
      void refetch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload failed.';
      setUploadError(msg);
    }
  };

  return (
    <div className="flex flex-col rounded-lg border" data-testid="recent-conversations-strip">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Recent conversations</span>
          {sorted.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {sorted.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            accept=".flowmsg"
            className="hidden"
            onChange={(e) => void handleFileChange(e)}
          />
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => setNewConvOpen(true)}
            title="New conversation"
            data-testid="new-conversation-button"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => fileInputRef.current?.click()}
            title="Upload message"
            data-testid="upload-message-button"
          >
            <Upload className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => void handleRefresh()}
            title="Refresh (pulls from hub)"
            data-testid="refresh-conversations-button"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading || hubSyncing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {uploadError && <p className="px-3 pb-2 text-xs text-destructive">{uploadError}</p>}
      {uploadConflicts && (
        <div className="mx-3 mb-2 space-y-1 rounded-md border border-border bg-muted/40 p-2 text-xs">
          <p className="font-medium text-foreground">Entities already exist:</p>
          <p className="text-muted-foreground">{uploadConflicts.map((c) => `${c.type}:${c.id}`).join(', ')}</p>
          <div className="flex gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={() => void handleOverwrite()}
              className="rounded bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
            >
              Overwrite
            </button>
            <button
              type="button"
              onClick={() => { setPendingFile(null); setUploadConflicts(null); }}
              className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Pending invitations */}
      {pendingInvitations.length > 0 && (
        <div className="border-b border-border/50 pb-2 pt-1" data-testid="pending-invitations">
          <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Pending invitations
          </div>
          {pendingInvitations.map((inv) => (
            <div
              key={inv.id}
              className="flex items-start gap-2 px-3 py-1.5 hover:bg-muted/40"
              data-testid="pending-invitation-row"
            >
              <MailPlus className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-violet-500" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">
                  {inv.recipient_email || 'Invitation'}
                </div>
                {inv.message && (
                  <div className="truncate text-[11px] text-muted-foreground">
                    {inv.message}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => inv.id && void handleAcceptInvitation(inv.id)}
                disabled={acceptingId === inv.id}
                className="rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                data-testid="accept-invitation-button"
              >
                {acceptingId === inv.id ? 'Accepting…' : 'Accept'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* List */}
      <div className="pb-1">
        {visible.length === 0 ? (
          <div className="px-3 pb-3 text-xs text-muted-foreground">No conversations</div>
        ) : (
          visible.map((conv) => <ConversationRow key={conv.id} conv={conv} />)
        )}
      </div>

      {hasMore && (
        <button
          type="button"
          className="border-t px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => navigation.openDock(DockPointer.forInbox())}
          data-testid="open-all-conversations"
        >
          Open all ({sorted.length})
        </button>
      )}

      <NewConversationDialog
        open={newConvOpen}
        onClose={() => {
          setNewConvOpen(false);
          void refetch();
        }}
      />
    </div>
  );
}

function ConversationRow({ conv }: { conv: Conversation }) {
  const { navigation } = useDockNavigation();
  const projectTypeId = useMemo(
    () => (conv.project_id ? new TypeId(Project.type, conv.project_id) : null),
    [conv.project_id],
  );
  const { data: project } = useEntity<Project>(projectTypeId);

  const taskTypeId = useMemo(
    () => conv.firstContextOfType?.('task') ?? null,
    [conv],
  );
  const { data: task } = useEntity<Task>(taskTypeId);

  // Latest message pointer is the last entry; fetch the FlowMessage for its text snippet.
  const latestMessageTypeId = useMemo(() => {
    const pointers = conv.conversationMessageIds ?? [];
    const last = pointers[pointers.length - 1];
    return last ? new TypeId(FlowMessage.type, last.id) : null;
  }, [conv.message_ids]);
  const { data: latestMessage } = useEntity<FlowMessage>(latestMessageTypeId);

  const title = taskTypeId ? `Task ${taskTypeId.id.slice(0, 8)}` : 'Conversation';
  const messageCount = conv.message_count ?? 0;
  const projectLabel = project?.displayName ?? null;
  const taskTitle = task?.title?.trim() || null;
  const taskFirstWord = taskTitle ? taskTitle.split(/\s+/)[0] : null;
  const previewText = latestMessage?.text?.trim().split('\n').find((l) => l.trim()) ?? null;
  const fromName = latestMessage?.sender_name?.trim() || null;

  const handleClick = () => {
    navigation.openDock(conv.dockPointer);
  };

  return (
    <div
      className="group flex cursor-pointer items-start justify-between gap-2 px-3 py-1.5 hover:bg-muted/50"
      onClick={handleClick}
      data-testid="conversation-row"
      data-conversation-id={conv.id}
      data-project-id={conv.project_id ?? ''}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-1.5">
          <span className="truncate text-xs font-medium" data-testid="conversation-from">
            {fromName ?? title}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {projectLabel && (
              <span
                className="inline-flex shrink-0 items-center rounded-md border border-primary/30 bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                data-testid="project-chip"
                data-chip-type="project"
                title={`Project: ${projectLabel}`}
              >
                {projectLabel}
              </span>
            )}
            {taskFirstWord && (
              <span
                className="inline-flex shrink-0 items-center rounded-md border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                data-testid="task-chip"
                data-chip-type="task"
                title={`Task: ${taskTitle ?? taskFirstWord}`}
              >
                {taskFirstWord}
              </span>
            )}
          </div>
        </div>
        {previewText && (
          <div
            className="mt-0.5 truncate text-[11px] text-muted-foreground"
            data-testid="conversation-preview"
          >
            {previewText}
          </div>
        )}
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>{formatTimeAgo(conv.updated_date)}</span>
          {messageCount > 0 && <span>· {messageCount} msg{messageCount === 1 ? '' : 's'}</span>}
        </div>
      </div>
    </div>
  );
}

export default RecentConversationsStrip;

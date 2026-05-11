/**
 * SharedTaskView — Full-screen task view for shared (notification) tasks.
 *
 * Shown when recipient opens a task that was shared via cross-user notification.
 * Replaces the sliding TaskDetailPanel for spec_id tasks.
 */

import { useState } from 'react';
import { ArrowLeft, Activity } from 'lucide-react';
import { Spec, Task, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ExpansionRequest } from '@sdk/FlowSync/query';
import { sendReply } from '@sdk/entities/notifications';
import { toast } from 'sonner';
import { ConversationPanel } from '@src/components/conversation/ConversationPanel';
import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';

const STATUS_REQUEST_PROMPT_TEXT = 'Summarize the task and plan status in 5 lines';

interface SharedTaskViewProps {
  task: Task;
  onClose: () => void;
}

export function SharedTaskView({ task, onClose }: SharedTaskViewProps) {
  const blobExpansion = new ExpansionRequest({ expand: ['blobs'] });

  const senderName = task.sender_name
    || task.shared_by_id
    || 'Unknown';

  const specTypeId = task.firstContextOfType?.('spec') ?? null;
  const { data: spec } = useEntity<Spec>(
    specTypeId,
    { query: blobExpansion },
  );
  const conversationTypeId = task.firstContextOfType?.('conversation') ?? null;

  const { localUser } = useLocalUser();
  const ensureCloudLogin = useCloudLoginGate();
  const isAuthor = !!(localUser?.id && task.shared_by_id && localUser.id === task.shared_by_id);
  const [requestingStatus, setRequestingStatus] = useState(false);

  const handleRequestStatus = async () => {
    if (!conversationTypeId?.id || requestingStatus) return;
    setRequestingStatus(true);
    try {
      const gate = await ensureCloudLogin();
      if (!gate.ok) {
        toast.error(gate.error);
        return;
      }
      await sendReply(
        { task, conversationId: conversationTypeId.id },
        '',
        undefined,
        { promptText: STATUS_REQUEST_PROMPT_TEXT },
      );
      toast.success('Status request sent', {
        description: 'The recipient will see a PROMPT to approve.',
      });
    } catch (err) {
      console.error('[SharedTaskView] sendReply failed', err);
      toast.error('Failed to send status request');
    } finally {
      setRequestingStatus(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-card">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <button
          onClick={onClose}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Back to tasks"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{task.displayName}</h2>
          {senderName && (
            <p className="text-xs text-muted-foreground">From {senderName}</p>
          )}
        </div>
        {isAuthor && conversationTypeId && (
          <button
            type="button"
            onClick={() => void handleRequestStatus()}
            disabled={requestingStatus}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            title="Send a PROMPT to the recipient asking for a status summary"
          >
            <Activity className="h-3.5 w-3.5" />
            {requestingStatus ? 'Sending…' : 'Request status'}
          </button>
        )}
      </div>

      {/* Body — spec on top, ConversationPanel filling the rest. The
          conversation hosts its own right-side drawer (Runs / Context) plus
          the bottom ribbon, which now sits flush at the bottom of this view. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {(spec?.title || spec?.content) && (
          <section className="flex-shrink-0 space-y-3 border-b border-border px-4 py-4">
            {spec?.title && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Title</span>
                <p className="mt-0.5 text-sm">{spec.title}</p>
              </div>
            )}
            {spec?.content && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Description</span>
                <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground/80 whitespace-pre-wrap">
                  {spec.content}
                </div>
              </div>
            )}
          </section>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          {conversationTypeId ? (
            <ConversationPanel
              task={task}
              conversationId={conversationTypeId.id}
              senderName={senderName}
            />
          ) : (
            <p className="px-4 py-4 text-xs italic text-muted-foreground/60">No conversation yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

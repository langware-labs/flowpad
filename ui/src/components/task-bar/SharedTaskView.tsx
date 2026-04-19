/**
 * SharedTaskView — Full-screen task view for shared (notification) tasks.
 *
 * Shown when recipient opens a task that was shared via cross-user notification.
 * Replaces the sliding TaskDetailPanel for spec_id tasks.
 */

import { ArrowLeft, MessageSquare, Send, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { AgenticProcess, Conversation, dataContext, Spec, Task, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ExpansionRequest } from '@sdk/FlowSync/query';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { sendReply } from '@sdk/entities/notifications';

interface SharedTaskViewProps {
  task: Task;
  onClose: () => void;
}

export function SharedTaskView({ task, onClose }: SharedTaskViewProps) {
  const { navigation } = useDockNavigation();
  const [replyText, setReplyText] = useState('');
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replySending, setReplySending] = useState(false);

  const blobExpansion = new ExpansionRequest({ expand: ['blobs'] });

  // Sender name comes from task metadata — no local user entity lookup needed
  // (sender is a remote user who only exists on the hub).
  const senderName = (task.metadata as Record<string, unknown> | undefined)?.sender_name as string | undefined
    || task.shared_by_id
    || 'Unknown';
  const { data: spec } = useEntity<Spec>(
    task.spec_id ? new TypeId(Spec.type, task.spec_id) : null,
    { query: blobExpansion },
  );
  const { data: conversation } = useEntity<Conversation>(
    task.conversation_id ? new TypeId(Conversation.type, task.conversation_id) : null,
    { query: blobExpansion },
  );

  const messages = conversation?.conversationMessages ?? [];

  const handleClaudeIt = async () => {
    const specContent = spec?.content ?? '';
    const specTitle = spec?.title ?? task.title ?? 'Untitled';
    const senderLabel = senderName;
    const prompt = [
      `You received a task from ${senderLabel}: "${specTitle}"`,
      '',
      specContent
        ? `Here is the plan:\n\n${specContent}`
        : `Task: ${task.title || 'Untitled'}`,
      '',
      'Please read through the plan carefully and confirm you have everything you need to get started. If anything is unclear or missing, ask before proceeding.',
    ].join('\n');

    try {
      const workdir = (task.metadata as Record<string, unknown> | undefined)?.project_root as string | undefined
        ?? dataContext.project?.fs_storage_mount_path;
      const { process: agenticProcess } = await AgenticProcess.spawn(
        { workdir },
        { instruction: prompt, visible: true },
      );
      navigation.openDock(agenticProcess.dockPointer);
    } catch (err) {
      console.error('[Claude It] Failed to spawn process:', err);
    }
  };

  const handleReply = async () => {
    if (!replyText.trim() || !task.id) return;
    setReplySending(true);
    setReplyError(null);
    try {
      await sendReply(task, replyText.trim());
      setReplyText('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send reply.';
      setReplyError(msg);
    } finally {
      setReplySending(false);
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
          <h2 className="truncate text-base font-semibold">{task.title || 'Untitled'}</h2>
          {senderName && (
            <p className="text-xs text-muted-foreground">
              From {senderName}
            </p>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">

        {/* Read-only fields — mirrors SendNotificationDialog */}
        <section className="space-y-3">
          {/* Spec title */}
          {spec?.title && (
            <div>
              <span className="text-xs font-medium text-muted-foreground">Title</span>
              <p className="mt-0.5 text-sm">{spec.title}</p>
            </div>
          )}

          {/* Description */}
          {spec?.content && (
            <div>
              <span className="text-xs font-medium text-muted-foreground">Description</span>
              <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground/80 whitespace-pre-wrap">
                {spec.content}
              </div>
            </div>
          )}

        </section>

        {/* Claude It */}
        <button
          onClick={() => void handleClaudeIt()}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-4 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
        >
          <Sparkles className="h-4 w-4" />
          Claude It — Start Implementation
        </button>

        {/* Conversation */}
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <MessageSquare className="h-3.5 w-3.5" />
            Conversation
          </h3>
          {messages.length === 0 ? (
            <p className="text-xs italic text-muted-foreground/60">No messages yet.</p>
          ) : (
            <div className="space-y-2">
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`rounded-lg px-3 py-2 text-sm ${
                    msg.role === 'sender'
                      ? 'bg-primary/10 text-foreground'
                      : msg.role === 'bot'
                      ? 'bg-muted/60 text-foreground/70 italic'
                      : 'bg-muted text-foreground'
                  }`}
                >
                  <div className="mb-0.5 flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-muted-foreground">
                      {msg.role === 'bot' ? 'Claude' : msg.role === 'sender' ? senderName : 'You'}
                    </span>
                    {msg.timestamp && (
                      <span className="text-[10px] text-muted-foreground/60">
                        {new Date(msg.timestamp).toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    )}
                  </div>
                  {msg.content}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Reply */}
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <MessageSquare className="h-3.5 w-3.5" />
            Reply
          </h3>
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Reply to sender..."
            rows={3}
            disabled={replySending}
            className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
          {replyError && <p className="mt-0.5 text-xs text-destructive">{replyError}</p>}
          <button
            onClick={() => void handleReply()}
            disabled={!replyText.trim() || replySending || !task.shared_by_id}
            className="mt-1.5 flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-3 w-3" />
            {replySending ? 'Sending...' : 'Send Reply'}
          </button>
        </section>
      </div>
    </div>
  );
}

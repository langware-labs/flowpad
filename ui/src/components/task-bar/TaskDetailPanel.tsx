/**
 * TaskDetailPanel - Sliding detail panel showing task fields and related entities.
 * Read-only display; editing happens in the full dock view.
 */

import { ArrowLeft, ExternalLink, FileText, MessageSquare, Send, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Spec, Task, TypeId, User } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ExpansionRequest } from '@sdk/FlowSync/query';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { getPriorityColor, PRIORITY_CONFIG } from './constants';
import { getAnalysisPath, getTaskTypeLabel, openAnalysisReport } from './task-utils';
import { SendNotificationDialog } from './SendNotificationDialog';
import { ConversationView } from '@src/components/conversation/ConversationView';

interface TaskDetailPanelProps {
  task: Task;
  onClose: () => void;
}

function displayName(user: User | null | undefined, fallback?: string | null): string {
  return user?.name || user?.email || fallback || 'Unknown';
}

export function TaskDetailPanel({ task, onClose }: TaskDetailPanelProps) {
  const { navigation } = useDockNavigation();
  const [notificationDialogOpen, setNotificationDialogOpen] = useState(false);
  const blobExpansion = new ExpansionRequest({ expand: ['blobs'] });
  const isSharedTask = !!task.spec_id;

  const { data: sender } = useEntity<User>(
    task.shared_by_id ? new TypeId(User.type, task.shared_by_id) : null,
  );
  const { data: spec } = useEntity<Spec>(
    task.spec_id ? new TypeId(Spec.type, task.spec_id) : null,
    { query: blobExpansion },
  );
  const handleOpenFullView = () => {
    navigation.openDock(DockPointer.forTasks(task.typeId?.toString()));
  };

  const analysisPath = getAnalysisPath(task);

  const handleClaudeIt = () => {
    const specContent = spec?.content ?? '';
    const specTitle = spec?.title ?? task.title ?? 'Untitled';
    const senderLabel = displayName(sender, task.shared_by_id);
    const prompt = [
      `You received a task from ${senderLabel}: "${specTitle}"`,
      '',
      specContent
        ? `Here is the plan:\n\n${specContent}`
        : `Task: ${task.title || 'Untitled'}`,
      '',
      'Please read through the plan carefully and confirm you have everything you need to get started. If anything is unclear or missing, ask before proceeding.',
    ].join('\n');

    navigation.openDock(
      DockPointer.forShell(crypto.randomUUID(), { startClaude: true, startCommand: prompt }),
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border p-3">
        <button
          onClick={onClose}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{task.title || 'Untitled'}</span>
      </div>

      {/* Fields */}
      <div className="flex-1 space-y-3 overflow-y-auto p-3">

        {/* From (shared task) */}
        {isSharedTask && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">From</span>
            <div className="mt-0.5 text-sm">{displayName(sender, task.shared_by_id)}</div>
          </div>
        )}

        {/* Type Label */}
        {(isSharedTask || getTaskTypeLabel(task)) && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Type</span>
            <div className="mt-0.5">
              <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                {isSharedTask ? 'Task' : getTaskTypeLabel(task)}
              </span>
            </div>
          </div>
        )}

        {/* Status */}
        <div>
          <span className="text-xs font-medium text-muted-foreground">Status</span>
          <div className="mt-0.5 text-sm capitalize">{task.status || 'open'}</div>
        </div>

        {/* Priority */}
        {task.priority && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Priority</span>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${getPriorityColor(task.priority)}`} />
              <span className="text-sm">{PRIORITY_CONFIG[task.priority]?.label || task.priority}</span>
            </div>
          </div>
        )}

        {/* Due date */}
        {task.due_at && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Due date</span>
            <div className="mt-0.5 text-sm">
              {new Date(task.due_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            </div>
          </div>
        )}

        {/* Description */}
        {task.descriptionPlainText && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Description</span>
            <div className="mt-0.5 text-sm text-foreground/80">{task.descriptionPlainText}</div>
          </div>
        )}

        {/* Related entity */}
        {task.target_entity && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Related entity</span>
            <div className="mt-0.5 font-mono text-sm text-primary">{task.target_entity}</div>
          </div>
        )}

        {/* Analysis report link */}
        {analysisPath && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Analysis Report</span>
            <button
              onClick={() => openAnalysisReport(analysisPath, navigation)}
              className="mt-0.5 flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <FileText className="h-3.5 w-3.5" />
              Open analysis.md
            </button>
          </div>
        )}

        {/* ── Shared task section ─────────────────────────────── */}
        {isSharedTask && (
          <>
            {/* Spec content */}
            {spec?.content && (
              <div>
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {spec.spec_type ? `Spec · ${spec.spec_type}` : 'Spec'}
                </span>
                <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-border p-2 text-sm text-foreground/80">
                  {spec.content}
                </div>
              </div>
            )}

            {/* Claude It button */}
            <button
              onClick={handleClaudeIt}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-primary/40 bg-primary/5 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10"
            >
              <Sparkles className="h-4 w-4" />
              Claude It
            </button>

            {/* Conversation thread */}
            {task.conversation_id && (
              <div>
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <MessageSquare className="h-3.5 w-3.5" />
                  Conversation
                </span>
                <div className="mt-1">
                  <ConversationView
                    conversationId={task.conversation_id}
                    task={task}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer: Open full view + Send Notification */}
      <div className="flex items-center justify-between border-t border-border p-3">
        <button onClick={handleOpenFullView} className="flex items-center gap-1.5 text-xs text-primary hover:underline">
          <ExternalLink className="h-3 w-3" />
          Open full view
        </button>
        <button
          onClick={() => setNotificationDialogOpen(true)}
          className="flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          <Send className="h-3 w-3" />
          Send Notification
        </button>
      </div>

      <SendNotificationDialog
        task={task}
        open={notificationDialogOpen}
        onClose={() => setNotificationDialogOpen(false)}
      />
    </div>
  );
}

/**
 * SharedTaskView — Full-screen task view for shared (notification) tasks.
 *
 * Shown when recipient opens a task that was shared via cross-user notification.
 * Replaces the sliding TaskDetailPanel for spec_id tasks.
 */

import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Spec, Task, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ExpansionRequest } from '@sdk/FlowSync/query';
import { ConversationView } from '@src/components/conversation';
import { ConversationToolbar } from '@src/components/conversation/ConversationToolbar';
import { SpecSidePane } from '@src/components/conversation/SpecSidePane';

interface SharedTaskViewProps {
  task: Task;
  onClose: () => void;
}

export function SharedTaskView({ task, onClose }: SharedTaskViewProps) {
  const blobExpansion = new ExpansionRequest({ expand: ['blobs'] });
  const [showSpec, setShowSpec] = useState(false);

  const taskMeta = task.metadata as Record<string, unknown> | undefined;
  const senderName = taskMeta?.sender_name as string | undefined
    || task.shared_by_id
    || 'Unknown';

  const { data: spec } = useEntity<Spec>(
    task.spec_id ? new TypeId(Spec.type, task.spec_id) : null,
    { query: blobExpansion },
  );

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
            <p className="text-xs text-muted-foreground">From {senderName}</p>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">

        {/* Read-only fields */}
        <section className="space-y-3">
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

        {/* Conversation */}
        <section className="-mx-4 flex flex-col">
          <div className="flex h-9 flex-shrink-0 items-center gap-2 border-y border-border px-4 text-xs font-medium text-muted-foreground">
            <span>Conversation</span>
            {task.conversation_id && (
              <ConversationToolbar
                task={task}
                conversationId={task.conversation_id}
                senderName={senderName}
                onShowTask={() => setShowSpec(true)}
              />
            )}
          </div>
          <div className="px-4 pt-3">
            {task.conversation_id ? (
              <ConversationView
                conversationId={task.conversation_id}
                task={task}
                senderName={senderName}
              />
            ) : (
              <p className="text-xs italic text-muted-foreground/60">No conversation yet.</p>
            )}
          </div>
        </section>
      </div>

      <SpecSidePane
        open={showSpec}
        onClose={() => setShowSpec(false)}
        specId={task.spec_id}
      />
    </div>
  );
}

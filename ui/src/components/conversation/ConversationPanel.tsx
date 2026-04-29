import { useState } from 'react';
import type { ITask } from '@sdk/entities/task';
import { ConversationToolbar } from './ConversationToolbar';
import { ConversationView } from './ConversationView';
import { ProjectMappingDialog } from './ProjectMappingDialog';
import { SpecSidePane } from './SpecSidePane';
import { useProjectMappingGate } from './useProjectMappingGate';

interface ConversationPanelProps {
  /** Optional. Project-scoped conversations have no task. */
  task?: ITask | null;
  conversationId: string;
  /** Optional sender label for messages whose `sender_name` field is missing. */
  senderName?: string;
  /**
   * Override the "Conversation" header label. Pass `null` to suppress the
   * label entirely (the toolbar still renders). Default: "Conversation".
   */
  headerLabel?: string | null;
  /**
   * Visual density. `compact` matches the inline TaskDetailPanel layout;
   * `default` matches the SharedTaskView layout.
   */
  variant?: 'default' | 'compact';
  className?: string;
}

/**
 * Single source of truth for how a conversation looks anywhere in the app.
 *
 * Layout (top to bottom):
 *   [ "Conversation" header  +  ConversationToolbar (Open Task / Transcript / CC) ]
 *   [ ConversationView (avatars, bubbles, prompt rows, composer) ]
 *
 * Owns its own SpecSidePane and ProjectMappingDialog so callers don't have
 * to plumb either one. Drop the panel anywhere a task-bound conversation
 * needs to render — task views, the inbox reader, embedded panels.
 */
export function ConversationPanel({
  task,
  conversationId,
  senderName,
  headerLabel = 'Conversation',
  variant = 'default',
  className,
}: ConversationPanelProps) {
  const [showSpec, setShowSpec] = useState(false);
  // Project-scoped conversations skip the project-mapping gate entirely.
  const mappingGate = useProjectMappingGate(task ?? undefined);
  const ensureMapped = task ? mappingGate.ensureMapped : undefined;
  const mappingDialogProps = mappingGate.dialogProps;

  const headerWrapper =
    variant === 'compact'
      ? 'flex items-center gap-1.5 text-xs font-medium text-muted-foreground'
      : 'flex h-9 flex-shrink-0 items-center gap-2 border-y border-border px-4 text-xs font-medium text-muted-foreground';
  const bodyWrapper = variant === 'compact' ? 'mt-1' : 'px-4 pt-3';

  return (
    <div className={className}>
      {(headerLabel !== null || ensureMapped) && (
        <div className={headerWrapper}>
          {headerLabel !== null && <span>{headerLabel}</span>}
          {task && (
            <ConversationToolbar
              task={task}
              conversationId={conversationId}
              senderName={senderName}
              onShowTask={() => setShowSpec(true)}
              ensureMapped={ensureMapped}
            />
          )}
        </div>
      )}
      <div className={bodyWrapper}>
        <ConversationView
          conversationId={conversationId}
          task={task}
          senderName={senderName}
          ensureMapped={ensureMapped}
        />
      </div>

      {task && (
        <SpecSidePane
          open={showSpec}
          onClose={() => setShowSpec(false)}
          specId={task.spec_id}
        />
      )}
      {task && <ProjectMappingDialog {...mappingDialogProps} />}
    </div>
  );
}

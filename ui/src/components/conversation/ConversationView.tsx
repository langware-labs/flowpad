import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Conversation, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import { FlowMessageBubble } from './FlowMessageBubble';
import { MessageComposer } from './MessageComposer';
import { ProjectMappingDialog } from './ProjectMappingDialog';
import { useProjectMapping } from './useProjectMapping';
import { SpecSidePane } from './SpecSidePane';
import { useExecuteConversation } from './useExecuteConversation';
import { useApproveAndExecute } from './useApproveAndExecute';

interface ConversationViewProps {
  conversationId: string;
  task: ITask;
  senderName?: string;
  onChooseProject?: () => void;
}

export function ConversationView({ conversationId, task, senderName, onChooseProject }: ConversationViewProps) {
  const taskId = task.id ?? '';

  const { mapping, loaded: mappingLoaded } = useProjectMapping();
  const remoteProjectId = (task.metadata as Record<string, unknown> | undefined)?.remote_project_id as string | undefined;
  const remoteProjectName = (task.metadata as Record<string, unknown> | undefined)?.remote_project_name as string | undefined;
  const needsMapping = !!remoteProjectId && mappingLoaded && !mapping[remoteProjectId];
  const [showMapping, setShowMapping] = useState(true);
  const [showSpec, setShowSpec] = useState(false);

  const { data: conversation, refetch } = useEntity<Conversation>(
    new TypeId(Conversation.type, conversationId),
  );

  const pointers = conversation?.conversationMessageIds ?? [];

  const { execute } = useExecuteConversation({
    task,
    conversationId,
    senderName,
    onAfterExecute: () => void refetch(),
  });

  const { approveAndExecute } = useApproveAndExecute({ task });

  return (
    <div className="space-y-3">
      {needsMapping && remoteProjectId && (
        <ProjectMappingDialog
          open={showMapping}
          onClose={() => setShowMapping(false)}
          remoteProjectId={remoteProjectId}
          remoteProjectName={remoteProjectName ?? ''}
          taskId={taskId}
          onMapped={() => setShowMapping(false)}
        />
      )}

      <SpecSidePane
        open={showSpec}
        onClose={() => setShowSpec(false)}
        specId={task.spec_id}
      />

      {pointers.length === 0 ? (
        <p className="text-xs italic text-muted-foreground/60">No messages yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {pointers.map((ptr) => (
            <FlowMessageBubble
              key={ptr.message_id}
              messageId={ptr.message_id}
              timestamp={ptr.timestamp}
              task={task}
              onShowTask={() => setShowSpec(true)}
              onExecute={(messageId) => void execute(messageId)}
              onApproveAndExecute={async (messageId, idx) => {
                await approveAndExecute(messageId, idx);
                void refetch();
              }}
            />
          ))}
        </div>
      )}

      {onChooseProject && (
        <div className="flex">
          <button
            onClick={onChooseProject}
            title="Choose project folder"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <FolderOpen className="h-4 w-4 shrink-0" />
            Choose Project
          </button>
        </div>
      )}

      <MessageComposer task={task} onSent={() => void refetch()} />
    </div>
  );
}

import { useState } from 'react';
import { Conversation, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import { FlowMessageBubble } from './FlowMessageBubble';
import { MessageComposer } from './MessageComposer';
import { ProjectMappingDialog } from './ProjectMappingDialog';
import { useProjectMapping } from './useProjectMapping';
import { useApproveAndExecute } from './useApproveAndExecute';

interface ConversationViewProps {
  conversationId: string;
  task: ITask;
  senderName?: string;
}

export function ConversationView({ conversationId, task, senderName: _senderName }: ConversationViewProps) {
  const taskId = task.id ?? '';

  const { mapping, loaded: mappingLoaded } = useProjectMapping();
  const remoteProjectId = (task.metadata as Record<string, unknown> | undefined)?.remote_project_id as string | undefined;
  const remoteProjectName = (task.metadata as Record<string, unknown> | undefined)?.remote_project_name as string | undefined;
  const needsMapping = !!remoteProjectId && mappingLoaded && !mapping[remoteProjectId];
  const [showMapping, setShowMapping] = useState(true);

  const { data: conversation, refetch } = useEntity<Conversation>(
    new TypeId(Conversation.type, conversationId),
  );

  const pointers = conversation?.conversationMessageIds ?? [];

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
              onApproveAndExecute={async (messageId, idx) => {
                await approveAndExecute(messageId, idx);
                void refetch();
              }}
            />
          ))}
        </div>
      )}

      <MessageComposer task={task} onSent={() => void refetch()} />
    </div>
  );
}

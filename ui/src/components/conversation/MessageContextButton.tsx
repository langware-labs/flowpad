import { useMemo } from 'react';
import { Conversation, FlowMessage, Project, TypeId } from '@sdk';
import { ContextProcessButton } from '@src/components/context-process/ContextProcessButton';
import { compactTypeIds } from '@src/components/context-process/contextTypeids';

/**
 * Per-message context-process control (bottom of the bubble) — declares the
 * message's context (the message + its conversation + project) and delegates to
 * the generic {@link ContextProcessButton}. First consumer of the pattern.
 */
export function MessageContextButton({
  fm,
  projectId,
}: {
  fm: FlowMessage;
  projectId?: string | null;
}) {
  const target = fm.id ? new TypeId(FlowMessage.type, fm.id).toString() : null;
  // The message is the identity entity; conversation + project widen the context.
  const contextTypeids = useMemo(
    () =>
      compactTypeIds(
        target,
        fm.conversation_id && new TypeId(Conversation.type, fm.conversation_id).toString(),
        projectId && new TypeId(Project.type, projectId).toString(),
      ),
    [target, fm.conversation_id, projectId],
  );

  return (
    <ContextProcessButton
      target={target}
      contextTypeids={contextTypeids}
      projectId={projectId}
      name={fm.id ? `Message ${fm.id.slice(0, 8)}` : undefined}
      className="mt-1.5"
    />
  );
}

import { useCallback } from 'react';
import { Conversation, type Task } from '@sdk';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { buildAssistancePrompt } from './prompt-building';
import { useConversationSession } from './useConversationSession';
import { useProjectMappingGate } from './useProjectMappingGate';
import { WorkerToolbar } from '@src/components/workers/WorkerToolbar';

/**
 * Conversation-header affordance for the conversation's owning worker session.
 * Always renders exactly one of two states (never neither):
 *
 *   - a conversationProcess exists → a single **Open** button → its live shell;
 *   - none exists → a **launch toolbar** (claude_code / codex / copilot).
 *
 * Self-contained: it owns its own project-mapping gate + picker dialog, so it
 * can be dropped into the route header (which has no gate of its own). Launch
 * routes through `ensureMapped`, so an unmapped conversation opens the project
 * picker first and the launch continues automatically once a project is chosen.
 * The header prompt is intentionally light — the assistant prompt is
 * informational and the drawer supplies the full context-aware variant.
 */
export function ConversationHeaderSession({
  conversation,
  task,
}: {
  conversation: Conversation | null;
  task?: Task | null;
}) {
  const { ensureMapped, dialogProps } = useProjectMappingGate(task ?? undefined, conversation ?? undefined);
  const buildPrompt = useCallback(() => buildAssistancePrompt([], []), []);
  const { conversationProcess, starting, launch, open } = useConversationSession({
    conversation,
    ensureMapped,
    buildPrompt,
  });

  if (!conversation) return null;

  return (
    <>
      <WorkerToolbar
        hasProcess={!!conversationProcess}
        starting={starting}
        onOpen={open}
        onLaunch={launch}
        openTitle="Open the conversation session"
        testIdPrefix="conversation"
      />
      <OpenProjectComponent {...dialogProps} />
    </>
  );
}

import { resolveProcessDisplayName } from '@src/components/terminal/process-display-name';
import { useCallback } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Conversation, type Task } from '@sdk';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { buildConversationStatusPrompt } from './prompt-building';
import { useConversationSession } from './useConversationSession';
import { useProjectMappingGate } from './useProjectMappingGate';
import { ContextWorkerToolbar } from '@src/components/workers/ContextWorkerToolbar';

/**
 * Conversation-header affordance for the conversation's owning worker session.
 * Renders:
 *
 * the shared context-worker launcher: the launch toolbar (claude_code / codex /
 * copilot) until a conversationProcess exists, then **Open** → that session.
 *
 * Self-contained: it owns its own project-mapping gate + picker dialog, so it
 * can be dropped into the route header (which has no gate of its own). Launch
 * routes through `ensureMapped`, so an unmapped conversation opens the project
 * picker first and the launch continues automatically once a project is chosen.
 * The header launch opens on the conversation itself — "read it and report its
 * latest status"; the drawer supplies the full context-aware variant.
 *
 * A surface that starts a session on something narrower (the live session, on
 * its latest message) passes its own `buildPrompt`.
 */
export function ConversationHeaderSession({
  conversation,
  task,
  buildPrompt: buildPromptOverride,
  testIdPrefix = 'conversation',
}: {
  conversation: Conversation | null;
  task?: Task | null;
  buildPrompt?: () => string;
  testIdPrefix?: string;
}) {
  const { t } = useLingui();
  const { ensureMapped, dialogProps } = useProjectMappingGate(task ?? undefined, conversation ?? undefined);
  // Only called by a launch, which needs a conversation — so it has one here.
  const buildStatusPrompt = useCallback(() => buildConversationStatusPrompt(conversation!.typeId), [conversation]);
  const buildPrompt = buildPromptOverride ?? buildStatusPrompt;
  const { conversationProcess, starting, launch, open } = useConversationSession({
    conversation,
    ensureMapped,
    buildPrompt,
  });

  if (!conversation) return null;

  return (
    <>
      <ContextWorkerToolbar
        onLaunch={launch}
        hasProcess={!!conversationProcess}
        onOpen={open}
        openTitle={t`Open the conversation session`}
        sessionName={conversationProcess ? resolveProcessDisplayName(conversationProcess) : undefined}
        starting={starting}
        testIdPrefix={testIdPrefix}
      />
      <OpenProjectComponent {...dialogProps} />
    </>
  );
}

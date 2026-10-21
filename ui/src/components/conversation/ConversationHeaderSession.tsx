import { resolveProcessDisplayName } from '@src/components/terminal/process-display-name';
import { useCallback } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Conversation, type Task } from '@sdk';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { buildConversationStatusPrompt } from './prompt-building';
import { useConversationSession } from './useConversationSession';
import { useProjectMappingGate } from './useProjectMappingGate';
import { OpenSessionButton, WorkerToolbar } from '@src/components/workers/WorkerToolbar';

/**
 * Conversation-header affordance for the conversation's owning worker session.
 * Renders:
 *
 *   - a **launch toolbar** (claude_code / codex / copilot) — always, so a new
 *     session can start even when one already exists;
 *   - plus, when a conversationProcess exists, an **Open** chip → the latest one.
 *
 * Self-contained: it owns its own project-mapping gate + picker dialog, so it
 * can be dropped into the route header (which has no gate of its own). Launch
 * routes through `ensureMapped`, so an unmapped conversation opens the project
 * picker first and the launch continues automatically once a project is chosen.
 * The header launch opens on the conversation itself — "read it and report its
 * latest status"; the drawer supplies the full context-aware variant.
 *
 * A surface that starts a session on something narrower (the live session, on
 * its latest message) passes its own `buildPrompt` and `launchOnly`, which
 * always offers the launch toolbar.
 */
export function ConversationHeaderSession({
  conversation,
  task,
  buildPrompt: buildPromptOverride,
  launchOnly = false,
  testIdPrefix = 'conversation',
}: {
  conversation: Conversation | null;
  task?: Task | null;
  buildPrompt?: () => string;
  launchOnly?: boolean;
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
      <div className="inline-flex items-center gap-1">
        {!launchOnly && conversationProcess && (
          <OpenSessionButton
            onOpen={open}
            title={t`Open the conversation session`}
            name={resolveProcessDisplayName(conversationProcess)}
            testIdPrefix={testIdPrefix}
          />
        )}
        <WorkerToolbar starting={starting} onLaunch={launch} testIdPrefix={testIdPrefix} />
      </div>
      <OpenProjectComponent {...dialogProps} />
    </>
  );
}

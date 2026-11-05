import type { Agent } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { useCallback, useRef } from 'react';
import { CompactExecutionInput } from '@src/components/entity-execution-panel/CompactExecutionInput';
import { useOptionalFloatingChat } from '@src/components/floating-chat/floating-chat-context';

/**
 * "Ask Flowpad Assistant to change <name>" — a request about THIS agent, not to
 * it: it goes to the Flowpad Assistant's chat for this page, which answers it with
 * the agent-builder skill. The composer is the standard one: attachments,
 * drag-and-drop, and pasted images through the annotator.
 */
export function AgentRequestLine({ agent, displayName }: { agent: Agent; displayName: string }) {
  const { t } = useLingui();
  const assistant = useOptionalFloatingChat();
  const barRef = useRef<HTMLDivElement | null>(null);

  const onSend = useCallback(
    (text: string, files?: File[]) => {
      const request = text.trim();
      if (!assistant || (!request && !files?.length)) return;
      assistant.ask(`use the agent-builder skill and answer: ${request}`, {
        files,
        rect: barRef.current?.getBoundingClientRect() ?? null,
      });
    },
    [assistant],
  );

  if (!assistant) return null;
  return (
    <div ref={barRef} className="shrink-0 border-t border-border px-5 py-3" data-testid="agent-request-line">
      <CompactExecutionInput
        onSend={onSend}
        placeholder={t`Ask Flowpad Assistant to change ${displayName}`}
        allowAttachments
        draftScope={`agent-request:${agent.typeId.toString()}`}
      />
    </div>
  );
}

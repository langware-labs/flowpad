/**
 * What is happening in a channel conversation right now, under its feed — for EVERY message source,
 * not just voice.
 *
 * A message that arrives on a channel (an email, a WhatsApp, a call) is answered by the owning
 * agent in a headless run targeted at this conversation. The chat panel shows its own runs as they
 * work; a channel's run had no such line, so the conversation sat still until the reply landed.
 * This observes that run the way any non-originating surface does (`useObservedTurn`) and draws the
 * same activity line the chat uses — which tool, what it is doing, for how long.
 *
 * A live call adds one transient: the caller mid-sentence (`voice.call.partial`), shown until the
 * finished sentence arrives as a message.
 */
import { useEffect, useState } from 'react';
import { type AgenticProcess } from '@sdk';
import type { FlowEvent } from '@sdk/tags/EventBus';
import { useOnTag } from '@sdk/react/hooks';
import { ChatActivityLine } from '@src/components/entity-execution-panel/ChatActivityLine';
import { useObservedTurn } from '@src/components/entity-execution-panel/hooks/useObservedTurn';

interface Props {
  conversationId: string;
  /** The conversation's most recent run — the agent answering its channel. */
  run: AgenticProcess | null | undefined;
  /** How many messages the feed holds: a new one retires the caller's partial sentence. */
  messageCount: number;
}

export function ConversationLiveActivity({ conversationId, run, messageCount }: Props) {
  useObservedTurn(run);
  const partial = useSpeaking(conversationId, messageCount);
  return (
    <div data-testid="conversation-live-activity">
      {partial && (
        <div className="mx-4 my-1 max-w-[70%] rounded-2xl bg-muted/60 px-3 py-2 text-sm italic text-muted-foreground" data-testid="voice-partial" aria-live="polite">
          {partial}
        </div>
      )}
      {run && (
        <div className="px-4">
          <ChatActivityLine process={run} />
        </div>
      )}
    </div>
  );
}

/** The caller's sentence while they are still saying it; cleared when the next message lands. */
function useSpeaking(conversationId: string, messageCount: number): string {
  const [text, setText] = useState('');
  useOnTag(
    'voice.call.partial',
    (event: FlowEvent) => {
      const data = (event.data ?? {}) as { conversation_id?: string; text?: string };
      if (data.conversation_id === conversationId) setText(String(data.text ?? ''));
    },
    { target: `conversation:${conversationId}` },
  );
  useEffect(() => setText(''), [messageCount, conversationId]);
  return text;
}

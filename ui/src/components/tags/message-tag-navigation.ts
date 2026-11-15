import type { FlowMessage } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';

export function messageTagContext(message: FlowMessage): Record<string, string> {
  return {
    ...(message.id ? { message: message.id } : {}),
    ...(message.conversation_id ? { conversation: message.conversation_id } : {}),
  };
}

export function tagReturnContext(options?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(['message', 'conversation', 'origin_tag'].flatMap((key) => options?.[key] ? [[key, options[key]]] : []));
}

/** Explicit return context survives reload and Back without hidden global selection state. */
export function messageTagReturn(options: Record<string, string> | undefined, panel: 'picker' | 'queue'): DockPointer | null {
  if (!options?.message || !options?.conversation) return null;
  return DockPointer.forConversation(options.conversation, { messageId: options.message })
    .withOption('message_tags', `${options.message}:${panel}`);
}

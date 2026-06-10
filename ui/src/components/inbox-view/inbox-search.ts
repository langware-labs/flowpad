import type { FlowMessage } from '@sdk';

/** Conversation ids having at least one message whose text contains ``query``
 *  (case-insensitive substring). Empty/whitespace query matches nothing —
 *  callers treat that as "search inactive". ``text`` is coerced through
 *  String() because legacy local-DB rows can hold object-shaped payloads. */
export function matchingConversationIds(
  messages: readonly Pick<FlowMessage, 'text' | 'conversation_id'>[],
  query: string,
): Set<string> {
  const needle = query.trim().toLowerCase();
  const ids = new Set<string>();
  if (!needle) return ids;
  for (const m of messages) {
    if (!m.conversation_id) continue;
    if (String(m.text ?? '').toLowerCase().includes(needle)) {
      ids.add(m.conversation_id);
    }
  }
  return ids;
}

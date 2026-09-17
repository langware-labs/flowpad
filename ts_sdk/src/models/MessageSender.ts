/**
 * Who wrote a message — mirrors `MessageSender` (flow_sdk/schema/data_spec/message_sender_spec.py).
 * The backend types it at projection time; `senderOf` reads it, and falls back to a person for a
 * row that carries only the `sender_id` wire string (a hub runtime's messages). No surface parses
 * `sender_id` itself.
 */
export const SenderKind = {
  /** A person using Flowpad — `id` is their local or cloud user id. */
  User: 'user',
  /** An Agent speaking through a channel it holds — `id` is the Agent's id. */
  Agent: 'agent',
  /** Somebody on a channel — `channel` and `address`. */
  External: 'external',
} as const;
export type SenderKind = (typeof SenderKind)[keyof typeof SenderKind];

export interface IMessageSender {
  kind: SenderKind;
  id?: string;
  channel?: string;
  address?: string;
}

/** The typed sender of a message, or null when it names nobody. */
export function senderOf(message: {
  sender?: IMessageSender | null;
  sender_id?: string | null;
}): IMessageSender | null {
  if (message.sender) return message.sender;
  return message.sender_id ? { kind: SenderKind.User, id: message.sender_id } : null;
}

/**
 * Who wrote a message — mirrors `MessageSender` (flow_sdk/schema/data_spec/message_sender_spec.py).
 * The backend types it at projection time; `senderOf` reads it, and parses the `sender_id` wire
 * string only for a row that carries no typed sender (a hub runtime's messages). No surface parses
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

/** The sender a `sender_id` wire string names — the TS twin of `MessageSender.from_wire`:
 *  `<user id>` / `agent:<id>` / `<channel>:<address>` (`unknown` = no address). */
function fromWire(senderId: string | null | undefined): IMessageSender | null {
  const text = (senderId ?? '').trim();
  if (!text) return null;
  const at = text.indexOf(':');
  if (at < 0) return { kind: SenderKind.User, id: text };
  const head = text.slice(0, at);
  const tail = text.slice(at + 1);
  if (head === 'agent') return { kind: SenderKind.Agent, id: tail };
  return { kind: SenderKind.External, channel: head, address: tail === 'unknown' ? '' : tail };
}

/** The typed sender of a message, or null when it names nobody. */
export function senderOf(message: {
  sender?: IMessageSender | null;
  sender_id?: string | null;
}): IMessageSender | null {
  return message.sender ?? fromWire(message.sender_id);
}

/** Whether this machine wrote the message: one of our user ids, or an Agent we host —
 *  `MessageSender.authored_by`. */
export function authoredBy(sender: IMessageSender | null, selfIds: ReadonlyArray<string | null | undefined>): boolean {
  if (!sender) return false;
  if (sender.kind === SenderKind.Agent) return true;
  return sender.kind === SenderKind.User && !!sender.id && selfIds.includes(sender.id);
}

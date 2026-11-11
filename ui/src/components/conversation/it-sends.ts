import type { FlowMessage } from '@sdk';
import type { ItReplyMeta, ItRequestMeta } from '@sdk/entities/agent';

/** One machine's line under a send: its latest reply to that send. */
export interface ItSendRow {
  messageId: string;
  text: string;
  reply: ItReplyMeta;
}

/** A send of an IT operation: the owner's request and each machine's latest answer to it. */
export interface ItSend {
  request: ItRequestMeta;
  rows: ItSendRow[];
}

/**
 * An IT conversation's sends, parsed in one pass per update (as `indexCalls` parses prompt calls): each request
 * message's send, and the reply messages the feed hides because they render as rows of their request's table.
 *
 * A reply joins a send only when that request is in this conversation AND the reply is written by the request's
 * agent (the owner may post into their own thread, but only ever as themselves). Anything else -- a reply from
 * before operations existed (no `send_id`), or one whose request is not loaded -- stays a bubble of its own.
 * A machine asked again within one send ("Enable and run") shows its latest reply; machines keep the order
 * they first answered in.
 */
export function indexItSends(fms: Iterable<FlowMessage>): {
  sendByMessage: Map<string, ItSend>;
  replyMessageIds: Set<string>;
} {
  const requests = new Map<string, { messageId: string; request: ItRequestMeta }>();
  const replies: FlowMessage[] = [];
  for (const fm of fms) {
    if (!fm.id) continue;
    if (fm.it_request?.send_id) requests.set(fm.it_request.send_id, { messageId: fm.id, request: fm.it_request });
    else if (fm.it_reply?.send_id) replies.push(fm);
  }
  const sendByMessage = new Map<string, ItSend>();
  const replyMessageIds = new Set<string>();
  const at = (fm: FlowMessage) => String(fm.created_date ?? '');
  replies.sort((a, b) => at(a).localeCompare(at(b)));
  for (const fm of replies) {
    const reply = fm.it_reply as ItReplyMeta;
    const owner = requests.get(reply.send_id as string);
    if (!owner || (owner.request.agent_id && fm.sender_id !== owner.request.agent_id)) continue;
    let send = sendByMessage.get(owner.messageId);
    if (!send) {
      send = { request: owner.request, rows: [] };
      sendByMessage.set(owner.messageId, send);
    }
    const row: ItSendRow = { messageId: fm.id, text: fm.text ?? '', reply };
    const same = send.rows.findIndex((r) => r.reply.node_typeid === reply.node_typeid);
    if (same >= 0) send.rows[same] = row;
    else send.rows.push(row);
    replyMessageIds.add(fm.id);
  }
  return { sendByMessage, replyMessageIds };
}

/** What the conversation's newest request names: its operation, its agent, and how many machines answered it
 *  (`sendByMessage` from `indexItSends`); null when no request names its agent (a conversation from before). */
export function itOperationOf(
  fms: Iterable<FlowMessage>,
  sendByMessage: Map<string, ItSend>,
): { opId: string | null; agentId: string; machines: number } | null {
  let latest: FlowMessage | null = null;
  for (const fm of fms) {
    if (!fm.it_request?.agent_id) continue;
    if (!latest || String(fm.created_date ?? '') > String(latest.created_date ?? '')) latest = fm;
  }
  if (!latest?.it_request?.agent_id) return null;
  const machines = latest.id ? (sendByMessage.get(latest.id)?.rows.length ?? 0) : 0;
  return { opId: latest.it_request.op_id, agentId: latest.it_request.agent_id, machines };
}

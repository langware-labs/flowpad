import { useCallback, useEffect, useState } from 'react';
import { Agent, QueryRequest } from '@sdk';

/**
 * The hub-allocated mailboxes the signed-in person's agents hold — the email rows of the Channels screen.
 *
 * A mailbox belongs to ONE agent (the hub's `AgentMailbox`); its "routing" is that agent plus the mailbox's
 * allowlist (`allowed_senders`, empty = nobody). Read through `Agent.mailboxState()`, which knows both transports
 * (the desktop's own Agent, or the hub page's `agent/<id>/mailbox` door).
 */
export interface InboundMailbox {
  /** The owning agent's id — the row's key and the Routing page's pointer (`mailboxPointer`). */
  agentId: string;
  agentName: string;
  address: string;
  allowedSenders: string[];
}

/** What a Channels routing pointer names: a hub claim (a number) or an agent's mailboxForm. */
export type RoutingTarget = { kind: 'number'; id: string } | { kind: 'mailbox'; agentId: string };

const MAILBOX_POINTER_PREFIX = 'mailbox-';

export function mailboxPointer(agentId: string): string {
  return `${MAILBOX_POINTER_PREFIX}${agentId}`;
}

export function parseRoutingPointer(pointer: string | undefined): RoutingTarget | null {
  if (!pointer) return null;
  return pointer.startsWith(MAILBOX_POINTER_PREFIX)
    ? { kind: 'mailbox', agentId: pointer.slice(MAILBOX_POINTER_PREFIX.length) }
    : { kind: 'number', id: pointer };
}

/** Flowpad's own agents (shipped in a system project) are not the person's: they hold no mailbox of theirs. */
function isBuiltinAgent(agent: Agent): boolean {
  return !!agent.system || !!agent.shipped;
}

async function readMailbox(agent: Agent): Promise<InboundMailbox | null> {
  const mailbox = (await agent.mailboxState()).mailbox;
  if (!mailbox?.address) return null;
  return {
    agentId: String(agent.id),
    agentName: agent.name || String(agent.id),
    address: mailbox.address,
    allowedSenders: mailbox.allowed_senders ?? [],
  };
}

export function useInboundMailboxes(): {
  /** The person's own agents (a mailbox belongs to one of them). */
  agents: Agent[];
  mailboxes: InboundMailbox[];
  refresh: () => Promise<void>;
  /** Replace one row after a write that answered it — no re-read of every agent. */
  patch: (agentId: string, change: Partial<InboundMailbox>) => void;
} {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [mailboxes, setMailboxes] = useState<InboundMailbox[]>([]);

  const refresh = useCallback(async () => {
    try {
      const all = await Agent.query<Agent>(
        new QueryRequest({ type: Agent.type, scope: [], name: 'inbound:agents' }),
        true,
      );
      const own = all.filter((a) => !isBuiltinAgent(a));
      setAgents(own);
      const rows = await Promise.all(own.map((a) => readMailbox(a).catch(() => null)));
      setMailboxes(rows.filter((r): r is InboundMailbox => !!r).sort((a, b) => a.address.localeCompare(b.address)));
    } catch {
      setAgents([]);
      setMailboxes([]); // no agents reachable: the screen still shows the numbers
    }
  }, []);

  const patch = useCallback((agentId: string, change: Partial<InboundMailbox>) => {
    setMailboxes((rows) => rows.map((r) => (r.agentId === agentId ? { ...r, ...change } : r)));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { agents, mailboxes, refresh, patch };
}

import { useCallback, useEffect, useState } from 'react';
import { ActionInfo, Agent, type MailboxAllocation, QueryRequest, dataManager, isHubOnly } from '@sdk';

/**
 * The hub-allocated inboxes the signed-in person's agents hold — the email rows of the Channels screen.
 *
 * An inbox belongs to ONE agent (the hub's `AgentMailbox`); its "routing" is that agent plus the mailbox's
 * allowlist (`allowed_senders`, empty = nobody). The one place that knows the two transports: a desktop asks its own
 * Agent (`mailbox_state` / `configure_mailbox` / `allocate_mailbox`, which wire the local source too); the hub page
 * asks the hub's `agent/<id>/mailbox` door directly.
 */
export interface InboundMailbox {
  /** The owning agent's id — the row's key and the Routing page's pointer (`mailboxPointer`). */
  agentId: string;
  agentName: string;
  address: string;
  allowedSenders: string[];
}

interface MailboxDescriptor {
  address?: string;
  allowed_senders?: string[];
}

/** What a Channels routing pointer names: a hub claim (a number) or an agent's inbox. */
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

/** Flowpad's own agents (shipped in a system project) are not the person's: they hold no inbox of theirs. */
function isBuiltinAgent(agent: Agent): boolean {
  return !!agent.system || (agent.bundleDirectory ?? '').includes('/system_projects/');
}

function hubMailboxCall(agentId: string, verb: string, method: 'GET' | 'POST', body?: object): ActionInfo {
  const info = new ActionInfo(verb ? `mailbox/${verb}` : 'mailbox', 'agent', agentId, method);
  if (body) info.bodyParameters = body as Record<string, unknown>;
  return info;
}

function toRow(agent: Agent, d: MailboxDescriptor | null | undefined): InboundMailbox | null {
  if (!d?.address) return null;
  return {
    agentId: String(agent.id),
    agentName: agent.name || String(agent.id),
    address: d.address,
    allowedSenders: d.allowed_senders ?? [],
  };
}

async function readMailbox(agent: Agent): Promise<InboundMailbox | null> {
  if (isHubOnly()) {
    const data = await dataManager.callAction<unknown, { mailbox?: MailboxDescriptor | null }>(
      hubMailboxCall(String(agent.id), '', 'GET'),
    );
    return toRow(agent, data?.mailbox);
  }
  return toRow(agent, (await agent.mailboxState()).mailbox);
}

/** Set an inbox's allowlist (full addresses; the hub normalizes them). */
export async function setAllowedSenders(agent: Agent, allowedSenders: string[]): Promise<void> {
  if (isHubOnly()) {
    await dataManager.callAction(
      hubMailboxCall(String(agent.id), 'configure', 'POST', { allowed_senders: allowedSenders }),
    );
    return;
  }
  await agent.configureMailbox({ allowed_senders: allowedSenders });
}

/** Mint the inbox on the hub page. A desktop allocates through `useAllocateAgentMailbox` (it wires the source). */
export async function provisionMailboxOnHub(agent: Agent, body: MailboxAllocation): Promise<void> {
  await dataManager.callAction(hubMailboxCall(String(agent.id), 'provision', 'POST', body));
}

export function useInboundMailboxes(): {
  /** The person's own agents (an inbox belongs to one of them). */
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

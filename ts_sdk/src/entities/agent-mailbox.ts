import { APIEntity, registerEntity } from '../APIEntity';
import { normalizeEmail } from '../utils/utils';
import { EntityMerge, IEntity } from '../IEntity';
import type { TypeId } from '../models/TypeId';

export type AgentMailboxStatus = 'active' | 'disabled' | 'deleted';

export interface IAgentMailbox extends IEntity {
  address: string;
  display_name?: string | null;
  provider: string;
  provider_inbox_id: string;
  status: AgentMailboxStatus;
  agent_typeid: TypeId;
  allowed_senders?: string[];
  blocked_senders?: string[];
  allowed_recipients?: string[];
  blocked_recipients?: string[];
  open_senders?: boolean;
  open_recipients?: boolean;
  filters?: Record<string, string>;
}

/** The mailbox's lists: Receiving (who may write to it) and Sending (who it may write to). */
export const MAILBOX_LISTS = ['allowed_senders', 'blocked_senders', 'allowed_recipients', 'blocked_recipients'] as const;
export type MailboxList = (typeof MAILBOX_LISTS)[number];

/** Whether `address` matches an entry: the exact address, or its whole domain written `@domain`. */
export function onMailboxList(entries: readonly string[] | undefined, address: string): boolean {
  const candidate = normalizeEmail(address ?? '');
  if (!candidate) return false;
  const domain = candidate.includes('@') ? `@${candidate.split('@').pop()}` : '';
  return (entries ?? []).some((raw) => {
    const entry = String(raw ?? '').trim().toLowerCase();
    return entry.startsWith('@') ? !!domain && entry === domain : normalizeEmail(entry) === candidate;
  });
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AgentMailbox extends EntityMerge<IAgentMailbox> {}

/**
 * The mailbox allocated to an Agent.
 *
 * The Hub owns all of it — identity (address, provider, status) and policy
 * (allowlist, read defaults) — so what this shows and what the Hub enforces
 * cannot diverge. `allowed()` mirrors the Python gate exactly: an empty list
 * admits NOBODY, and a mailbox that is not active refuses everyone.
 */
@registerEntity
export class AgentMailbox extends APIEntity<AgentMailbox> implements IAgentMailbox {
  static type: string = 'agent_mailbox';

  address = '';
  display_name: string | null = null;
  provider = '';
  provider_inbox_id = '';
  status: AgentMailboxStatus = 'active';
  agent_typeid!: TypeId;
  allowed_senders: string[] = [];
  blocked_senders: string[] = [];
  allowed_recipients: string[] = [];
  blocked_recipients: string[] = [];
  open_senders = false;
  /** A hub too old to carry a Sending list has no Sending gate: open. */
  open_recipients = true;
  /** Standing read defaults, in the Hub's wire vocabulary. Defaults, not constraints. */
  filters: Record<string, string> = {};

  constructor(entity: Partial<IAgentMailbox> = {}) {
    super(entity);
    this.address = entity.address ?? this.address;
    this.display_name = entity.display_name ?? this.display_name;
    this.provider = entity.provider ?? this.provider;
    this.provider_inbox_id = entity.provider_inbox_id ?? this.provider_inbox_id;
    this.status = entity.status ?? this.status;
    this.allowed_senders = entity.allowed_senders ?? this.allowed_senders;
    this.blocked_senders = entity.blocked_senders ?? this.blocked_senders;
    this.allowed_recipients = entity.allowed_recipients ?? this.allowed_recipients;
    this.blocked_recipients = entity.blocked_recipients ?? this.blocked_recipients;
    this.open_senders = entity.open_senders ?? this.open_senders;
    this.open_recipients = entity.open_recipients ?? this.open_recipients;
    this.filters = entity.filters ?? this.filters;
    if (entity.agent_typeid) this.agent_typeid = entity.agent_typeid;
  }

  get isActive(): boolean {
    return this.status === 'active';
  }

  /**
   * Whether `address` may drive the Agent through this mailbox.
   *
   * Empty allowlist means nobody — the address is public and publicly writable,
   * so the safe default is the closed one. A disabled mailbox refuses everyone
   * regardless of the list, because the switch is a kill switch.
   */
  allowed(address: string): boolean {
    if (!this.isActive || onMailboxList(this.blocked_senders, address)) return false;
    return this.open_senders || onMailboxList(this.allowed_senders, address);
  }

  /** Whether the agent may send to `address` — the Hub enforces it; this is for showing it. */
  maySendTo(address: string): boolean {
    if (onMailboxList(this.blocked_recipients, address)) return false;
    return this.open_recipients || onMailboxList(this.allowed_recipients, address);
  }
}

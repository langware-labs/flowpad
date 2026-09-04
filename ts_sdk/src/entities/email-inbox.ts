import { APIEntity, registerEntity } from '../APIEntity';
import { normalizeEmail } from '../utils/utils';
import { EntityMerge, IEntity } from '../IEntity';
import type { TypeId } from '../models/TypeId';

export type EmailInboxStatus = 'active' | 'disabled' | 'deleted';

export interface IEmailInbox extends IEntity {
  address: string;
  display_name?: string | null;
  provider: string;
  provider_inbox_id: string;
  status: EmailInboxStatus;
  agent_typeid: TypeId;
  allowed_senders?: string[];
  filters?: Record<string, string>;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EmailInbox extends EntityMerge<IEmailInbox> {}

/**
 * The mailbox allocated to an Agent.
 *
 * The Hub owns all of it — identity (address, provider, status) and policy
 * (allowlist, read defaults) — so what this shows and what the Hub enforces
 * cannot diverge. `allowed()` mirrors the Python gate exactly: an empty list
 * admits NOBODY, and a mailbox that is not active refuses everyone.
 */
@registerEntity
export class EmailInbox extends APIEntity<EmailInbox> implements IEmailInbox {
  static type: string = 'agent_mailbox';

  address = '';
  display_name: string | null = null;
  provider = '';
  provider_inbox_id = '';
  status: EmailInboxStatus = 'active';
  agent_typeid!: TypeId;
  allowed_senders: string[] = [];
  /** Standing read defaults, in the Hub's wire vocabulary. Defaults, not constraints. */
  filters: Record<string, string> = {};

  constructor(entity: Partial<IEmailInbox> = {}) {
    super(entity);
    this.address = entity.address ?? this.address;
    this.display_name = entity.display_name ?? this.display_name;
    this.provider = entity.provider ?? this.provider;
    this.provider_inbox_id = entity.provider_inbox_id ?? this.provider_inbox_id;
    this.status = entity.status ?? this.status;
    this.allowed_senders = entity.allowed_senders ?? this.allowed_senders;
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
    if (!this.isActive) return false;
    // Through the same normalizer the backend gate uses. A second casefold here
    // would be a second answer to "who may drive this agent".
    const candidate = normalizeEmail(address ?? '');
    if (!candidate) return false;
    return this.allowed_senders.some((entry) => normalizeEmail(entry ?? '') === candidate);
  }
}

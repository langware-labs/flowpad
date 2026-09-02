import { APIEntity, registerEntity } from '../APIEntity';
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
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EmailInbox extends EntityMerge<IEmailInbox> {}

/** Read-only projection of the formal Hub mailbox allocated to an Agent. */
@registerEntity
export class EmailInbox extends APIEntity<EmailInbox> implements IEmailInbox {
  static type: string = 'agent_mailbox';

  address = '';
  display_name: string | null = null;
  provider = '';
  provider_inbox_id = '';
  status: EmailInboxStatus = 'active';
  agent_typeid!: TypeId;

  constructor(entity: Partial<IEmailInbox> = {}) {
    super(entity);
    this.address = entity.address ?? this.address;
    this.display_name = entity.display_name ?? this.display_name;
    this.provider = entity.provider ?? this.provider;
    this.provider_inbox_id = entity.provider_inbox_id ?? this.provider_inbox_id;
    this.status = entity.status ?? this.status;
    if (entity.agent_typeid) this.agent_typeid = entity.agent_typeid;
  }

  get isActive(): boolean {
    return this.status === 'active';
  }
}

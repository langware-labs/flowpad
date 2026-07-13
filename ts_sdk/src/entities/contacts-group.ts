import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import type { ConversationParticipant } from './conversation';

export interface IContactsGroup extends IEntity {
  /** Display name of the contacts group. */
  name?: string | null;
  /** Participant-shaped members: {user_id?, email?, name?}. */
  contacts?: ConversationParticipant[];
}

/**
 * A named, local address-book group of contacts — participant-shaped entries
 * the UI expands into individual conversation members in one click (the
 * ContactPicker offers groups above contacts). Never synced to the hub.
 *
 * Mirrors `flow_sdk.builtin.contacts_group.ContactsGroup`.
 */
@registerEntity
export class ContactsGroup extends APIEntity<ContactsGroup> implements IContactsGroup {
  contacts: ConversationParticipant[] = [];
  static type: string = 'contacts_group';

  constructor(entity: Partial<IContactsGroup> = {}) {
    super(entity);
    this.contacts = (entity.contacts as ConversationParticipant[] | undefined) ?? [];
  }
}

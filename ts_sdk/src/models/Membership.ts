import { TypeId } from './TypeId';

/** The roles a membership can carry — declared with the shapes that use it. */
export type { Role as UserRole } from './roles';
import type { Role } from './roles';
export type MembershipStatus = 'pending' | 'approved';

export type InvitationMethod = 'id' | 'email' | 'invitation';

export interface Membership {
  user_id: string;
  user_email: string;
  user_name?: string;
  roles: Role[];
  user_picture?: string;
  status?: MembershipStatus;
  invitation_id?: string;
  invitation_method?: string;
}

export interface IInvitationTarget {
  typeid: TypeId | undefined;
  roles: Role[];
}

export interface IMembershipRequest {
  recipient_email: string;
  invitation_targets: IInvitationTarget[];
  target_url_path?: string;
  expiration_at?: Date;
  message?: string;
}

export interface MentionSendInfo {
  target_entity_typeid: string;
  message?: string;
}

export interface PendingMention {
  targetTypeId?: TypeId;
  typeid?: TypeId;
  label: string;
}

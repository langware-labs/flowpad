import { UserRole } from '../services/membershipService';
import { TypeId } from './TypeId';
export type MembershipStatus = 'pending' | 'approved';

export type InvitationMethod = 'id' | 'email' | 'invitation';

export interface Membership {
  user_id: string;
  user_email: string;
  user_name?: string;
  role: string; // TODO: change to UserRole
  user_picture?: string;
  status?: MembershipStatus;
  invitation_id?: string;
  invitation_method?: string;
}

export interface IInvitationTarget {
  typeid: TypeId | undefined;
  role: UserRole;
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

import { makeObservable, observable, reaction, runInAction } from 'mobx';
import { dataManager } from '../APIEntity';
import { ApiResponse } from '../ApiResponse';
import { Workspace } from '../entities';
import { dataContext, TypeId } from '../FlowSync';
import { ActionInfo, IMembershipRequest, Membership, MentionSendInfo } from '../models';
import { navigator } from './navigationService';

export type UserRole = 'owner' | 'admin' | 'editor' | 'guest' | 'reader' | 'anonymous_viewer';

/**
 * Direct member selector — one of these keys identifies the member to act on.
 * Supersedes the legacy ``{member_through, value}`` envelope on both the remove
 * (DELETE) and role-update (PUT) paths: the discriminator was redundant since
 * the hub immediately fanned ``value`` back out into exactly these fields. The
 * 95% case is just ``{user_id}``. The hub still tolerates the old envelope.
 */
interface MembershipIdentifiers {
  user_id?: string;
  user_email?: string;
  invitation_id?: string;
}

interface MembershipRoleUpdate extends MembershipIdentifiers {
  role: string;
}

class RolesLabel {
  getRole(role: string | undefined) {
    switch (role) {
      case 'owner':
      case 'admin':
        return 'admin';
      case 'editor':
        return 'editor';
      case 'reader':
        return 'reader';
      case 'guest':
        return 'guest';
      default:
        return 'visitor';
    }
  }

  getRoleDescription(role: UserRole) {
    switch (role) {
      case 'owner':
      case 'admin':
        return 'Full Access';
      case 'editor':
        return 'Can edit';
      case 'reader':
        return 'Can view';
      case 'guest':
        return 'Basic view';
      default:
        return role; // TODO this is temp till role hierarchy is implemented. Then it should change to throwing an error or writing 'Fix me please';
      // return 'Fix me please';
    }
  }

  getRoleDescriptionHelpText(role: UserRole) {
    switch (role) {
      case 'owner':
      case 'admin':
        return 'Can edit and share with others.';
      case 'editor':
        return 'Can edit, but not share with others.';
      case 'reader':
        return 'Cannot edit or share with others.';
      case 'guest':
        return 'Guest';
      default:
        return 'This should throw an error';
    }
  }

  getLocalMemberDescription(role: UserRole, entityType: string): string {
    let roleDescription;
    switch (role) {
      case 'owner':
      case 'admin':
        roleDescription = 'full access';
        break;
      case 'editor':
        roleDescription = 'edit access';
        break;
      case 'reader':
        roleDescription = 'view access';
        break;
      case 'guest':
        roleDescription = 'guest';
        break;
      default:
        roleDescription = 'view access';
    }
    return `You have ${roleDescription} to this ${entityType}`;
  }
}

class MentionService {
  async sendMention(entity: any, mentionPayload: MentionSendInfo): Promise<void> {
    try {
      const actionInfo = new ActionInfo('send_mention', entity.type, entity.id, 'POST');
      actionInfo.bodyParameters = mentionPayload as any;
      await dataManager.callAction<MentionSendInfo, undefined>(actionInfo);
    } catch (e) {
      console.error('Failed to send mention: ', e);
    }
  }
}

class MembershipService {
  activeWorkspaceMemberships: Membership[] = [];
  activeEntityMemberships: Membership[] = [];

  constructor() {
    makeObservable(this, {
      activeWorkspaceMemberships: observable,
      activeEntityMemberships: observable,
    });
    reaction(
      () => dataContext.activeEntity,
      () => this.recalculateActiveEntityMemberships(),
    );
    reaction(
      () => dataContext.workspace,
      () => this.recalculateActiveWorkspaceMemberships(),
    );
  }

  async fetchPendingMemberships(typeId: TypeId): Promise<Membership[] | undefined> {
    return (await membershipService.fetchMemberships(typeId))?.filter(
      (member: Membership) => member.status === 'pending',
    );
  }

  async fetchMemberships(entity_typeId: TypeId): Promise<Membership[]> {
    if (entity_typeId.type == Workspace.type) {
      const workspace = dataManager.getByTypeIdFromCache(entity_typeId);
      const roles = workspace?.expand?.roles;
      if (!roles || (roles.length === 1 && roles[0] === 'guest')) {
        return [] as Membership[];
      }
    }

    try {
      const actionInfo = new ActionInfo('members', entity_typeId.type, entity_typeId.id, 'GET');
      const fetchedMemberships = await dataManager.callAction<undefined, Membership[]>(actionInfo);
      return fetchedMemberships ?? [];
    } catch (error) {
      console.error('Failed to fetch memberships', error);
      return [];
    }
  }

  async createMembership(entity_typeId: TypeId, membershipRequest: IMembershipRequest): Promise<void> {
    try {
      const actionInfo = new ActionInfo('members', entity_typeId.type, entity_typeId.id, 'POST');
      actionInfo.bodyParameters = membershipRequest as any;
      await dataManager.callAction<IMembershipRequest, ApiResponse<void>>(actionInfo);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Failed to create membership: ${error.message}`);
      } else {
        console.error('Failed to create membership: Unknown error');
      }
    }
  }

  /** Pick the single identifier key for a member — the body shape for the
   * remove (DELETE) and role-update (PUT) paths. */
  determineMembershipIdentifiers(membership: Membership): MembershipIdentifiers {
    if (membership.user_id) {
      return { user_id: membership.user_id };
    } else if (membership.user_email) {
      return { user_email: membership.user_email };
    } else if (membership.invitation_id) {
      return { invitation_id: membership.invitation_id };
    } else {
      throw new Error('No valid membership identifier could be determined');
    }
  }

  async updateMembershipRole(entity_typeId: TypeId, membership: Membership) {
    if (!membership.user_id && !membership.user_email && !membership.invitation_id) {
      console.error('At least one of user_id, user_email, or invitation_id is required');
      return;
    }
    if (!membership.role) {
      console.error('membership.role is required');
      return;
    }

    try {
      // PUT sends the identifier directly alongside the role — no
      // ``{member_through, value}`` envelope. The hub accepts both shapes.
      const payload: MembershipRoleUpdate = {
        ...this.determineMembershipIdentifiers(membership),
        role: membership.role,
      };

      const actionInfo = new ActionInfo('members', entity_typeId.type, entity_typeId.id, 'PUT');
      actionInfo.bodyParameters = payload as any;
      await dataManager.callAction<MembershipRoleUpdate, ApiResponse<void>>(actionInfo);
    } catch (error) {
      console.error('Failed to update Membership', error);
    }
  }

  async removeMembership(entity_typeId: TypeId, membership: Membership) {
    if (!membership.user_id && !membership.user_email && !membership.invitation_id) {
      console.error('At least one of user_id, user_email, or invitation_id is required');
      return;
    }

    try {
      // Remove sends identifiers directly — ``{user_id}`` / ``{user_email}`` /
      // ``{invitation_id}`` — instead of the legacy ``{member_through, value}``
      // envelope. The hub still accepts both shapes during the transition.
      const payload: MembershipIdentifiers = this.determineMembershipIdentifiers(membership);

      const actionInfo = new ActionInfo('members', entity_typeId.type, entity_typeId.id, 'DELETE');
      actionInfo.bodyParameters = payload as any;
      await dataManager.callAction<MembershipIdentifiers, ApiResponse<void>>(actionInfo);
      // if the user removed himself from the entity, navigate to the landing page
      if (membership.user_id === dataContext.user?.id) {
        void navigator.navigateToLanding(true);
      }
    } catch (error) {
      console.error('Failed to remove Membership', error);
    }
  }

  recalculateActiveEntityMemberships() {
    if (!dataContext.activeEntity?.saved) {
      this.activeEntityMemberships = [];
      return;
    }

    const fetchMembershipsOfActiveEntity = dataContext.activeEntity.typeId;
    void this.fetchMemberships(fetchMembershipsOfActiveEntity).then((memberships) => {
      runInAction(() => {
        if (!dataContext.activeEntity?.typeId) {
          return;
        }
        if (fetchMembershipsOfActiveEntity.equals(dataContext.activeEntity.typeId)) {
          this.activeEntityMemberships = memberships ?? [];
        }
      });
    });
  }

  recalculateActiveWorkspaceMemberships() {
    if (!dataContext.workspace?.saved) {
      this.activeEntityMemberships = [];
      return;
    }

    const fetchMembersForWorkspace = dataContext.workspace.typeId;
    void this.fetchMemberships(fetchMembersForWorkspace).then((memberships) => {
      runInAction(() => {
        if (!dataContext.workspace?.saved) {
          return;
        }
        if (fetchMembersForWorkspace.equals(dataContext.workspace.typeId)) {
          this.activeWorkspaceMemberships = memberships ?? [];
        }
      });
    });
  }
}

export const mentionService = new MentionService();
export const rolesLabel = new RolesLabel();
export const membershipService = new MembershipService();

import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { DockPointerData } from '../models/DockPointer';
import { ViewType } from '../utils/ui/view-types';
import type { CollaborationSpaceMember } from './collaboration-space';
import { CollaborationSpace, getOrCreateLocalMemberId } from './collaboration-space';

export interface ICollaborationSession extends IEntity {
  space_id?: string | null;
  project_id?: string | null;
  host_name?: string | null;
  host_member_id?: string | null;
  name?: string | null;
  members?: CollaborationSpaceMember[];
  agentic_process_ids?: string[];
  status?: string;
  started_at?: string | null;
  updated_at?: string | null;
  ended_at?: string | null;
}

@registerEntity
export class CollaborationSession
  extends APIEntity<CollaborationSession>
  implements ICollaborationSession
{
  static type: string = 'collaboration_session';

  space_id: string | null = null;
  project_id: string | null = null;
  host_name: string | null = null;
  host_member_id: string | null = null;
  name: string | null = null;
  members: CollaborationSpaceMember[] = [];
  agentic_process_ids: string[] = [];
  status: string = 'active';
  started_at: string | null = null;
  updated_at: string | null = null;
  ended_at: string | null = null;

  constructor(entity: Partial<ICollaborationSession> = {}) {
    super(entity as IEntity);
    Object.assign(this, entity);
    this.members = entity.members ?? [];
    this.agentic_process_ids = entity.agentic_process_ids ?? [];
  }

  get displayName(): string {
    if (this.name) return this.name;
    if (this.started_at) {
      try {
        return new Date(this.started_at).toLocaleString();
      } catch {
        // fall through
      }
    }
    return 'Session';
  }

  /**
   * DockPointer back to the session, nested in its space:
   *   /dock/collaboration_space/<space_id>/session/<session_id>
   */
  override get dockPointer(): DockPointerData {
    const pointer = this.space_id && this.id ? `${this.space_id}/session/${this.id}` : undefined;
    return new DockPointerData(ViewType.COLLABORATION_SPACE, pointer);
  }

  public async join(memberId: string, name: string): Promise<CollaborationSpaceMember | null> {
    const info = new ActionInfo('join', this.typeId.type, this.typeId.id, 'POST');
    info.bodyParameters = { member_id: memberId, name };
    const result = await dataManager.callAction<{ member_id: string; name: string }, any>(info);
    if (result && typeof result === 'object' && 'members' in result) {
      this.members = (result as any).members ?? this.members;
    }
    return this.members.find((m) => m.member_id === memberId) ?? null;
  }

  public async heartbeat(memberId: string): Promise<CollaborationSpaceMember[] | null> {
    const info = new ActionInfo('heartbeat', this.typeId.type, this.typeId.id, 'POST');
    info.bodyParameters = { member_id: memberId };
    const result = await dataManager.callAction<
      { member_id: string },
      { ok: boolean; members: CollaborationSpaceMember[] }
    >(info);
    if (result && Array.isArray(result.members)) {
      this.members = result.members;
      return result.members;
    }
    return null;
  }

  public async addProcess(processId: string): Promise<void> {
    const info = new ActionInfo('add_process', this.typeId.type, this.typeId.id, 'POST');
    info.bodyParameters = { agentic_process_id: processId };
    const result = await dataManager.callAction<
      { agentic_process_id: string },
      { ok: boolean; agentic_process_ids: string[] }
    >(info);
    if (result && Array.isArray(result.agentic_process_ids)) {
      this.agentic_process_ids = result.agentic_process_ids;
    }
  }

  public async end(): Promise<void> {
    const info = new ActionInfo('end', this.typeId.type, this.typeId.id, 'POST');
    await dataManager.callAction(info);
  }

  public isHost(memberId?: string): boolean {
    const local = memberId ?? (typeof window !== 'undefined' ? getOrCreateLocalMemberId() : '');
    return !!this.host_member_id && local === this.host_member_id;
  }

  /**
   * Start a new meeting. If `spaceId` is omitted, resolves (and lazy-creates)
   * the project's default space first. Seeds the host as the first member.
   */
  public static async create(options: {
    projectId?: string;
    spaceId?: string;
    hostName: string;
    hostMemberId?: string;
    name?: string | null;
  }): Promise<CollaborationSession> {
    const { projectId, hostName, name } = options;
    let spaceId = options.spaceId ?? null;
    let projectIdResolved: string | null = projectId ?? null;

    if (!spaceId) {
      if (!projectId) throw new Error('Either spaceId or projectId is required');
      const defaultSpace = await CollaborationSpace.ensureDefaultForProject(projectId, hostName);
      spaceId = defaultSpace.id;
      projectIdResolved = defaultSpace.project_id ?? projectId;
    }

    const memberId = options.hostMemberId ?? getOrCreateLocalMemberId();
    const now = new Date().toISOString();
    const session = new CollaborationSession({
      space_id: spaceId,
      project_id: projectIdResolved,
      host_name: hostName,
      host_member_id: memberId,
      name: name ?? null,
      members: [
        {
          member_id: memberId,
          name: hostName,
          joined_at: now,
          last_seen_at: now,
        },
      ],
      status: 'active',
    });
    await session.save();
    return session;
  }
}

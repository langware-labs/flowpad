import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { DockPointerData } from '../models/DockPointer';
import { ViewType } from '../utils/ui/view-types';
import type { ProjectMember } from './project';
import { Project, getOrCreateLocalMemberId } from './project';


export interface ICollaborationSession extends IEntity {
  project_id?: string | null;
  host_name?: string | null;
  host_member_id?: string | null;
  name?: string | null;
  members?: ProjectMember[];
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

  project_id: string | null = null;
  host_name: string | null = null;
  host_member_id: string | null = null;
  name: string | null = null;
  members: ProjectMember[] = [];
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
    if (this.name && this.name.trim()) return this.name;
    // Backfill display for legacy records that were created before auto-naming
    // landed. Uses the same "<Host>'s session (Day, HH:MM)" shape as create().
    const host = this.host_name?.trim() || 'Anonymous';
    const when = this.started_at ? new Date(this.started_at) : new Date();
    if (!Number.isNaN(when.getTime())) {
      return CollaborationSession.defaultName(host, when);
    }
    return `${host}'s session`;
  }

  /**
   * DockPointer back to the session, nested under its project:
   *   /dock/collaboration/<project_id>/session/<session_id>
   * (Using the COLLABORATION_SPACE ViewType for now — it will be renamed to
   * COLLABORATION in the next phase.)
   */
  override get dockPointer(): DockPointerData {
    const pointer = this.project_id && this.id ? `${this.project_id}/session/${this.id}` : undefined;
    return new DockPointerData(ViewType.COLLABORATION_SPACE, pointer);
  }

  public async join(memberId: string, name: string): Promise<ProjectMember | null> {
    const info = new ActionInfo('join', this.typeId.type, this.typeId.id, 'POST');
    info.bodyParameters = { member_id: memberId, name };
    const result = await dataManager.callAction<{ member_id: string; name: string }, any>(info);
    if (result && typeof result === 'object' && 'members' in result) {
      this.members = (result as any).members ?? this.members;
    }
    return this.members.find((m) => m.member_id === memberId) ?? null;
  }

  public async heartbeat(memberId: string): Promise<ProjectMember[] | null> {
    const info = new ActionInfo('heartbeat', this.typeId.type, this.typeId.id, 'POST');
    info.bodyParameters = { member_id: memberId };
    const result = await dataManager.callAction<
      { member_id: string },
      { ok: boolean; members: ProjectMember[] }
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
   * Start a new meeting bound to a project. Ensures the project has a
   * collaboration `session_code` (lazy-generated), seeds the host as the
   * first member of both project and session, then saves and returns the
   * session record.
   */
  /** Default session name: e.g. "Alex's session (Mon, 19:45)". */
  static defaultName(hostName: string, when: Date = new Date()): string {
    const day = when.toLocaleDateString(undefined, { weekday: 'short' });
    const hh = String(when.getHours()).padStart(2, '0');
    const mm = String(when.getMinutes()).padStart(2, '0');
    return `${hostName}'s session (${day}, ${hh}:${mm})`;
  }

  public static async create(options: {
    projectId: string;
    hostName: string;
    hostMemberId?: string;
    name?: string | null;
  }): Promise<CollaborationSession> {
    const { projectId, hostName, name } = options;
    if (!projectId) throw new Error('projectId is required');
    const effectiveName =
      name != null && name.trim() ? name.trim() : CollaborationSession.defaultName(hostName);

    // Ensure the project has a collaboration code (and a host).
    const project =
      Project.getByIdFromCache<Project>(projectId) ??
      (await Project.getById<Project>(projectId));
    if (!project) throw new Error(`Project ${projectId} not found`);
    const memberId = options.hostMemberId ?? getOrCreateLocalMemberId();
    if (!project.session_code || !project.host_member_id) {
      await project.ensureCollaborationCode(hostName, memberId);
    }

    const now = new Date().toISOString();
    const session = new CollaborationSession({
      project_id: projectId,
      host_name: hostName,
      host_member_id: memberId,
      name: effectiveName,
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

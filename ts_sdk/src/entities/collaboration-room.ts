import { APIEntity, dataManager, isNonEmptyString, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { DockPointerData } from '../models/DockPointer';
import { TypeId } from '../models/TypeId';
import { ViewType } from '../utils/ui/view-types';
import type { ProjectMember } from './project';
import { Project, getOrCreateLocalMemberId } from './project';


export interface ICollaborationRoom extends IEntity {
  project_id?: string | null;
  host_name?: string | null;
  host_member_id?: string | null;
  name?: string | null;
  members?: ProjectMember[];
  status?: string;
  started_at?: string | null;
  updated_at?: string | null;
  ended_at?: string | null;
  // NOTE: agentic_process_ids moved into the shared context bucket (room
  // membership is wire-bound). Read via
  // room.contextOfType('agentic_process', 'shared'); publish via
  // room.shareContextEntities(processTypeId), which round-trips through the
  // backend share-context endpoint.
}

@registerEntity
export class CollaborationRoom
  extends APIEntity<CollaborationRoom>
  implements ICollaborationRoom
{
  static type: string = 'collaboration_room';

  project_id: string | null = null;
  host_name: string | null = null;
  host_member_id: string | null = null;
  name: string | null = null;
  members: ProjectMember[] = [];
  status: string = 'active';
  started_at: string | null = null;
  updated_at: string | null = null;
  ended_at: string | null = null;

  constructor(entity: Partial<ICollaborationRoom> = {}) {
    super(entity as IEntity);
    Object.assign(this, entity);
    this.members = entity.members ?? [];
  }

  /** Convenience: list of agentic_process TypeIds in this room's context. */
  get agenticProcessIds(): string[] {
    return this.contextOfType('agentic_process').map((t) => t.id);
  }

  /** Project the room's project as a chip-projected direct field. */
  protected override _directFieldsAsTypeIds(): TypeId[] {
    const out: TypeId[] = [];
    if (this.project_id) out.push(new TypeId('project', this.project_id));
    return out;
  }

  /**
   * When ``name`` is empty (legacy records created before auto-naming),
   * synthesize ``"<Host>'s room (Day, HH:MM)"`` from ``host_name`` +
   * ``started_at``. With ``name`` set, return null and let the default chain
   * use it.
   */
  override getDisplayName(): string | null {
    if (isNonEmptyString(this.name)) return null;
    const host = isNonEmptyString(this.host_name) ? this.host_name.trim() : 'Anonymous';
    const when = this.started_at ? new Date(this.started_at) : new Date();
    if (!Number.isNaN(when.getTime())) {
      return CollaborationRoom.defaultName(host, when);
    }
    return `${host}'s room`;
  }

  /**
   * DockPointer back to the room, nested under its project:
   *   /dock/project/<project_id>/collaboration_room/<room_id>
   */
  override get dockPointer(): DockPointerData {
    const pointer =
      this.project_id && this.id
        ? `${this.project_id}/collaboration_room/${this.id}`
        : undefined;
    return new DockPointerData(ViewType.PROJECT, pointer);
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
    // Backend appends the process to shared_context_entities. The action
    // response is informational only — the canonical local mirror arrives
    // via the WS broadcast that the backend save emits, which routes back
    // into ``_shared_context_entities_`` through the standard entity update
    // path. (Pre-split this method manually re-built local context from the
    // response; with the shared bucket being wire-bound and FE-write-locked,
    // that path is the wrong tool — let the WS update do its job.)
    await dataManager.callAction<
      { agentic_process_id: string },
      { ok: boolean; shared_context_entities: string[] }
    >(info);
  }

  public async end(): Promise<void> {
    const info = new ActionInfo('end', this.typeId.type, this.typeId.id, 'POST');
    await dataManager.callAction(info);
  }

  public isHost(memberId?: string): boolean {
    const local = memberId ?? (typeof window !== 'undefined' ? getOrCreateLocalMemberId() : '');
    return !!this.host_member_id && local === this.host_member_id;
  }

  /** Default room name: e.g. "Alex's room (Mon, 19:45)". */
  static defaultName(hostName: string, when: Date = new Date()): string {
    const day = when.toLocaleDateString(undefined, { weekday: 'short' });
    const hh = String(when.getHours()).padStart(2, '0');
    const mm = String(when.getMinutes()).padStart(2, '0');
    return `${hostName}'s room (${day}, ${hh}:${mm})`;
  }

  /**
   * Start a new collaboration room bound to a project. Ensures the project has
   * a collaboration `session_code` (lazy-generated), seeds the host as the
   * first member of both project and room, then saves and returns the room
   * record.
   */
  public static async create(options: {
    projectId: string;
    hostName: string;
    hostMemberId?: string;
    name?: string | null;
  }): Promise<CollaborationRoom> {
    const { projectId, hostName, name } = options;
    if (!projectId) throw new Error('projectId is required');
    const effectiveName =
      name != null && name.trim() ? name.trim() : CollaborationRoom.defaultName(hostName);

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
    const room = new CollaborationRoom({
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
    await room.save();
    return room;
  }
}

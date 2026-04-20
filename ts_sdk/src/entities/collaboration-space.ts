import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { QueryRequest } from '../FlowSync/query';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { DockPointerData } from '../models/DockPointer';
import { ViewType } from '../utils/ui/view-types';
import config from '../config';

export interface CollaborationSpaceMember {
  member_id: string;
  name: string;
  joined_at: string | null;
  last_seen_at: string | null;
}

export interface ICollaborationSpace extends IEntity {
  session_code?: string;
  name?: string | null;
  host_name?: string | null;
  host_member_id?: string | null;
  project_id?: string | null;
  is_default?: boolean;
  members?: CollaborationSpaceMember[];
  status?: string;
  created_at?: string | null;
  ended_at?: string | null;
}

export interface ResolveCollaborationSpaceResult {
  collaboration_space_id: string;
  session_code: string;
  host_name: string | null;
  project_id: string | null;
  members_count: number;
}

const LOCAL_MEMBER_ID_KEY = 'flowpad.collaboration_space.member_id';

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getOrCreateLocalMemberId(): string {
  try {
    const existing = localStorage.getItem(LOCAL_MEMBER_ID_KEY);
    if (existing) return existing;
    const fresh = uuid();
    localStorage.setItem(LOCAL_MEMBER_ID_KEY, fresh);
    return fresh;
  } catch {
    return uuid();
  }
}

@registerEntity
export class CollaborationSpace extends APIEntity<CollaborationSpace> implements ICollaborationSpace {
  static type: string = 'collaboration_space';

  session_code: string = '';
  name: string | null = null;
  host_name: string | null = null;
  host_member_id: string | null = null;
  project_id: string | null = null;
  is_default: boolean = false;
  members: CollaborationSpaceMember[] = [];
  status: string = 'active';
  created_at: string | null = null;
  ended_at: string | null = null;

  constructor(entity: Partial<ICollaborationSpace> = {}) {
    super(entity as IEntity);
    Object.assign(this, entity);
    this.members = entity.members ?? [];
  }

  get displayName(): string {
    if (this.name && this.name.trim()) return this.name;
    return this.host_name ? `${this.host_name}'s space` : (this.session_code || 'Collaboration Space');
  }

  override get dockPointer(): DockPointerData {
    return new DockPointerData(ViewType.COLLABORATION_SPACE, this.id);
  }

  /** Called by the joiner to register/refresh their membership. */
  public async join(memberId: string, name: string): Promise<CollaborationSpaceMember | null> {
    const info = new ActionInfo('join', this.typeId.type, this.typeId.id, 'POST');
    info.bodyParameters = { member_id: memberId, name };
    const result = await dataManager.callAction<{ member_id: string; name: string }, any>(info);
    if (result && typeof result === 'object' && 'members' in result) {
      this.members = (result as any).members ?? this.members;
    }
    return this.members.find((m) => m.member_id === memberId) ?? null;
  }

  /** Periodic presence ping — bumps last_seen_at on the backend. */
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

  /** End the space. Status flips to "ended"; code no longer resolves. */
  public async endSpace(): Promise<void> {
    const info = new ActionInfo('end', this.typeId.type, this.typeId.id, 'POST');
    await dataManager.callAction(info);
  }

  /**
   * Resolve a session code to a CollaborationSpace. Used by the join flow.
   * Uses a dedicated FastAPI route at /api/v1/collaboration_space/resolve/{code}.
   */
  public static async resolveByCode(code: string): Promise<ResolveCollaborationSpaceResult | null> {
    const normalized = (code ?? '').toUpperCase().trim();
    if (!normalized) return null;
    const url = `${config.SERVER_URL}/api/v1/collaboration_space/resolve/${encodeURIComponent(normalized)}`;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        credentials: 'include',
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as ResolveCollaborationSpaceResult;
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Return the given project's default space, lazily creating it if none
   * exists yet. Projects conceptually always have a default space — we just
   * don't create the record until someone actually meets there.
   */
  public static async ensureDefaultForProject(
    projectId: string,
    hostName?: string,
  ): Promise<CollaborationSpace> {
    if (!projectId) throw new Error('projectId is required');
    const request = new QueryRequest({
      type: CollaborationSpace.type,
      query: null,
      scope: [],
    });
    const list = await CollaborationSpace.query(request, true);
    for (const sp of list) {
      const cs = sp as CollaborationSpace;
      if (cs.project_id === projectId && cs.is_default && cs.status === 'active') {
        return cs;
      }
    }
    const fresh = new CollaborationSpace({
      project_id: projectId,
      is_default: true,
      host_name: hostName ?? null,
    } as Partial<ICollaborationSpace>);
    await fresh.save();
    return fresh;
  }

  /**
   * Create a new collaboration space. Returns the saved space with a fresh
   * session_code. Caller typically follows with navigation.openDock(space.dockPointer).
   */
  public static async create(hostName?: string, hostMemberId?: string): Promise<CollaborationSpace> {
    const memberId = hostMemberId ?? getOrCreateLocalMemberId();
    const space = new CollaborationSpace({
      host_name: hostName ?? null,
      host_member_id: memberId,
    } as Partial<ICollaborationSpace>);
    await space.save();
    // Seed the host as the first member so heartbeats have a row to touch and
    // joining members can see who's in the space.
    if (hostName) {
      try {
        await space.join(memberId, hostName);
      } catch (err) {
        console.warn('[CollaborationSpace.create] failed to seed host as member', err);
      }
    }
    return space;
  }

  /** True when the member's last_seen_at is within `windowMs` of now. */
  public isMemberOnline(memberId: string, windowMs: number = 30_000): boolean {
    const m = this.members.find((x) => x.member_id === memberId);
    if (!m || !m.last_seen_at) return false;
    const t = Date.parse(m.last_seen_at);
    if (Number.isNaN(t)) return false;
    return Date.now() - t < windowMs;
  }

  /** True when this local member is the host. */
  public isHost(memberId?: string): boolean {
    const local = memberId ?? (typeof window !== 'undefined' ? getOrCreateLocalMemberId() : '');
    return !!this.host_member_id && local === this.host_member_id;
  }

  /** Shareable join URL — `<origin>/join/<CODE>`. */
  public get joinUrl(): string {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/join/${this.session_code}`;
  }
}

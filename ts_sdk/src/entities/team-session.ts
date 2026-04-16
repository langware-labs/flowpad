import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { QueryRequest } from '../FlowSync/query';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import config from '../config';

export interface TeamSessionMember {
  member_id: string;
  name: string;
  joined_at: string | null;
  last_seen_at: string | null;
}

export interface ITeamSession extends IEntity {
  session_code?: string;
  agentic_process_id?: string | null;
  host_name?: string | null;
  host_member_id?: string | null;
  members?: TeamSessionMember[];
  status?: string;
  created_at?: string | null;
  ended_at?: string | null;
}

export interface ResolveTeamSessionResult {
  team_session_id: string;
  agentic_process_id: string | null;
  session_code: string;
  host_name: string | null;
  members_count: number;
}

const LOCAL_MEMBER_ID_KEY = 'flowpad.team_session.member_id';

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
export class TeamSession extends APIEntity<TeamSession> implements ITeamSession {
  static type: string = 'team_session';

  session_code: string = '';
  agentic_process_id: string | null = null;
  host_name: string | null = null;
  host_member_id: string | null = null;
  members: TeamSessionMember[] = [];
  status: string = 'active';
  created_at: string | null = null;
  ended_at: string | null = null;

  constructor(entity: Partial<ITeamSession> = {}) {
    super(entity as IEntity);
    Object.assign(this, entity);
    this.members = entity.members ?? [];
  }

  /** Called by the joiner to register/refresh their membership. */
  public async join(memberId: string, name: string): Promise<TeamSessionMember | null> {
    const info = new ActionInfo('join', this.typeId.type, this.typeId.id, 'POST');
    info.bodyParameters = { member_id: memberId, name };
    const result = await dataManager.callAction<{ member_id: string; name: string }, any>(info);
    if (result && typeof result === 'object' && 'members' in result) {
      this.members = (result as any).members ?? this.members;
    }
    return this.members.find((m) => m.member_id === memberId) ?? null;
  }

  /** Periodic presence ping — bumps last_seen_at on the backend. */
  public async heartbeat(memberId: string): Promise<TeamSessionMember[] | null> {
    const info = new ActionInfo('heartbeat', this.typeId.type, this.typeId.id, 'POST');
    info.bodyParameters = { member_id: memberId };
    const result = await dataManager.callAction<{ member_id: string }, { ok: boolean; members: TeamSessionMember[] }>(
      info,
    );
    if (result && Array.isArray(result.members)) {
      this.members = result.members;
      return result.members;
    }
    return null;
  }

  /** End the session. Status flips to "ended"; code no longer resolves. */
  public async endSession(): Promise<void> {
    const info = new ActionInfo('end', this.typeId.type, this.typeId.id, 'POST');
    await dataManager.callAction(info);
  }

  /**
   * Resolve a session code to the bound AgenticProcess. Used by the join flow.
   * Uses a dedicated FastAPI route registered at /api/v1/team_session/resolve/{code}.
   */
  public static async resolveByCode(code: string): Promise<ResolveTeamSessionResult | null> {
    const normalized = (code ?? '').toUpperCase().trim();
    if (!normalized) return null;
    const url = `${config.SERVER_URL}/api/v1/team_session/resolve/${encodeURIComponent(normalized)}`;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        credentials: 'include',
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as ResolveTeamSessionResult;
      return data;
    } catch {
      return null;
    }
  }

  /** Find the active TeamSession bound to a given AgenticProcess id, if any. */
  public static async findByProcessId(processId: string): Promise<TeamSession | null> {
    if (!processId) return null;
    const request = new QueryRequest({
      type: TeamSession.type,
      query: null,
      scope: [],
    });
    const list = await TeamSession.query(request, true);
    for (const ts of list) {
      if ((ts as TeamSession).agentic_process_id === processId && (ts as TeamSession).status === 'active') {
        return ts as TeamSession;
      }
    }
    return null;
  }

  /** True when the member's last_seen_at is within `windowMs` of now. */
  public isMemberOnline(memberId: string, windowMs: number = 30_000): boolean {
    const m = this.members.find((x) => x.member_id === memberId);
    if (!m || !m.last_seen_at) return false;
    const t = Date.parse(m.last_seen_at);
    if (Number.isNaN(t)) return false;
    return Date.now() - t < windowMs;
  }

  /** Shareable join URL for this session — `<origin>/join/<CODE>`. */
  public get joinUrl(): string {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/join/${this.session_code}`;
  }
}

import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { QueryRequest } from '../FlowSync/query';
import { ActionInfo, TypeId } from '../models';
import { DockPointerData } from '../models/DockPointer';
import config from '../config';
import { ViewType } from '../utils/ui/view-types';
import { Agent } from './agent';
import { Artifact, IArtifact } from './artifact';
import { ComputeNode } from './compute_node';
import { Workspace } from './workspace';

export interface ProjectMember {
  member_id: string;
  name: string;
  joined_at: string | null;
  last_seen_at: string | null;
}

export interface ResolveProjectResult {
  project_id: string;
  session_code: string;
  name: string | null;
  host_name: string | null;
  members_count: number;
}

const LOCAL_MEMBER_ID_KEY = 'flowpad.collaboration.member_id';

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
export class Project extends APIEntity<Project> {
  static type: string = 'project';
  computeNode?: ComputeNode | null = null;
  // ── Collaboration overlay (merged from the former CollaborationSpace) ──
  session_code: string | null = null;
  host_member_id: string | null = null;
  members: ProjectMember[] = [];

  constructor(entity: Partial<Project> = {}) {
    super(entity);
    this.session_code = (entity.session_code as string | null | undefined) ?? null;
    this.host_member_id = (entity.host_member_id as string | null | undefined) ?? null;
    this.members = (entity.members as ProjectMember[] | undefined) ?? [];
  }

  // Land on the project's collaboration/home view at /dock/project/<id>
  // instead of the generic /dock/home/<typeid> fallback APIEntity provides.
  override get dockPointer(): DockPointerData {
    return new DockPointerData(ViewType.PROJECT, this.identifier);
  }

  get searchDockPointer(): DockPointerData {
    return new DockPointerData(ViewType.ASSETS, 'list/all', {
      scope: 'project',
      project_ids: this.id,
    });
  }

  /**
   * Project's ``name`` is sometimes a full path (legacy data); strip to the
   * basename so the UI shows ``foo-project`` rather than
   * ``/Users/shlom/Documents/foo-project``. When ``name`` is empty or has no
   * path separators, return null and let the default chain handle it.
   */
  override getDisplayName(): string | null {
    if (!this.name || typeof this.name !== 'string') return null;
    const parts = this.name.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length <= 1) return null;
    return parts[parts.length - 1] || null;
  }

  /**
   * Get the compute node associated with this project
   * @returns The ComputeNode instance or null if none exists
   */
  async getComputeNode(): Promise<ComputeNode | null> {
    if (this.computeNode) {
      return this.computeNode;
    }
    const actionInfo = new ActionInfo('get-compute-node', Project.type, this.typeId.id, 'GET');
    const responseComputeNode = await dataManager.callAction<void, { compute_node: any }>(actionInfo);

    if (!responseComputeNode?.compute_node) {
      return null;
    }
    const computeNode = dataManager.updateEntityFromJson<ComputeNode>(responseComputeNode.compute_node);
    this.computeNode = computeNode;
    return computeNode;
  }

  async setupComputeNode(options?: { gitRemoteRepoUrl?: string; gitBranch?: string }): Promise<ComputeNode | null> {
    const actionInfo = new ActionInfo('initialize', Project.type, this.typeId.id, 'POST');
    actionInfo.bodyParameters = {
      ...(options?.gitRemoteRepoUrl && { gitRemoteRepoUrl: options.gitRemoteRepoUrl }),
      ...(options?.gitBranch && { gitBranch: options.gitBranch }),
    };
    const response = await dataManager.callAction<typeof actionInfo.bodyParameters, { compute_node: any }>(actionInfo);

    if (!response || !response.compute_node) {
      return null;
    }

    const computeNode = dataManager.updateEntityFromJson<ComputeNode>(response.compute_node);
    return computeNode;
  }

  /**
   * Add an artifact to this project
   * @param artifactData - The artifact data to create
   * @returns The created Artifact instance
   */
  async addArtifact(artifactData: Partial<IArtifact>): Promise<Artifact> {
    const artifact = new Artifact({
      ...artifactData,
      project_id: this.id,
    });

    // Save the artifact with this project as the scope
    await artifact.save(this.typeId);

    return artifact;
  }

  /**
   * Delete an artifact from this project
   * @param artifactId - The ID of the artifact to delete
   * @returns True if deletion was successful
   */
  async deleteArtifact(artifactId: string): Promise<boolean> {
    const typeId = new TypeId(Artifact.type, artifactId);
    const artifact = await dataManager.getByTypeId<Artifact>(typeId);
    if (!artifact) {
      throw new Error(`Artifact with ID ${artifactId} not found`);
    }

    await artifact.delete();
    return true;
  }

  /**
   * Get all artifacts for this project
   * @returns Array of Artifact instances
   */
  async getArtifacts(): Promise<Artifact[]> {
    const query = new QueryRequest({
      type: Artifact.type,
      scope: [this.typeId],
    });

    const results = await dataManager.query<Artifact>(query);
    return results;
  }

  /**
   * Setup desktop environment connections for this project.
   * Links the project to @local workspace, @local agent, and @local compute node.
   * Should be called after creating/opening a project in desktop mode.
   * @returns Object containing the connected workspace, agent, and compute_node
   */
  async setupForDesktop(): Promise<{
    workspace: Workspace | null;
    agent: Agent | null;
    compute_node: ComputeNode | null;
  }> {
    const actionInfo = new ActionInfo('setup-for-desktop', Project.type, this.typeId.id, 'POST');
    const response = await dataManager.callAction<
      void,
      {
        workspace: Workspace | null;
        agent: Agent | null;
        compute_node: ComputeNode | null;
      }
    >(actionInfo);

    return response || { workspace: null, agent: null, compute_node: null };
  }

  // ── Collaboration overlay (merged from CollaborationSpace) ───────────────

  /** True when the given member is the host on this project's collaboration. */
  isHost(memberId?: string): boolean {
    const local = memberId ?? (typeof window !== 'undefined' ? getOrCreateLocalMemberId() : '');
    return !!this.host_member_id && local === this.host_member_id;
  }

  /** True when the member's last_seen_at is within `windowMs` of now. */
  isMemberOnline(memberId: string, windowMs: number = 30_000): boolean {
    const m = this.members.find((x) => x.member_id === memberId);
    if (!m || !m.last_seen_at) return false;
    const t = Date.parse(m.last_seen_at);
    if (Number.isNaN(t)) return false;
    return Date.now() - t < windowMs;
  }

  /** Shareable URL — `<origin>/join/<CODE>`. Empty if no code yet. */
  get joinUrl(): string {
    if (typeof window === 'undefined' || !this.session_code) return '';
    return `${window.location.origin}/join/${this.session_code}`;
  }

  /**
   * Ensure this project has a collaboration code + host. Idempotent.
   * If there's no code yet, generates one, marks the caller as host, seeds
   * them as the first member. Returns the (updated) project.
   */
  async ensureCollaborationCode(hostName: string, hostMemberId?: string): Promise<Project> {
    const memberId = hostMemberId ?? getOrCreateLocalMemberId();
    const info = new ActionInfo('ensure-collaboration-code', Project.type, this.typeId.id, 'POST');
    info.bodyParameters = { host_name: hostName, host_member_id: memberId };
    const result = await dataManager.callAction<
      { host_name: string; host_member_id: string },
      Partial<Project>
    >(info);
    if (result) {
      if (result.session_code !== undefined) this.session_code = result.session_code ?? null;
      if (result.host_member_id !== undefined) this.host_member_id = result.host_member_id ?? null;
      if (Array.isArray(result.members)) this.members = result.members as ProjectMember[];
    }
    return this;
  }

  /** Register/refresh the caller as a project collaboration member. */
  async joinCollaboration(memberId: string, name: string): Promise<ProjectMember | null> {
    const info = new ActionInfo('join-collaboration', Project.type, this.typeId.id, 'POST');
    info.bodyParameters = { member_id: memberId, name };
    const result = await dataManager.callAction<
      { member_id: string; name: string },
      Partial<Project>
    >(info);
    if (result && Array.isArray(result.members)) {
      this.members = result.members as ProjectMember[];
    }
    return this.members.find((m) => m.member_id === memberId) ?? null;
  }

  /** Presence ping — bumps last_seen_at on the backend. */
  async heartbeatCollaboration(memberId: string): Promise<ProjectMember[] | null> {
    const info = new ActionInfo('heartbeat-collaboration', Project.type, this.typeId.id, 'POST');
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

  /**
   * Resolve a shareable session_code → project. Used by the join flow.
   * Uses a dedicated FastAPI route at /api/v1/project/resolve/{code}.
   */
  static async resolveByCode(code: string): Promise<ResolveProjectResult | null> {
    const normalized = (code ?? '').toUpperCase().trim();
    if (!normalized) return null;
    const url = `${config.SERVER_URL}/api/v1/project/resolve/${encodeURIComponent(normalized)}`;
    try {
      const resp = await fetch(url, { method: 'GET', credentials: 'include' });
      if (!resp.ok) return null;
      return (await resp.json()) as ResolveProjectResult;
    } catch {
      return null;
    }
  }
}

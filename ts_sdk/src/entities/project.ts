import { APIEntity, dataManager, isNonEmptyString, registerEntity } from '../APIEntity';
import apiClient from '../client';
import { QueryRequest } from '../FlowSync/query';
import { ActionInfo, TypeId, gitOriginFromUrl, type GitOrigin } from '../models';
import { DockPointerData } from '../models/DockPointer';
import { ViewType } from '../utils/ui/view-types';
import { Agent } from './agent';
import { Artifact, IArtifact } from './artifact';
import { ComputeNode } from './compute_node';
import { GitWorkdir } from './git-workdir';
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
  /** Context folders: extra directories auto-added to every agentic worker's
   *  --add-dir set and browseable in the Explorer as their own root. Mirrors
   *  the backend Project.include_dirs. */
  include_dirs: string[] = [];

  constructor(entity: Partial<Project> = {}) {
    super(entity);
    this.session_code = (entity.session_code as string | null | undefined) ?? null;
    this.host_member_id = (entity.host_member_id as string | null | undefined) ?? null;
    this.members = (entity.members as ProjectMember[] | undefined) ?? [];
    this.include_dirs = (entity.include_dirs as string[] | undefined) ?? [];
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
   * ``/Users/alice/Documents/foo-project``. When ``name`` is empty or has no
   * path separators, return null and let the default chain handle it.
   */
  override getDisplayName(): string | null {
    if (!isNonEmptyString(this.name)) return null;
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

  /**
   * `GitWorkdir` bound to this project's working tree, or null when the
   * project has no working directory or compute node. Null does NOT mean
   * "not a git repo" — that stays the async `isInit()` probe on the result.
   *
   * Mirror of the backend `Project.git_workdir()` (same null semantics).
   */
  async getGitWorkdir(): Promise<GitWorkdir | null> {
    if (!this.fs_storage_mount_path) return null;
    const computeNode = await this.getComputeNode();
    if (!computeNode) return null;
    return new GitWorkdir(this.fs_storage_mount_path, computeNode.id);
  }

  /** Add a context folder to this project's `include_dirs` (auto-added to every
   *  agentic worker's --add-dir set). Idempotent; the backend canonicalizes the
   *  path and kicks a one-shot index so the folder's assets become discoverable. */
  async addContextDir(path: string): Promise<void> {
    const actionInfo = new ActionInfo('add-context-dir', Project.type, this.typeId.id, 'POST');
    actionInfo.bodyParameters = { path };
    await dataManager.callAction(actionInfo);
    if (!(this.include_dirs ?? []).includes(path)) {
      this.include_dirs = [...(this.include_dirs ?? []), path];
    }
  }

  /** Remove a context folder from `include_dirs`. No-op if not present. */
  async removeContextDir(path: string): Promise<void> {
    const actionInfo = new ActionInfo('remove-context-dir', Project.type, this.typeId.id, 'POST');
    actionInfo.bodyParameters = { path };
    await dataManager.callAction(actionInfo);
    this.include_dirs = (this.include_dirs ?? []).filter((d) => d !== path);
  }

  async setupComputeNode(options?: { gitOrigin?: GitOrigin | null }): Promise<ComputeNode | null> {
    const actionInfo = new ActionInfo('initialize', Project.type, this.typeId.id, 'POST');
    actionInfo.bodyParameters = {
      ...(options?.gitOrigin && { gitOrigin: options.gitOrigin }),
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

  /** POST /graph/project/<id>/activate — stamp `last_active_at` (server clock,
   *  epoch-ms) via the generic `activate` action. Fired FIRE-AND-FORGET by
   *  `dataContext.setContextEntityTypeId` whenever the current project
   *  actually switches (the choke point every open-project path funnels
   *  through); the project pickers sort by it (recency wins over session
   *  `modified_at`). Static form mirrors `Tab.activateById`. */
  static async activateById(id: string): Promise<void> {
    const info = new ActionInfo('activate', Project.type, id, 'POST');
    await dataManager.callAction<undefined, unknown>(info);
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
   * Permanently delete this project and everything that belongs to it:
   * every indexed record whose ``project_id`` is this project (DB row + FTS +
   * wiki edges + on-disk record shadow + records_data bundle), the project's
   * own record, and the project source folder on disk. Irreversible.
   */
  async deleteWithChildren(): Promise<{ project_id: string; deleted_children: number } | null> {
    const info = new ActionInfo('delete-with-children', Project.type, this.typeId.id, 'POST');
    return await dataManager.callAction<void, { project_id: string; deleted_children: number }>(info);
  }

  /**
   * Resolve a filesystem path (cwd / workdir) → the owning Project by
   * longest-prefix match on `fs_storage_mount_path`.
   *
   * The single cross-worker, cross-platform FE primitive for "which project
   * owns this path" — used by both `resolveProjectContext` (loader active-project
   * resolution) and `Tab.getFromDockPointer` (tab project denormalization), so a
   * claude/codex/copilot session, shell, or agentic-process target whose entity
   * lacks `project_id` still resolves to the same real Project entity. Returns
   * the matched Project, or null when no project contains the path.
   */
  static async getProjectByPath(path: string | null | undefined): Promise<Project | null> {
    if (!path) return null;
    const projects = await Project.query<Project>(new QueryRequest({ type: Project.type, scope: [] }));
    const candidates = projects.filter(
      (p) => p.fs_storage_mount_path && path.startsWith(p.fs_storage_mount_path),
    );
    return (
      candidates.sort(
        (a, b) => (b.fs_storage_mount_path?.length ?? 0) - (a.fs_storage_mount_path?.length ?? 0),
      )[0] ?? null
    );
  }

  /**
   * Resolve a shareable session_code → project. Used by the join flow.
   * Uses a dedicated FastAPI route at /api/v1/project/resolve/{code}.
   */
  static async resolveByCode(code: string): Promise<ResolveProjectResult | null> {
    const normalized = (code ?? '').toUpperCase().trim();
    if (!normalized) return null;
    try {
      // /project/resolve returns the resource shape directly (no {status,data}
      // envelope). Wrap the raw body in {data} so apiClient's interceptor
      // (`.data.data`) yields the parsed payload — same approach as
      // dataManager.callAction for raw responses.
      return (await apiClient.get<ResolveProjectResult>(
        `/project/resolve/${encodeURIComponent(normalized)}`,
        {
          transformResponse: (raw: string) => ({ data: JSON.parse(raw) }),
        },
      )) as ResolveProjectResult;
    } catch {
      return null;
    }
  }

  /**
   * Clone a git URL into the desktop workspace and materialize a Project.
   * The wire contract is GitOrigin; URL/branch inputs are converted locally.
   * Dispatches to the compute_node `create-project-from-git` action.
   *
   * Returns one of:
   *   { kind: 'ok', project }                          — clone succeeded
   *   { kind: 'collision', suggestedName, attemptedName } — folder existed
   *   { kind: 'error', message }                        — clone or network failure
   */
  static async createFromGitUrl(
    computeNodeId: string,
    projectUrl: string,
    targetName?: string,
    branch?: string,
  ): Promise<
    | { kind: 'ok'; project: Project }
    | { kind: 'collision'; suggestedName: string; attemptedName: string }
    | { kind: 'error'; message: string }
  > {
    const gitOrigin = gitOriginFromUrl(projectUrl, branch);
    if (!gitOrigin) return { kind: 'error', message: 'Invalid Git repository URL' };
    const action = new ActionInfo('create-project-from-git', 'compute_node', computeNodeId, 'POST');
    action.bodyParameters = {
      git_origin: gitOrigin,
      ...(targetName ? { target_name: targetName } : {}),
    };
    try {
      const response = await dataManager.callAction<
        { git_origin: GitOrigin; target_name?: string },
        { project: unknown }
      >(action);
      if (!response?.project) return { kind: 'error', message: 'No project returned' };
      const project = dataManager.updateEntityFromJson<Project>(
        response.project as Record<string, unknown>,
      );
      return { kind: 'ok', project };
    } catch (err: unknown) {
      const ax = err as { response?: { status?: number; data?: { data?: unknown; message?: string } }; message?: string };
      if (ax.response?.status === 409) {
        const payload = ax.response.data?.data as { suggested_name?: string; attempted_name?: string } | undefined;
        return {
          kind: 'collision',
          suggestedName: payload?.suggested_name ?? '',
          attemptedName: payload?.attempted_name ?? '',
        };
      }
      const message = ax.response?.data?.message ?? ax.message ?? 'Unknown error';
      return { kind: 'error', message };
    }
  }

  /**
   * Recover a Project that's been deleted but still has dependents (Shells /
   * AgenticProcesses with ``project_id == orphanedId``). The backend picks any
   * dependent's ``workdir``, runs ``Project.recover_by_path`` (same 3-phase
   * primitive ``AgenticProcess.recoverProject`` uses), and rebinds every
   * dependent's ``project_id`` to the recovered id. Returns the recovered
   * Project. Cached via dataManager.
   */
  static async recoverOrphaned(orphanedId: string, computeNodeId: string): Promise<Project | null> {
    const action = new ActionInfo('recover-orphaned-project', 'compute_node', computeNodeId, 'POST');
    action.bodyParameters = { dangling_id: orphanedId };
    const response = await dataManager.callAction<{ dangling_id: string }, { project: unknown; rebound: number }>(action);
    if (!response?.project) return null;
    return dataManager.updateEntityFromJson<Project>(response.project as Record<string, unknown>);
  }
}

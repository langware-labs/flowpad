import { APIEntity, dataManager, isNonEmptyString, registerEntity } from '../APIEntity';
import apiClient from '../client';
import { QueryRequest } from '../FlowSync/query';
import { ActionInfo, TypeId, gitOriginFromUrl, type GitOrigin } from '../models';
import { DockPointerData } from '../models/DockPointer';
import type { AssetDescriptor } from '../process/asset-descriptor';
import { ViewType } from '../utils/ui/view-types';
import { Agent } from './agent';
import { Artifact, IArtifact } from './artifact';
import { type ConversationParticipant } from './conversation';
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

export type SecretPointerScope = 'private' | 'shared';

export interface LocalSecretRef {
  kind: 'local';
  sod_name: string;
}

export interface HubSecretRef {
  kind: 'flowpad-hub';
  secret_id: string;
}

export type SecretOriginLocator = LocalSecretRef | HubSecretRef;

export interface ProjectSecretOriginSummary {
  typeid: string;
  name: string;
  env_var: string;
  kind: SecretOriginLocator['kind'] | string;
  locator: Partial<SecretOriginLocator>;
  scope: SecretPointerScope | string;
}

export interface ProjectContextFolderResolveResult {
  typeid: string;
  kind: string;
  path?: string;
  message?: string;
  [key: string]: unknown;
}

/** Mirror of the backend computed `Project.context_dir_infos` entries. */
export interface ProjectContextDirInfo {
  path: string;
  /** Origin kind stamped at link time — "git" for cloned repos, else "local". */
  origin_kind: string;
  /** The linked Folder entity's typeid (e.g. "folder-<uuid>") — referenced by
   *  UI surfaces like the push-notify message chip. Empty for legacy dirs. */
  typeid?: string;
}

interface ProjectContextFolderResolveResponse {
  include_dirs?: unknown;
  context_folder_results?: unknown;
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
  // ── Hub collaboration (Project as a shared unit — mirrors Conversation) ──
  /** Hub role roster [{user_id, email, name, role}] — mirrors backend
   *  Project.participants. This is what the Members UI (`useMembers`) reads;
   *  distinct from the local presence `members` overlay below. The project's
   *  own (uuid4) id is the shared hub identity — no separate cloud id. */
  participants: ConversationParticipant[] = [];
  /** Last UI view mode used in this project (vibe|standard|advanced|dev);
   *  applied on project load so the mode is remembered per project. */
  last_mode: string | null = null;
  // ── Collaboration overlay (merged from the former CollaborationSpace) ──
  session_code: string | null = null;
  host_member_id: string | null = null;
  members: ProjectMember[] = [];
  /** Context folders: extra directories auto-added to every agentic worker's
   *  --add-dir set and browseable in the Explorer as their own root. Mirrors
   *  the backend Project.include_dirs. */
  include_dirs: string[] = [];
  /** Per-context-folder info (path + origin_kind). Mirrors the backend
   *  computed Project.context_dir_infos — same paths/order as include_dirs. */
  context_dir_infos: ProjectContextDirInfo[] = [];
  /** Project secret pointers. Value-free metadata only; values are never
   *  exposed through the SDK and resolve only inside worker launch. */
  secret_origins: ProjectSecretOriginSummary[] = [];

  constructor(entity: Partial<Project> = {}) {
    super(entity);
    this.participants = (entity.participants as ConversationParticipant[] | undefined) ?? [];
    this.last_mode = (entity.last_mode as string | null | undefined) ?? null;
    this.session_code = (entity.session_code as string | null | undefined) ?? null;
    this.host_member_id = (entity.host_member_id as string | null | undefined) ?? null;
    this.members = (entity.members as ProjectMember[] | undefined) ?? [];
    this.include_dirs = (entity.include_dirs as string[] | undefined) ?? [];
    this.context_dir_infos = (entity.context_dir_infos as ProjectContextDirInfo[] | undefined) ?? [];
    this.secret_origins = (entity.secret_origins as ProjectSecretOriginSummary[] | undefined) ?? [];
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
   * Discoverable assets for this project, pre-process (staging picker).
   * Backend `project/{id}/get-assets` — same descriptor shape as
   * `AgenticProcess.getAssets()`, computed server-side (path-scan over
   * user/project/context dirs + scoped spec list). Always bounded; when the
   * scan hit `limit` the response is truncated (long tail should be searched,
   * not listed).
   */
  async getAssets(options?: { types?: string[]; limit?: number }): Promise<AssetDescriptor[]> {
    return Project.getAssetsById(this.typeId.id, options);
  }

  /** Static form for callers without a Project instance (projectless staging → `'@local'`). */
  static async getAssetsById(
    projectId: string,
    options?: { types?: string[]; limit?: number },
  ): Promise<AssetDescriptor[]> {
    const actionInfo = new ActionInfo('get-assets', Project.type, projectId, 'GET');
    const queryParameters: Record<string, string | number> = {};
    if (options?.types?.length) queryParameters.types = options.types.join(',');
    if (options?.limit) queryParameters.limit = options.limit;
    actionInfo.queryParameters = queryParameters;
    const response = await dataManager.callAction<void, { assets?: AssetDescriptor[] }>(actionInfo);
    return response?.assets ?? [];
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

  /** Adopt the server-computed `include_dirs` off a context-dir action
   *  response. The backend derives the list from Folder context links (it
   *  canonicalizes paths), so the response — not an optimistic local guess —
   *  is the truth. */
  private adoptContextDirs(response: unknown): void {
    const dirs = (response as { include_dirs?: unknown } | null)?.include_dirs;
    if (Array.isArray(dirs)) {
      this.include_dirs = dirs.filter((d): d is string => typeof d === 'string');
    }
    const infos = (response as { context_dir_infos?: unknown } | null)?.context_dir_infos;
    if (Array.isArray(infos)) {
      this.context_dir_infos = infos.filter((item): item is ProjectContextDirInfo => (
        !!item && typeof item === 'object' && typeof (item as ProjectContextDirInfo).path === 'string'
      ));
    }
  }

  private adoptSecretOrigins(response: unknown): void {
    const origins = (response as { secret_origins?: unknown } | null)?.secret_origins;
    if (Array.isArray(origins)) {
      this.secret_origins = origins.filter((item): item is ProjectSecretOriginSummary => (
        !!item && typeof item === 'object' && typeof (item as ProjectSecretOriginSummary).typeid === 'string'
      ));
    }
  }

  /** Attach a context folder (auto-added to every agentic worker's --add-dir
   *  set). Idempotent; the backend mints the Folder entity, links it into the
   *  requested context bucket — `private` (default, never leaves this machine)
   *  or `shared` (travels with the project) — and kicks a one-shot index so
   *  the folder's assets become discoverable. */
  async addContextDir(path: string, scope: 'private' | 'shared' = 'private'): Promise<void> {
    const actionInfo = new ActionInfo('add-context-dir', Project.type, this.typeId.id, 'POST');
    actionInfo.bodyParameters = { path, scope };
    this.adoptContextDirs(await dataManager.callAction(actionInfo));
  }

  /** Get-or-create the `Folder` entity for a directory, WITHOUT attaching it as
   *  a context folder. Folder ids are deterministic (a Folder's id is its origin
   *  key), so this is a safe get-or-create: it never links, never indexes, and
   *  returns the same typeid for the same directory forever. Use it when a
   *  surface needs an entity for a directory the user is merely browsing (e.g.
   *  the Assets header's Share); use `addContextDir` when the folder should
   *  actually join the project's context. */
  async folderForPath(path: string): Promise<{ typeid: string; path: string; origin_kind: string | null }> {
    const actionInfo = new ActionInfo('folder-for-path', Project.type, this.typeId.id, 'POST');
    actionInfo.bodyParameters = { path };
    return dataManager.callAction(actionInfo);
  }

  /** Detach a context folder. No-op if not attached. */
  async removeContextDir(path: string): Promise<void> {
    const actionInfo = new ActionInfo('remove-context-dir', Project.type, this.typeId.id, 'POST');
    actionInfo.bodyParameters = { path };
    this.adoptContextDirs(await dataManager.callAction(actionInfo));
  }

  async addSecretPointer(
    name: string,
    envVar: string,
    options: { locator: SecretOriginLocator; scope?: SecretPointerScope },
  ): Promise<void> {
    const actionInfo = new ActionInfo('add-secret-pointer', Project.type, this.typeId.id, 'POST');
    actionInfo.bodyParameters = {
      name,
      env_var: envVar,
      scope: options.scope ?? 'private',
      kind: options.locator.kind,
      locator: options.locator,
      ...(options.locator.kind === 'local' ? { sod_name: options.locator.sod_name } : {}),
      ...(options.locator.kind === 'flowpad-hub' ? { secret_id: options.locator.secret_id } : {}),
    };
    this.adoptSecretOrigins(await dataManager.callAction(actionInfo));
  }

  async removeSecretPointer(typeid: string): Promise<void> {
    const actionInfo = new ActionInfo('remove-secret-pointer', Project.type, this.typeId.id, 'POST');
    actionInfo.bodyParameters = { typeid };
    this.adoptSecretOrigins(await dataManager.callAction(actionInfo));
  }

  /** Resolve received shared context folders into receiver-local paths. */
  async resolveContextFolders(): Promise<ProjectContextFolderResolveResult[]> {
    const actionInfo = new ActionInfo('resolve-context-folders', Project.type, this.typeId.id, 'POST');
    const response = await dataManager.callAction<undefined, ProjectContextFolderResolveResponse>(actionInfo);
    this.adoptContextDirs(response);
    const results = response?.context_folder_results;
    if (!Array.isArray(results)) return [];
    return results.filter((item): item is ProjectContextFolderResolveResult => (
      !!item && typeof item === 'object' && typeof (item as ProjectContextFolderResolveResult).kind === 'string'
    ));
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

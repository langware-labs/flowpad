import { APIEntity, dataManager, isNonEmptyString, registerEntity } from '../APIEntity';
import type { IEntity } from '../IEntity';
import apiClient from '../client';
import { QueryRequest } from '../FlowSync/query';
import { ActionInfo, TypeId, gitOriginFromUrl, type GitOrigin } from '../models';
import { DockPointerData } from '../models/DockPointer';
import type { AssetDescriptor, AssetSource } from '../process/asset-descriptor';
import { isHubOnly } from '../utils/hub-runtime';
import { ViewType } from '../utils/ui/view-types';
import { SubAgent } from './subagent';
import { Artifact, IArtifact } from './artifact';
import type { IDeployment } from './deployment';
import { type ConversationParticipant } from './conversation';
import { ComputeNode } from './compute_node';
import { GitWorkdir } from './git-workdir';
import { Workspace } from './workspace';
import { Wiki } from './wiki';

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

export interface InstalledContentProject {
  url: string;
  branch: string;
  content_project_id: string | null;
  folder_id: string | null;
  path: string;
  scope: 'private' | 'shared';
  status: 'installed' | 'already_installed';
}

export interface ReconcileBootstrapResult {
  target_project_id: string;
  content_projects: InstalledContentProject[];
  status: 'installed' | 'already_installed';
  helpdesk_id: string | null;
  journey_ids: string[];
  skill_ids: string[];
  auto_launch_journey_id: string | null;
  failed: Array<{
    error: string;
    url?: string;
    branch?: string;
    scope?: 'private' | 'shared';
    path?: string;
  }>;
}

/** What `adoptHelpdeskFromGit` found after attaching the repo.
 *
 * A closed set rather than a handful of booleans, because each value is a
 * different sentence to a person — and two of them are outright warnings:
 *
 * - `adopted` / `already_adopted` — a desk arrived and it IS the one that will
 *   serve this project.
 * - `shadowed` — a desk arrived but ANOTHER desk resolves first and keeps every
 *   ticket. Never render this as success: the customer would believe their
 *   requests now reach the new vendor when they do not.
 * - `no_manifest` — the repo carries no desk. The folder stays attached (it is
 *   still a fine context folder); offer `removeContextDir` rather than
 *   detaching for them.
 * - `invalid_desk_project_id` — a desk is here but names no usable queue, so
 *   tickets would fall through to the hub's default desk, i.e. someone else.
 * - `no_portal_project` — a desk is here but its checkout has no Project row,
 *   so the portal cannot be opened.
 */
export type AdoptHelpdeskOutcome =
  | 'adopted'
  | 'already_adopted'
  | 'shadowed'
  | 'no_manifest'
  | 'invalid_desk_project_id'
  | 'no_portal_project';

export interface AdoptHelpdeskResult {
  outcome: AdoptHelpdeskOutcome;
  /** Local checkout of the repo that was attached. Always present. */
  path: string;
  folder_id: string | null;
  scope: 'private' | 'shared';
  already_linked: boolean;
  scope_changed: boolean;
  /** Null for `no_manifest`; set for every other outcome. */
  helpdesk_id: string | null;
  /** Repo-controlled — never proof of who the desk is. */
  display_name: string | null;
  welcome_message: string | null;
  avatar_url: string | null;
  /** Hub project that owns the ticket queue. Null when the manifest named none. */
  desk_project_id: string | null;
  /** The local Project bound to the portal checkout — what you navigate to.
   *  Null for `no_manifest` / `invalid_desk_project_id` / `no_portal_project`. */
  portal_project_id: string | null;
  /** Only on `shadowed`: the desk that actually serves, and keeps serving. */
  shadowed_by: {
    path: string;
    display_name: string | null;
    desk_project_id: string;
  } | null;
}

export interface AddContextDirFromGitResult {
  folder_id: string;
  path: string;
  scope: 'private' | 'shared';
  cloned_url: string;
  already_linked: boolean;
  scope_changed: boolean;
}

export type SecretPointerScope = 'private' | 'shared';

export interface LocalSecretRef {
  kind: 'local';
  sod_name: string;
}

export interface EnvLocalSecretRef {
  kind: 'env-local';
  env_key: string;
}

export interface HubSecretRef {
  kind: 'flowpad-hub';
  secret_id: string;
}

export interface GcpSecretRef {
  kind: 'gcp';
  gcp_project: string;
  secret: string;
  version?: string;
}

export interface OnePasswordSecretRef {
  kind: '1password';
  vault: string;
  item: string;
  field?: string;
}

export type SecretOriginLocator =
  | LocalSecretRef
  | EnvLocalSecretRef
  | HubSecretRef
  | GcpSecretRef
  | OnePasswordSecretRef;

/** Which local SOD store the wizard caches a provided value into. */
export type SodStore = 'sodot' | 'env-local';

export interface ProjectSecretOriginSummary {
  typeid: string;
  name: string;
  /** Half of the identity — `(project_id, env_var)` is what names a secret. */
  project_id?: string;
  env_var: string;
  /** Where to FETCH from. Declaration detail, not identity: it may change
   *  without the secret becoming a different secret. */
  kind: SecretOriginLocator['kind'] | string;
  locator: Partial<SecretOriginLocator>;
  scope: SecretPointerScope | string;
  /** Which local store the wizard caches a provided value into. The backend has
   *  always emitted this; the type omitted it. */
  sod_store?: SodStore | string;
  /** What the secret is for, in the declarer's words. Lives on the declaration
   *  rather than the EnvVar row because a declaration may have no value yet, and
   *  an EnvVar cannot exist without one. */
  description?: string;
}

/** One row of the value-free resolve-status the Secrets card / wizard reads. */
export interface SecretResolveStatus {
  typeid: string;
  name: string;
  env_var: string;
  kind: string;
  scope: string;
  sod_store: SodStore | string;
  description?: string;
  status: 'available' | 'missing';
  /** Which store on THIS machine can satisfy the declaration, if any. */
  found_in?: 'env-local' | 'sodot' | 'provider' | null;
  /** `missing-value` when nothing here can satisfy it — what a receiver of a
   *  shared project sees for every secret they have not provided. */
  warning?: 'missing-value' | null;
  setup_hint: {
    kind: string;
    sod_store: SodStore | string;
    provider_label: string;
    prompt: string;
    coming_soon?: boolean;
    coord_fields?: string[];
  };
}

/** One `.env.local` key. Names and line numbers only — never a value. */
export interface EnvLocalKey {
  key: string;
  /** 1-indexed line of the effective (last) definition, for the editor jump. */
  line: number;
  declared: boolean;
}

export interface EnvLocalStatus {
  path: string | null;
  exists: boolean;
  gitignore: { in_repo: boolean; ignored: boolean; tracked?: boolean; code: string; reason: string };
  /** A hard block: the file is committable, so no value may be written to it. */
  blocked: boolean;
  block_code: string | null;
  block_reason: string | null;
  keys: EnvLocalKey[];
}

/** One row of the opt-in drift check. */
export interface SecretDriftStatus {
  typeid: string;
  env_var: string;
  warning: 'value-changed' | null;
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

/** A project's visual identity, from the `brand` block of
 *  `.flow/customization/string.json`. Every field is optional; the block itself
 *  is null unless at least one survived validation.
 *
 *  `logo` / `logo_dark` are REPO-RELATIVE paths the backend has already
 *  confirmed exist and are inside the project root — hand them straight to
 *  `useFS(projectTypeId).getDownloadUrl(path)`, no probe needed. */
export interface ProjectBrand {
  name?: string | null;
  tagline?: string | null;
  /** CSS colour for the accent. Apply it SCOPED to the branded container, never
   *  to `documentElement` — see `useHelpdeskBrand`. */
  accent?: string | null;
  logo?: string | null;
  logo_dark?: string | null;
}

/** Optional per-project branding read from `.flow/customization/`.
 *  Mirrors the backend `Project.customization` computed field. Image bytes are
 *  fetched on demand via the `fs` download action; here only a flag (home
 *  background) or a relative path (brand logos). */
export interface ProjectCustomization {
  /** From `.flow/customization/string.json` — overrides the home greeting. */
  home_title?: string | null;
  /** True when `.flow/customization/home.png` exists → render it as background. */
  has_home_background?: boolean;
  /** Null when the project ships no usable brand block. */
  brand?: ProjectBrand | null;
}

// ---------------------------------------------------------------------------
// Asset menu — 1:1 mirror of `flow_sdk/builtin/asset_menu.py`. Snake_case is the
// wire's and is kept verbatim: new fields land on the backend model first, this
// file only reflects them.
//
// The menu is STRUCTURE + COUNTS, never leaves. Type rows still load their
// entities lazily from `/search` on expand, and the filesystem subtree under a
// folder row stays lazy DFS browsing — nothing that is lazy today becomes eager
// because of this payload.
// ---------------------------------------------------------------------------

/** One per-type row of a node's menu. Counts only — icon, label, and view-mode
 *  tier are looked up from the bootstrap type registry the client already
 *  holds, never re-sent per response. */
export interface ProjectMenuGroup {
  type_name: string;
  /** Assets under THIS node's own directory. */
  own_count: number;
  /** Accumulated: own plus every descendant's, so a collapsed row tells the
   *  truth about what is under it. */
  count: number;
}

/** One directory in the menu: the project's own mount, or a context folder.
 *  Recursive by construction — a context folder that is itself a Project
 *  carries that Project's own context folders, 3+ levels deep. */
export interface ProjectMenuNode {
  /** Canonical POSIX path — the node's identity. */
  path: string;
  name: string;
  /** 'project_dir' for the root, 'context_dir' for every descendant. */
  source: AssetSource;
  /** Distance from the root project (root = 0). */
  depth: number;
  /** Null when this folder is not a Project (then `children` is always empty —
   *  only a Project has context folders of its own). */
  project_id: string | null;
  is_project: boolean;
  /** The linked Folder entity, from `context_dir_infos`. */
  folder_typeid: string | null;
  /** "git" | "local" — git-backed folders render distinctly. */
  origin_kind: string | null;
  /** Null for non-project nodes. True when the project has no index sentinel,
   *  so its zero counts mean "never scanned", not "empty". */
  never_indexed: boolean | null;
  groups: ProjectMenuGroup[];
  children: ProjectMenuNode[];
}

export interface ProjectAssetMenu {
  root: ProjectMenuNode;
  truncated: boolean;
}

export interface ProjectAssetMenuOptions {
  /** Narrow to these record types. Default: every browseable scannable type. */
  types?: string[];
  /** Recurse into context folders that are themselves Projects. Default true. */
  recursive?: boolean;
  /** Hard cap on DFS depth (root = 0). Backend clamps to 1..16. */
  maxDepth?: number;
}

interface ProjectAssetMenuResponse {
  menu?: ProjectAssetMenu;
}

interface ProjectContextFolderResolveResponse {
  include_dirs?: unknown;
  context_roots?: unknown;
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
  /** Hub role roster [{user_id, email, name, role}] — the generic ``members``
   *  cache from the Entity base (redeclared with a default so readers get an
   *  array). This is what the Members UI (`useMembers`) reads; distinct from the
   *  local presence `presence` overlay below. The project's own (uuid4) id is the
   *  shared hub identity — no separate cloud id. */
  members: ConversationParticipant[] = [];
  /** Portable repository identity received with a shared project (the hub sends it as `git_origin`). */
  origin: GitOrigin | null = null;
  /** When this desktop instance successfully published the Project to Hub. */
  hub_published_at: string | null = null;
  /** Last UI view mode used in this project (vibe|standard|advanced|dev);
   *  applied on project load so the mode is remembered per project. */
  last_mode: string | null = null;
  /** UI language for this project, as a supported locale code (en-US|he|ar);
   *  applied on project load so entering the project switches the app language. */
  locale: string | null = null;
  // ── Collaboration overlay (merged from the former CollaborationSpace) ──
  session_code: string | null = null;
  host_member_id: string | null = null;
  /** Local collaboration presence (session-code join, no roles). Renamed from
   *  `members` so that name is free for the hub role roster. */
  presence: ProjectMember[] = [];
  /** Context folders: extra directories auto-added to every agentic worker's
   *  --add-dir set and browseable in the Explorer as their own root. Mirrors
   *  the backend Project.include_dirs. */
  include_dirs: string[] = [];
  /** The project's own root followed by its context roots, canonicalized —
   *  mirror of the backend computed `Project.context_roots`. The one answer to
   *  "which directories count as this project's"; do NOT re-derive it from
   *  `fs_storage_mount_path` + `include_dirs`, which canonicalizes differently. */
  context_roots: string[] = [];
  /** Per-context-folder info (path + origin_kind). Mirrors the backend
   *  computed Project.context_dir_infos — same paths/order as include_dirs. */
  context_dir_infos: ProjectContextDirInfo[] = [];
  /** Project secret pointers. Value-free metadata only; values are never
   *  exposed through the SDK and resolve only inside worker launch. */
  secret_origins: ProjectSecretOriginSummary[] = [];
  /** Optional per-project home branding from `.flow/customization/`. Mirrors the
   *  backend computed `Project.customization`. Read-only. */
  customization: ProjectCustomization = {};

  constructor(entity: Partial<Project> = {}) {
    super(entity);
    this.members = (entity.members as ConversationParticipant[] | undefined) ?? [];
    // The hub sends the git kind under its wire name `git_origin`; a local row says `origin`.
    const hubOrigin = (entity as { git_origin?: GitOrigin | null }).git_origin;
    this.origin = (entity.origin as GitOrigin | null | undefined) ?? hubOrigin ?? null;
    this.hub_published_at = (entity.hub_published_at as string | null | undefined) ?? null;
    this.last_mode = (entity.last_mode as string | null | undefined) ?? null;
    this.locale = (entity.locale as string | null | undefined) ?? null;
    this.session_code = (entity.session_code as string | null | undefined) ?? null;
    this.host_member_id = (entity.host_member_id as string | null | undefined) ?? null;
    this.presence = (entity.presence as ProjectMember[] | undefined) ?? [];
    this.include_dirs = (entity.include_dirs as string[] | undefined) ?? [];
    this.context_roots = (entity.context_roots as string[] | undefined) ?? [];
    this.context_dir_infos = (entity.context_dir_infos as ProjectContextDirInfo[] | undefined) ?? [];
    this.secret_origins = (entity.secret_origins as ProjectSecretOriginSummary[] | undefined) ?? [];
    this.customization = (entity.customization as ProjectCustomization | undefined) ?? {};
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
    // Hub mode: the hub backend has no local compute node (`get-compute-node`
    // 401s). No node here — callers already treat null as "no compute node".
    if (isHubOnly()) return null;
    const responseComputeNode = await this.get<{ compute_node: any }>('get-compute-node');

    if (!responseComputeNode?.compute_node) {
      return null;
    }
    const computeNode = dataManager.updateEntityFromJson<ComputeNode>(responseComputeNode.compute_node);
    this.computeNode = computeNode;
    return computeNode;
  }

  /**
   * Run this project's app on a machine of its own in the cloud.
   *
   * The web half of deployment — a micro app is deployed by deploying the
   * project that holds it, because the project is what has the repository the
   * sandbox materializes. Sharing to the hub is implicit, so there is no order
   * for a caller to get wrong.
   *
   * Slow by nature (create + boot + health on a real sandbox); callers should
   * show progress rather than assume a snappy round trip.
   */
  async deploy(): Promise<ProjectDeployResult> {
    return (await this.post('deploy')) as ProjectDeployResult;
  }

  /**
   * Return this Project's stable default Wiki, lazily creating it server-side
   * for Projects that predate the Wiki invariant.
   */
  async getDefaultWiki(): Promise<Wiki> {
    const result = await this.get<IEntity>('default-wiki');
    return dataManager.updateEntityFromJson<Wiki>(result);
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
   * The Assets menu for this project: per-type groups with counts, and the same
   * nested under each context folder — recursively, because a context folder
   * that is itself a Project has its own context folders. Counts accumulate, so
   * a collapsed row already reports its whole subtree.
   *
   * Same action as {@link getAssets} (`project/{id}/get-assets`), menu mode —
   * a sibling method rather than an option, because `getAssets`' flat
   * `AssetDescriptor[]` return is consumed directly by the asset-manager
   * surfaces and must not become a union.
   *
   * READ-ONLY: mints nothing, indexes nothing. A folder whose assets were never
   * indexed counts zero (and its node flags `never_indexed`). Carries no leaves —
   * type rows still load their entities from `/search` on expand.
   *
   * Returns null on a backend that predates menu mode, so callers can fall back.
   */
  async getAssetMenu(options?: ProjectAssetMenuOptions): Promise<ProjectAssetMenu | null> {
    return Project.getAssetMenuById(this.typeId.id, options);
  }

  /** Static form for callers without a Project instance (mirrors `getAssetsById`). */
  static async getAssetMenuById(
    projectId: string,
    options?: ProjectAssetMenuOptions,
  ): Promise<ProjectAssetMenu | null> {
    const actionInfo = new ActionInfo('get-assets', Project.type, projectId, 'GET');
    // Backend kwarg names on the wire (`max_depth`); the SDK option stays
    // camelCase. Arrays are pre-joined — query values are stringified one by one.
    // `assets=false` skips the flat descriptor scan this caller would discard.
    const queryParameters: Record<string, string | number> = { menu: 'true', assets: 'false' };
    if (options?.types?.length) queryParameters.types = options.types.join(',');
    if (options?.recursive === false) queryParameters.recursive = 'false';
    if (options?.maxDepth != null) queryParameters.max_depth = options.maxDepth;
    actionInfo.queryParameters = queryParameters;
    const response = await dataManager.callAction<void, ProjectAssetMenuResponse>(actionInfo);
    return response?.menu ?? null;
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

  /** Clone/materialize the shared project's portable GitOrigin locally. */
  async setupFromGitOrigin(): Promise<Project> {
    const response = await this.post<Project>('setup-from-git');
    return dataManager.updateEntityFromJson<Project>(response as unknown as Record<string, unknown>);
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
    this.adoptContextDirs(await this.post('add-context-dir', { path, scope }));
  }

  /** Clone a git repo and attach it as a context folder, in one call.
   *
   * The branch is always PINNED — to `branch` when given, else to the remote's
   * default. An unpinned origin silently adopts whatever checkout of that URL
   * happens to be on the machine, on any branch.
   *
   * Unlike `addContextDir` this returns a small summary rather than the whole
   * project, so `include_dirs` on this entity is NOT refreshed — refetch the
   * project if a surface renders its context folders. */
  async addContextDirFromGit(
    url: string,
    branch: string = '',
    scope: 'private' | 'shared' = 'private',
  ): Promise<AddContextDirFromGitResult> {
    return this.post<AddContextDirFromGitResult>('add-context-dir-from-git', { url, branch, scope });
  }

  /** Attach a help desk's repo and report the desk it carries.
   *
   * Attaches through `addContextDirFromGit` unchanged — a desk is adopted by
   * being a context folder, not by a separate mechanism — and adds the answer
   * the UI cannot work out for itself: which desk arrived, whether it is the
   * one that will actually serve, and where its portal is.
   *
   * Read `outcome` before saying anything to the user; see
   * {@link AdoptHelpdeskOutcome}. Same `include_dirs` caveat as above. */
  async adoptHelpdeskFromGit(
    url: string,
    branch: string = '',
    scope: 'private' | 'shared' = 'private',
  ): Promise<AdoptHelpdeskResult> {
    return this.post<AdoptHelpdeskResult>('adopt-helpdesk-from-git', { url, branch, scope });
  }

  /** Converge the live content dependencies declared by this Project's
   * `.flowpad/bootstrap.json`. The backend owns clone/link/index idempotency. */
  async reconcileBootstrap(): Promise<ReconcileBootstrapResult> {
    return this.post<ReconcileBootstrapResult>('reconcile-bootstrap');
  }

  /** Get-or-create the `Folder` entity for a directory, WITHOUT attaching it as
   *  a context folder. Folder ids are deterministic (a Folder's id is its origin
   *  key), so this is a safe get-or-create: it never links, never indexes, and
   *  returns the same typeid for the same directory forever. Use it when a
   *  surface needs an entity for a directory the user is merely browsing (e.g.
   *  the Assets header's Share); use `addContextDir` when the folder should
   *  actually join the project's context. */
  async folderForPath(path: string): Promise<{ typeid: string; path: string; origin_kind: string | null }> {
    return this.post('folder-for-path', { path });
  }

  /** Detach a context folder. No-op if not attached. */
  async removeContextDir(path: string): Promise<void> {
    this.adoptContextDirs(await this.post('remove-context-dir', { path }));
  }

  async addSecretPointer(
    name: string,
    envVar: string,
    options: {
      locator: SecretOriginLocator;
      scope?: SecretPointerScope;
      sodStore?: SodStore;
      /** Omit to leave an existing description untouched — re-declaring from a
       *  surface that carries none must not wipe one someone already wrote. */
      description?: string;
    },
  ): Promise<void> {
    const actionInfo = new ActionInfo('add-secret-pointer', Project.type, this.typeId.id, 'POST');
    // The backend builds the value-free locator from the generic ``locator`` dict
    // (any provider kind); ``sod_store`` is where the wizard caches a value.
    actionInfo.bodyParameters = {
      name,
      env_var: envVar,
      scope: options.scope ?? 'private',
      kind: options.locator.kind,
      locator: options.locator,
      ...(options.sodStore ? { sod_store: options.sodStore } : {}),
      ...(options.description !== undefined ? { description: options.description } : {}),
    };
    this.adoptSecretOrigins(await dataManager.callAction(actionInfo));
  }

  /**
   * Declare several secrets in one act.
   *
   * A credential bundles env vars, so adding one is inherently plural. Calling
   * `addSecretPointer` per variable does NOT work: each call mutates the
   * project's context buckets and saves the whole entity, so the second write
   * can land from a copy that predates the first and silently drop its link —
   * the declarations survive as rows while the project forgets them. One call,
   * one save.
   */
  async addSecretPointers(
    pointers: Array<{
      name?: string;
      envVar: string;
      locator: SecretOriginLocator;
      scope?: SecretPointerScope;
      sodStore?: SodStore;
      description?: string;
    }>,
  ): Promise<void> {
    const actionInfo = new ActionInfo('add-secret-pointers', Project.type, this.typeId.id, 'POST');
    actionInfo.bodyParameters = {
      pointers: pointers.map((p) => ({
        name: p.name ?? p.envVar,
        env_var: p.envVar,
        scope: p.scope ?? 'private',
        kind: p.locator.kind,
        locator: p.locator,
        ...(p.sodStore ? { sod_store: p.sodStore } : {}),
        ...(p.description !== undefined ? { description: p.description } : {}),
      })),
    };
    this.adoptSecretOrigins(await dataManager.callAction(actionInfo));
  }

  async removeSecretPointer(typeid: string): Promise<void> {
    this.adoptSecretOrigins(await this.post('remove-secret-pointer', { typeid }));
  }

  /** Value-free per-secret resolve status (available/missing) for the Secrets
   *  card + setup wizard. Never fetches a value. */
  async secretResolveStatus(): Promise<SecretResolveStatus[]> {
    const res = await this.post<{ secrets?: SecretResolveStatus[] }>('secret-resolve-status');
    return Array.isArray(res?.secrets) ? res!.secrets : [];
  }

  /** What is in the project's `.env.local`, and may we write to it?
   *  Names and line numbers only — a value cannot cross this boundary. */
  async envLocalStatus(): Promise<EnvLocalStatus | null> {
    return (await this.post<EnvLocalStatus>('env-local-status')) ?? null;
  }

  /** Which declared secrets hold a different value than when last provided.
   *  Separate from resolveStatus because answering it requires fetching values,
   *  so it runs only when someone is looking at the Secrets tab. */
  async secretDriftStatus(): Promise<SecretDriftStatus[]> {
    const res = await this.post<{ secrets?: SecretDriftStatus[] }>('secret-drift-status');
    return Array.isArray(res?.secrets) ? res!.secrets : [];
  }

  /** Store a secret on the hub, which is the system of record.
   *
   *  Fails with `project_not_published` when the project has no hub row yet —
   *  the caller offers to publish rather than parsing the message. */
  async pushSecretToCloud(envVar: string, value: string): Promise<void> {
    await this.post('push-secret-to-cloud', { env_var: envVar, value });
  }

  /** Delete a secret from the hub — CLOUD ONLY. The local declaration, the
   *  sodot entry and `.env.local` are all deliberately left alone. */
  async deleteSecretFromCloud(envVar: string): Promise<void> {
    await this.post('delete-secret-from-cloud', { env_var: envVar });
  }

  /** Setup wizard: store a user-provided value in the secret's designated SOD
   *  store (sodot or the project .env.local). The value never touches the
   *  reference json or any hub payload. */
  async provideSecret(params: { typeid?: string; envVar?: string; value: string }): Promise<void> {
    const actionInfo = new ActionInfo('provide-secret', Project.type, this.typeId.id, 'POST');
    actionInfo.bodyParameters = {
      ...(params.typeid ? { typeid: params.typeid } : {}),
      ...(params.envVar ? { env_var: params.envVar } : {}),
      value: params.value,
    };
    await dataManager.callAction(actionInfo);
  }

  /** Resolve received shared context folders into receiver-local paths. */
  async resolveContextFolders(): Promise<ProjectContextFolderResolveResult[]> {
    const response = await this.post<ProjectContextFolderResolveResponse>('resolve-context-folders');
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
    agent: SubAgent | null;
    compute_node: ComputeNode | null;
  }> {
    // Hub mode: there is no desktop to wire to — no @local workspace, no
    // @local compute node — and the hub backend doesn't serve the action at
    // all (`project/<id>/setup-for-desktop` → 400 "Post not supported for this
    // path"), which used to make every create-project flow throw after the
    // project was already saved. Same shape as `activateById`/`getComputeNode`:
    // a desk-only step is a no-op on the hub, not an error.
    if (isHubOnly()) return { workspace: null, agent: null, compute_node: null };
    const actionInfo = new ActionInfo('setup-for-desktop', Project.type, this.typeId.id, 'POST');
    const response = await dataManager.callAction<
      void,
      {
        workspace: Workspace | null;
        agent: SubAgent | null;
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
    // Hub mode: `project/<id>/activate` 401s on the hub backend. This is a
    // fire-and-forget recency stamp — safely a no-op when unavailable.
    if (isHubOnly()) return;
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
    const m = this.presence.find((x) => x.member_id === memberId);
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
      if (Array.isArray(result.presence)) this.presence = result.presence as ProjectMember[];
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
    if (result && Array.isArray(result.presence)) {
      this.presence = result.presence as ProjectMember[];
    }
    return this.presence.find((m) => m.member_id === memberId) ?? null;
  }

  /** Presence ping — bumps last_seen_at on the backend. */
  async heartbeatCollaboration(memberId: string): Promise<ProjectMember[] | null> {
    const info = new ActionInfo('heartbeat-collaboration', Project.type, this.typeId.id, 'POST');
    info.bodyParameters = { member_id: memberId };
    const result = await dataManager.callAction<
      { member_id: string },
      { ok: boolean; presence: ProjectMember[] }
    >(info);
    if (result && Array.isArray(result.presence)) {
      this.presence = result.presence;
      return result.presence;
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
    return await this.post<{ project_id: string; deleted_children: number }>('delete-with-children');
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

/**
 * What `POST /project/<id>/deploy` hands back.
 *
 * `deployment` is the placement ROW — the same entity, at the same id, that the
 * local backend has already adopted by the time this resolves. Callers render
 * the persisted Deployment rather than this response: it is a receipt, not the
 * state. Same shape as `AgentDeployResult`, because it is the same verb.
 */
export interface ProjectDeployResult {
  project_id: string;
  deployment?: IDeployment;
  node_typeid?: string;
  host_url?: string;
  reused?: boolean;
}

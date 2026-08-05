import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { ActionInfo } from '../models';
import type { TypeId } from '../models/TypeId';
import { FrontMatterFsRef } from '../fs/FrontMatterFsRef';
import { DockPointerData } from '../models/DockPointer';
import { dataContext } from '../FlowSync/context';
import { AGENT_AVATAR_FILE, AGENT_AVATAR_REF } from './agent-avatar';
import type { IDeployment } from './deployment';

export { AGENT_AVATAR_FILE, AGENT_AVATAR_REF } from './agent-avatar';

/**
 * The launchable agent — identity (name / avatar / system prompt) plus the
 * launch bundle, mirroring `flow_sdk/builtin/agent.py`.
 *
 * NOT a `SubAgent`. That is the provider-owned `.claude/agents/<name>.md`
 * prompt asset Claude Code reads directly; this is the thing that *deploys and
 * runs*, and may delegate to SubAgents by name through `subagents`.
 *
 * Registering this class is load-bearing, not cosmetic: `EntityFactory` drops
 * rows whose constructor is missing (`FlowSync/store.ts` — "Skipping entity,
 * constructor not found for type"), so without it every `agent` row fetched
 * from the backend is silently discarded client-side.
 *
 * **The entity is the source of truth for `agent.md`, not the reverse.** The
 * backend type is `owns_main_ref`, so every `save()` re-renders the file from
 * these fields (`flow_sdk/fs_store/indexer/functions/agent.py:agent_default_body`),
 * preserving the identity capsule. Two consequences for callers:
 *
 *  - Edit fields here and `save()`. Do NOT write the file through
 *    `FrontMatterFsRef.save()` — it reconstructs frontmatter from `name` and
 *    `description` alone and would drop `avatar` and everything else — and do
 *    not write it through the markdown editor's frontmatter buffer, whose
 *    line-regex parser flattens list and nested values.
 *  - `system_prompt` IS the markdown body.
 */
@registerEntity
export class Agent extends APIEntity<Agent> {
  static type: string = 'agent';

  // ── identity / presentation ────────────────────────────────────────────
  name?: string;
  description?: string;
  /** Emoji (`🩺`) or a lucide icon name — the same one-string contract
   *  `IconPicker` stores and `renderIconValue()` renders. */
  avatar?: string | null;
  /** Who this agent is. Delivered to the worker via `context_data.instructions`;
   *  on disk it is the markdown body of `agent.md`. */
  system_prompt?: string;

  // ── launch bundle ──────────────────────────────────────────────────────
  /** The DRIVER short-id an agent.md declares: `claude` | `codex` | `copilot`.
   *  Deliberately NOT the `AgentConfig.WorkerType` vocabulary (`claude_code`),
   *  which is what `AgenticProcess.worker_type` stores. Feeding one where the
   *  other belongs is a real, previously-shipped bug. */
  worker_type?: string;
  /** A tier (`sm`/`md`/`lg`) or a concrete model id. */
  model?: string;
  permission_mode?: string;
  effort?: string;
  max_turns?: number;

  // `null`/undefined is NOT `[]` — an omitted list inherits everything the
  // harness allows, an empty list revokes it. Never normalize one to the other.
  tools?: string[] | null;
  disallowed_tools?: string[] | null;
  skills: string[];
  mcp_servers: string[];
  /** SubAgent NAMES this agent may delegate to. */
  subagents: string[];
  additional_dirs: string[];
  load_flowpad_assistant: boolean;
  /** Vendor-specific launch keys the schema does not enumerate (e.g. Claude's
   *  `chrome: true`). Nested by nature — which is why this type must never be
   *  round-tripped through the markdown frontmatter editor. */
  cli_options: Record<string, unknown>;

  // ── lifecycle ──────────────────────────────────────────────────────────
  enabled: boolean;
  /** Absolute on-disk path to `agent.md`. */
  asset_ref?: string;

  constructor(entity: Partial<Agent> = {}) {
    super(entity);
    this.name = entity.name;
    this.description = entity.description;
    this.avatar = entity.avatar;
    this.system_prompt = entity.system_prompt;

    this.worker_type = entity.worker_type;
    this.model = entity.model;
    this.permission_mode = entity.permission_mode;
    this.effort = entity.effort;
    this.max_turns = entity.max_turns;

    // Preserve the tri-state: absent stays absent, [] stays [].
    this.tools = entity.tools;
    this.disallowed_tools = entity.disallowed_tools;
    this.skills = entity.skills || [];
    this.mcp_servers = entity.mcp_servers || [];
    this.subagents = entity.subagents || [];
    this.additional_dirs = entity.additional_dirs || [];
    this.load_flowpad_assistant = entity.load_flowpad_assistant ?? false;
    this.cli_options = entity.cli_options || {};

    this.enabled = entity.enabled ?? true;
    this.asset_ref = entity.asset_ref;
  }

  /** Default open target: the agent profile editor (URL-first navigate target). */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer('agent') ?? super.dockPointer;
  }

  override get searchDockPointer(): DockPointerData {
    return this.assetEditorPointer('agent') ?? this.dockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.searchDockPointer;
  }

  /**
   * FrontMatterFsRef for `agent.md` — READ-ONLY for this type.
   *
   * Exposed for viewers that want the raw file. Do not `save()` through it:
   * it rebuilds frontmatter from `name`/`description` only, so it would drop
   * every other field. `Agent.save()` is the sanctioned writer.
   */
  get doc(): FrontMatterFsRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId || !this.asset_ref) return null;
    return new FrontMatterFsRef(this.asset_ref, typeId);
  }

  /** Directory containing the portable Agent bundle. */
  get bundleDirectory(): string | null {
    const normalized = this.asset_ref?.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized) return null;
    if (normalized === 'agent.md') return '.';
    if (!normalized.endsWith('/agent.md')) return null;
    return normalized.slice(0, -'/agent.md'.length) || '/';
  }

  /** Resolved carrier path for the canonical portable avatar reference. */
  get avatarAssetRef(): string | null {
    const directory = this.bundleDirectory;
    if (this.avatar !== AGENT_AVATAR_REF || !directory) return null;
    if (directory === '/') return `/${AGENT_AVATAR_FILE}`;
    return `${directory}/${AGENT_AVATAR_FILE}`;
  }

  /**
   * Create an Agent in the selected project, or in user scope when null.
   * Placement remains backend-owned; the optional folder is intentionally
   * reserved for compatibility with the shared Quick Create interface.
   */
  static async createInProject(
    project: { typeId?: TypeId } | null,
    name: string,
    _folderVfsPath?: string,
  ): Promise<Agent> {
    const scopeIds = project?.typeId ? [project.typeId] : [];
    const agent = new Agent({ name: name.trim() });
    return agent.save(scopeIds);
  }

  /**
   * Run this agent once, returning the process that records the run.
   *
   * An ActionInfo rather than a field write — this is a command, not CRUD
   * (the `set-kind` action on SubAgent is the same pattern). The backend
   * routes it to the compute node this agent's deployment places it on, so a
   * remote deployment fails loudly here rather than quietly running on the
   * server.
   */
  async run(prompt: string): Promise<AgentRunResult> {
    const action = new ActionInfo('run', Agent.type, this.id, 'POST');
    action.bodyParameters = { prompt };
    return (await dataManager.callAction(action)) as AgentRunResult;
  }

  /**
   * Give this agent a machine of its own in the cloud.
   *
   * Publishing to the hub is implicit — the backend does it before deploying,
   * so there is no order for a caller to get wrong. It also holds the cloud
   * credentials, which is why this goes through the local backend rather than
   * the browser calling the hub.
   *
   * Slow by nature (create + boot + health on a real sandbox); callers should
   * show progress rather than assume a snappy round trip.
   */
  async deploy(): Promise<AgentDeployResult> {
    const action = new ActionInfo('deploy', Agent.type, this.id, 'POST');
    return (await dataManager.callAction(action)) as AgentDeployResult;
  }
}

/**
 * What `POST /agent/<id>/deploy` hands back.
 *
 * `deployment` is the placement ROW — the same entity, at the same id, that the
 * local backend has already adopted by the time this resolves. Callers render
 * the persisted Deployment rather than this response: it is a receipt, not the
 * state. `agent_definition_error` is present when the box came up but
 * `agent.md` failed to land — a live machine that is not yet the agent.
 */
export interface AgentDeployResult {
  agent_id: string;
  deployment?: IDeployment;
  node_typeid?: string;
  host_url?: string;
  reused?: boolean;
  agent_definition?: string;
  agent_definition_error?: string;
}

/** What `POST /agent/<id>/run` hands back. */
export interface AgentRunResult {
  process_id: string;
  process_typeid: string;
  deployment_id: string;
  compute_node_id: string;
}

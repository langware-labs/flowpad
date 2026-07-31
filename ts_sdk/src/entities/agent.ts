import { APIEntity, registerEntity } from '../APIEntity';
import { FrontMatterFsRef } from '../fs/FrontMatterFsRef';
import { DockPointerData } from '../models/DockPointer';
import { dataContext } from '../FlowSync/context';

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
  avatar?: string;
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
}

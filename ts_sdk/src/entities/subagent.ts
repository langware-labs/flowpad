import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { FrontMatterFsRef } from '../fs/FrontMatterFsRef';
import { ActionInfo } from '../models';
import { DockPointerData } from '../models/DockPointer';
import { dataContext } from '../FlowSync/context';
import { ComputeNodeSize } from './compute-node';
import { ISiteConfig } from './siteconfig';

export const DEFAULT_SEARCH_NUM_RESULTS = 1;
export const DEFAULT_SEARCH_AND_FETCH_RESULTS_MAX_OUTPUT_TOKENS = 5000;
export enum SearchMode {
  FAST = 'fast',
  DEEP = 'deep',
}

export enum CheckpointMode {
  OFF = 'off',
  APPROVE = 'approve',
  AUTO = 'auto',
}

export enum WorkerType {
  AUTO = 'auto',
  PYDANTIC_AI = 'pydantic_ai',
  CLAUDE_CODE = 'claude_code',
  CODEX = 'codex',
  COPILOT = 'copilot',
  OPENCODE = 'opencode',
  SIMPLE = 'simple',
}

/** How an agent asset is used. Mirrors backend `AgentKind`.
 *  - Harness (default): a normal sub-agent run by the CLI harness.
 *  - Vibe: a persona layered on top of the standard vibe agent (embedded after
 *    it, in created-date order, on vibe process start). */
export const AgentKind = {
  Harness: 'harness',
  Vibe: 'vibe',
} as const;
export type AgentKind = (typeof AgentKind)[keyof typeof AgentKind];

export type Model = 'anthropic/claude-sonnet-4.5' | 'openai/gpt-5';

export interface ISearchConfig {
  search_mode: SearchMode;
  num_results: number;
  max_output_tokens?: number;
}

export interface ILLMConfig {
  model?: Model;
}

export interface IAgentConfig {
  search: ISearchConfig;
  llm?: ILLMConfig;
  checkpoint_mode: CheckpointMode;
  worker_type?: WorkerType;
  planning_enabled?: boolean;
  execution_enabled?: boolean;
  machine_size?: ComputeNodeSize;
}

/** Shape of an AgentRecord fetched via fs-records (read-only, from disk). */
export interface IAgentRecord {
  id: string;
  name: string;
  type: string;
  description?: string;
  prompt?: string;
  model?: string;
  permission_mode?: string;
  max_turns?: number;
  tools?: string[];
  path?: string;
  kind?: AgentKind;
}

/**
 * SubAgent entity — backed by a filesystem AgentRecord (.md file).
 *
 * Navigation is entity-centric: searchDockPointer is derived from asset_ref,
 * the canonical on-disk path to the agent's .md file.
 *
 * Legacy cloud fields (site_config, agent_config, histogram, enabled) are kept
 * only for backward compatibility with legacy UI components.
 */
@registerEntity
export class SubAgent extends APIEntity<SubAgent> {
  static type: string = 'subagent';
  name?: string;
  description?: string;

  /** Absolute on-disk path to the agent .md file. */
  asset_ref?: string;

  /** How the agent is used (mirror of backend `SubAgent.kind`). Defaults to
   *  `harness`; `vibe` agents layer onto the standard vibe agent. */
  kind?: AgentKind;

  // Legacy cloud fields — kept for UI compat only
  site_config?: ISiteConfig;
  agent_config?: IAgentConfig;
  histogram: Record<string, Record<string, number>>;
  enabled: boolean;

  constructor(entity: Partial<SubAgent> = {}) {
    super(entity);
    this.name = entity.name;
    this.description = entity.description;
    this.asset_ref = entity.asset_ref;
    this.kind = entity.kind ?? AgentKind.Harness;
    this.histogram = entity.histogram || {};
    this.enabled = entity.enabled ?? true;
    this.agent_config = entity.agent_config;
    this.site_config = entity.site_config;
  }

  /** Default open target: the asset editor (URL-first navigate target). */
  override get dockPointer(): DockPointerData {
    return this.assetEditorPointer('subagent') ?? this.defaultDockPointer;
  }

  override get searchDockPointer(): DockPointerData {
    return this.assetEditorPointer('subagent') ?? this.dockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.searchDockPointer;
  }

  /** FrontMatterFsRef for the agent .md file. */
  get doc(): FrontMatterFsRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId || !this.asset_ref) return null;
    return new FrontMatterFsRef(this.asset_ref, typeId);
  }

  /**
   * Create an agent scoped to the given project (writes to
   * <project>/.claude/agents/<name>.md when project is set, else home).
   */
  static async createInProject(
    project: { typeId?: import('../models/TypeId').TypeId } | null,
    name: string,
    _folderVfsPath?: string,
  ): Promise<SubAgent> {
    const scopeIds = project?.typeId ? [project.typeId] : [];
    const agent = new SubAgent({ name: name.trim() });
    return agent.save(scopeIds);
  }

  /**
   * Set this agent's `kind` (e.g. mark/unmark as a vibe agent). Backed by the
   * `set-kind` action, which rewrites the `.claude/agents/<name>.md` frontmatter
   * server-side preserving every other field, then reindexes — do NOT use
   * entity save/FrontMatterFsRef for this (they'd drop other frontmatter).
   */
  async setKind(kind: AgentKind): Promise<void> {
    await SubAgent.setKindById(this.id, kind);
  }

  /** Set `kind` for an agent by id — for callers that only hold a picked
   *  descriptor's id (e.g. the vibe-agents picker) rather than the entity. */
  static async setKindById(id: string, kind: AgentKind): Promise<void> {
    const action = new ActionInfo('set-kind', SubAgent.type, id, 'POST');
    action.bodyParameters = { kind };
    await dataManager.callAction(action);
  }
}

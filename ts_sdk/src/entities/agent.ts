import { APIEntity, registerEntity } from '../APIEntity';
import { FrontMatterFsRef } from '../fs/FrontMatterFsRef';
import { FSRef } from '../fs/FSRef';
import { DockPointerData } from '../models/DockPointer';
import { ViewType } from '../utils/ui/view-types';
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
  SIMPLE = 'simple',
}

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
}

/**
 * Agent entity — backed by a filesystem AgentRecord (.md file).
 *
 * Navigation is entity-centric: searchDockPointer is derived from asset_folder_ref + name,
 * not from a raw source_path string.
 *
 * Legacy cloud fields (site_config, agent_config, histogram, enabled) are kept
 * only for backward compatibility with legacy UI components.
 */
@registerEntity
export class Agent extends APIEntity<Agent> {
  static type: string = 'agent';
  name?: string;
  description?: string;

  /**
   * FSRef pointing to the folder the agent .md was discovered from.
   * Populated from search results in record-type-nav.ts.
   */
  asset_folder_ref?: FSRef;

  // Legacy cloud fields — kept for UI compat only
  site_config?: ISiteConfig;
  agent_config?: IAgentConfig;
  histogram: Record<string, Record<string, number>>;
  enabled: boolean;

  constructor(entity: Partial<Agent> = {}) {
    super(entity);
    this.name = entity.name;
    this.description = entity.description;
    this.asset_folder_ref = entity.asset_folder_ref;
    this.histogram = entity.histogram || {};
    this.enabled = entity.enabled ?? true;
    this.agent_config = entity.agent_config;
    this.site_config = entity.site_config;
  }

  /** VFS entity sub-path of the .md file, derived from asset_folder_ref + name. */
  private get _mdVfsSubPath(): string | null {
    const afr = this.asset_folder_ref;
    if (afr && this.name) return `${afr.path}/${this.name}.md`;
    return null;
  }

  override get searchDockPointer(): DockPointerData {
    const p = this._mdVfsSubPath;
    if (p) return new DockPointerData(ViewType.ASSETS, `editor/agent/${p}`);
    return this.dockPointer;
  }

  override get editorDockPointer(): DockPointerData {
    return this.searchDockPointer;
  }

  /** FrontMatterFsRef for the agent .md file. */
  get doc(): FrontMatterFsRef | null {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId) return null;
    const p = this._mdVfsSubPath;
    if (!p) return null;
    return new FrontMatterFsRef(p, typeId);
  }

  /**
   * Create an agent scoped to the given project (writes to
   * <project>/.claude/agents/<name>.md when project is set, else home).
   */
  static async createInProject(
    project: { typeId?: import('../models/TypeId').TypeId } | null,
    name: string,
    _folderVfsPath?: string,
  ): Promise<Agent> {
    const scopeIds = project?.typeId ? [project.typeId] : [];
    const agent = new Agent({ name: name.trim() });
    return agent.save(scopeIds);
  }
}

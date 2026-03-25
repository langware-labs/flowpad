import { APIEntity, registerEntity } from '../APIEntity';
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
 * Cloud-only fields (site_config, agent_config, histogram) are kept only for
 * backward compatibility with legacy UI components.
 */
@registerEntity
export class Agent extends APIEntity<Agent> {
  static type: string = 'agent';
  name?: string;
  description?: string;

  // Legacy cloud fields — kept for UI compat only
  site_config?: ISiteConfig;
  agent_config?: IAgentConfig;
  histogram: Record<string, Record<string, number>>;
  enabled: boolean;

  constructor(entity: Partial<Agent> = {}) {
    super(entity);
    this.name = entity.name;
    this.description = entity.description;
    this.histogram = entity.histogram || {};
    this.enabled = entity.enabled ?? true;
    this.agent_config = entity.agent_config;
    this.site_config = entity.site_config;
  }

}

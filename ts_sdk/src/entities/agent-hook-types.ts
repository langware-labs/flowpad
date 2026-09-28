/**
 * The wire shape of an agent hook row, separate from the AgentHook class that hydrates it.
 * See the layering rule in `entities/compute-node/compute-node-types.ts`.
 */
import { IEntity } from '../IEntity';
import { AgentProvider, HookScope } from './agent-hook-enums';

export interface IAgentHook extends IEntity {
  name: string;
  description?: string;
  provider: AgentProvider;
  hook_scope: HookScope;
  event: string;
  command?: string;
  matcher?: Record<string, any>;
  enabled?: boolean;
  hook_file_vfs?: string;
  entry_index?: number;
  project_id?: string;
}

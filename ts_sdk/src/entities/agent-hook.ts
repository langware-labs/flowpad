import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { QueryRequest } from '../FlowSync/query';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { HttpMethod } from '../models/ApiUrl';
import { TypeId } from '../models/TypeId';
import { AgentProvider, HookScope, RelationshipSubAction } from './agent-hook-enums';
import { Trigger } from './trigger';

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

/**
 * Entity representing a provider-agnostic agent hook configuration
 */
@registerEntity
export class AgentHook extends APIEntity<AgentHook> implements IAgentHook {
  static type: string = 'agent_hook';

  name: string = '';
  description?: string;
  provider: AgentProvider = AgentProvider.CLAUDE_CODE;
  hook_scope: HookScope = HookScope.USER;
  event: string = '';
  command?: string;
  matcher?: Record<string, any>;
  enabled: boolean = true;
  hook_file_vfs?: string;
  entry_index: number = 0;
  project_id?: string;

  constructor(entity: Partial<IAgentHook> = {}) {
    super(entity);
    this.name = entity.name || '';
    this.description = entity.description;
    this.provider = entity.provider || AgentProvider.CLAUDE_CODE;
    this.hook_scope = entity.hook_scope || HookScope.USER;
    this.event = entity.event || '';
    this.command = entity.command;
    this.matcher = entity.matcher;
    this.enabled = entity.enabled !== undefined ? entity.enabled : true;
    this.hook_file_vfs = entity.hook_file_vfs;
    this.entry_index = entity.entry_index || 0;
    this.project_id = entity.project_id;
  }

  /**
   * List all agent hooks
   */
  static async list(): Promise<AgentHook[]> {
    const request = new QueryRequest({
      type: AgentHook.type,
      query: null,
      scope: [],
    });
    return await AgentHook.query(request, true); // invalidate cache to get fresh data
  }

  /**
   * Get all triggers connected to this agent hook
   */
  async getTriggers(): Promise<Trigger[]> {
    if (!this.id) {
      throw new Error('Cannot get triggers for unsaved AgentHook');
    }

    const action = new ActionInfo('trigger_action', AgentHook.type, this.id, 'GET' as HttpMethod);
    const response = await dataManager.callAction<undefined, Trigger[]>(action);

    if (response && Array.isArray(response)) {
      return response.map((data: any) => {
        // Ensure triggers are properly cached - use cached version if available, otherwise register new one
        const cached = Trigger.getByIdFromCache(data.id);
        if (cached) {
          // Update cached entity with latest data
          dataManager.deepAssign(cached, data);
          return cached;
        }
        // Create new instance (constructor will register it in cache)
        return new Trigger(data);
      });
    }
    return [];
  }

  /**
   * Connect a trigger to this agent hook
   */
  async addTrigger(trigger: Trigger | TypeId): Promise<void> {
    if (!this.id) {
      throw new Error('Cannot add trigger to unsaved AgentHook');
    }

    const triggerId = trigger instanceof Trigger ? trigger.id : trigger.id;
    if (!triggerId) {
      throw new Error('Cannot add trigger without ID');
    }

    const action = new ActionInfo('trigger_action', AgentHook.type, this.id, 'POST' as HttpMethod);
    action.subpath = RelationshipSubAction.ADD;
    action.bodyParameters = {
      trigger_id: { type: Trigger.type, id: triggerId },
    };
    await dataManager.callAction(action);
  }

  /**
   * Disconnect a trigger from this agent hook
   */
  async removeTrigger(trigger: Trigger | TypeId): Promise<void> {
    if (!this.id) {
      throw new Error('Cannot remove trigger from unsaved AgentHook');
    }

    const triggerId = trigger instanceof Trigger ? trigger.id : trigger.id;
    if (!triggerId) {
      throw new Error('Cannot remove trigger without ID');
    }

    const action = new ActionInfo('trigger_action', AgentHook.type, this.id, 'POST' as HttpMethod);
    action.subpath = RelationshipSubAction.REMOVE;
    action.bodyParameters = {
      trigger_id: { type: Trigger.type, id: triggerId },
    };
    await dataManager.callAction(action);
  }
}

import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { QueryRequest } from '../FlowSync/query';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { HttpMethod } from '../models/ApiUrl';
import { TypeId } from '../models/TypeId';
import { HookEventData, TriggerAction, RelationshipSubAction } from './agent-hook-enums';
import { AgentHook } from './agent-hook';

export interface ITrigger extends IEntity {
  name: string;
  description?: string;
  trigger_type?: 'hook' | 'schedule';
  // Hook trigger fields
  mask: Record<string, any>;
  action: TriggerAction;
  enabled?: boolean;
  last_triggered?: Date;
  counter?: number;
  scope?: string;
  hook_events?: string[];
  log_mode?: string;
  path?: string;
  // Schedule trigger fields
  expr?: string;
  sched_trigger_type?: 'cron' | 'interval' | 'date';
  next_run?: Date;
  last_run?: Date;
}

/**
 * Entity representing a trigger that matches hook data and executes actions
 */
@registerEntity
export class Trigger extends APIEntity<Trigger> implements ITrigger {
  static type: string = 'trigger';

  name: string = '';
  description?: string;
  trigger_type: 'hook' | 'schedule' = 'hook';
  // Hook trigger fields
  mask: Record<string, any> = {};
  action: TriggerAction;
  enabled: boolean = true;
  last_triggered?: Date;
  counter: number = 0;
  scope: string = 'system';
  hook_events: string[] = [];
  log_mode: string = 'activations';
  path?: string;
  // Schedule trigger fields
  expr?: string;
  sched_trigger_type?: 'cron' | 'interval' | 'date';
  next_run?: Date;
  last_run?: Date;

  constructor(entity: Partial<ITrigger> = {}) {
    super(entity);
    this.name = entity.name || '';
    this.description = entity.description;
    this.trigger_type = entity.trigger_type || 'hook';
    this.mask = entity.mask || {};
    this.action = entity.action || { action_type: 'nop' as any };
    this.enabled = entity.enabled !== undefined ? entity.enabled : true;
    this.last_triggered = entity.last_triggered;
    this.counter = entity.counter ?? 0;
    this.scope = entity.scope || 'system';
    this.hook_events = entity.hook_events || [];
    this.log_mode = entity.log_mode || 'activations';
    this.path = entity.path;
    this.expr = entity.expr;
    this.sched_trigger_type = entity.sched_trigger_type;
    this.next_run = entity.next_run;
    this.last_run = entity.last_run;
  }

  /**
   * Discover all activation rules from the filesystem and sync them as Trigger entities.
   * Calls GET /api/v1/graph/trigger/discover
   */
  static async discover(): Promise<Trigger[]> {
    const action = new ActionInfo('discover', Trigger.type, null, 'GET' as HttpMethod);
    const response = await dataManager.callAction<undefined, ITrigger[]>(action);
    return (response as ITrigger[] || []).map((d) => new Trigger(d));
  }

  /**
   * List all triggers
   */
  static async list(): Promise<Trigger[]> {
    const request = new QueryRequest({
      type: Trigger.type,
      query: null,
      scope: [],
    });
    return await Trigger.query(request, true); // invalidate cache to get fresh data
  }

  /**
   * Check if the hook data matches this trigger's mask
   *
   * Uses simple key-value matching. All key-value pairs in the mask must
   * exactly match the corresponding fields in the hook data.
   */
  match(hookData: HookEventData): boolean {
    if (!this.enabled) {
      return false;
    }

    for (const [key, expectedValue] of Object.entries(this.mask)) {
      const actualValue = (hookData as any)[key];

      if (actualValue === undefined) {
        return false;
      }

      if (actualValue !== expectedValue) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get all agent hooks connected to this trigger
   */
  async getAgentHooks(): Promise<AgentHook[]> {
    if (!this.id) {
      throw new Error('Cannot get agent hooks for unsaved Trigger');
    }

    const action = new ActionInfo('agent_hook', Trigger.type, this.id, 'GET' as HttpMethod);
    const response = await dataManager.callAction<undefined, AgentHook[]>(action);

    if (response && Array.isArray(response)) {
      return response.map((data: any) => new AgentHook(data));
    }
    return [];
  }

  /**
   * Connect this trigger to an agent hook
   */
  async connectToAgentHook(agentHook: AgentHook | TypeId): Promise<void> {
    if (!this.id) {
      throw new Error('Cannot connect unsaved Trigger');
    }

    const hookId = agentHook instanceof AgentHook ? agentHook.id : agentHook.id;
    if (!hookId) {
      throw new Error('Cannot connect to AgentHook without ID');
    }

    const action = new ActionInfo('agent_hook', Trigger.type, this.id, 'POST' as HttpMethod);
    action.subpath = RelationshipSubAction.ADD;
    action.bodyParameters = {
      agent_hook_id: { type: AgentHook.type, id: hookId },
    };
    await dataManager.callAction(action);
  }

  /**
   * Disconnect this trigger from an agent hook
   */
  async disconnectFromAgentHook(agentHook: AgentHook | TypeId): Promise<void> {
    if (!this.id) {
      throw new Error('Cannot disconnect unsaved Trigger');
    }

    const hookId = agentHook instanceof AgentHook ? agentHook.id : agentHook.id;
    if (!hookId) {
      throw new Error('Cannot disconnect from AgentHook without ID');
    }

    const action = new ActionInfo('agent_hook', Trigger.type, this.id, 'POST' as HttpMethod);
    action.subpath = RelationshipSubAction.REMOVE;
    action.bodyParameters = {
      agent_hook_id: { type: AgentHook.type, id: hookId },
    };
    await dataManager.callAction(action);
  }
}

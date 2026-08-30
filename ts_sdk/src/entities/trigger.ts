import type { EntityMerge } from '../IEntity';
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
  trigger_type?: 'hook' | 'schedule' | 'fsop';
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
  instruction?: string;
  workdir?: string;
  project_id?: string | null;
  // FSOp trigger fields
  watch_path?: string;
  recursive?: boolean;
  watch_glob?: string;
  last_seen_mtime?: number;
  last_seen_size?: number;
}

// `implements ITrigger` only checks the class; it contributes no members, so every
// field declared solely on ITrigger read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Trigger extends EntityMerge<ITrigger> {}

/**
 * Entity representing a trigger that matches hook data and executes actions
 */
@registerEntity
export class Trigger extends APIEntity<Trigger> implements ITrigger {
  static type: string = 'trigger';

  name: string = '';
  description?: string;
  trigger_type: 'hook' | 'schedule' | 'fsop' = 'hook';
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
  instruction?: string;
  workdir?: string;
  project_id?: string | null;
  // FSOp trigger fields
  watch_path?: string;
  recursive?: boolean;
  watch_glob?: string;
  last_seen_mtime?: number;
  last_seen_size?: number;

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
    this.instruction = entity.instruction;
    this.workdir = entity.workdir;
    this.project_id = entity.project_id ?? null;
    this.watch_path = entity.watch_path;
    this.recursive = entity.recursive;
    this.watch_glob = entity.watch_glob;
    this.last_seen_mtime = entity.last_seen_mtime;
    this.last_seen_size = entity.last_seen_size;
  }

  /**
   * Fire this trigger immediately. For schedule triggers, runs the same
   * code path APScheduler would run (incl. spawning the agentic process
   * if `instruction` is set).
   */
  async runNow(): Promise<{ status: string; counter: number }> {
    if (!this.id) {
      throw new Error('Cannot run unsaved Trigger');
    }
    const action = new ActionInfo('test', Trigger.type, this.id, 'POST' as HttpMethod);
    const response = await dataManager.callAction<undefined, { status: string; counter: number }>(action);
    return response as { status: string; counter: number };
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

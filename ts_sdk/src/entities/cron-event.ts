import type { EntityMerge } from '../IEntity';
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { QueryRequest } from '../FlowSync/query';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { HttpMethod } from '../models/ApiUrl';

export interface ICronEvent extends IEntity {
  name: string;
  description?: string;
  expr: string;
  trigger_type?: string;
  enabled?: boolean;
  counter?: number;
  last_run?: Date;
  next_run?: Date;
}

// `implements ICronEvent` only checks the class; it contributes no members, so every
// field declared solely on ICronEvent read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CronEvent extends EntityMerge<ICronEvent> {}

/**
 * Scheduled job entity backed by APScheduler
 */
@registerEntity
export class CronEvent extends APIEntity<CronEvent> implements ICronEvent {
  static type: string = 'cron_event';

  name: string = '';
  description?: string;
  expr: string = '* * * * *';
  trigger_type: string = 'cron';
  enabled: boolean = true;
  counter: number = 0;
  last_run?: Date;
  next_run?: Date;

  constructor(entity: Partial<ICronEvent> = {}) {
    super(entity);
    this.name = entity.name || '';
    this.description = entity.description;
    this.expr = entity.expr || '* * * * *';
    this.trigger_type = entity.trigger_type || 'cron';
    this.enabled = entity.enabled !== undefined ? entity.enabled : true;
    this.counter = entity.counter ?? 0;
    this.last_run = entity.last_run;
    this.next_run = entity.next_run;
  }

  /**
   * List all cron events (triggers APScheduler sync on backend)
   */
  static async list(): Promise<CronEvent[]> {
    const request = new QueryRequest({
      type: CronEvent.type,
      query: null,
      scope: [],
    });
    return await CronEvent.query(request, true);
  }

  /**
   * Create a new cron event
   */
  static async create(data: Partial<ICronEvent>): Promise<CronEvent> {
    const action = new ActionInfo('create', CronEvent.type, null, 'POST' as HttpMethod);
    action.bodyParameters = data as Record<string, unknown>;
    const response = await dataManager.callAction<Record<string, unknown>, ICronEvent>(action);
    return new CronEvent(response as ICronEvent);
  }

  /**
   * Update this cron event
   */
  async updateFields(data: Partial<ICronEvent>): Promise<CronEvent> {
    if (!this.id) {
      throw new Error('Cannot update unsaved CronEvent');
    }
    const action = new ActionInfo('update', CronEvent.type, this.id, 'PUT' as HttpMethod);
    action.bodyParameters = data as Record<string, unknown>;
    const response = await dataManager.callAction<Record<string, unknown>, ICronEvent>(action);
    return new CronEvent(response as ICronEvent);
  }

  /**
   * Delete this cron event
   */
  async remove(): Promise<void> {
    if (!this.id) {
      throw new Error('Cannot delete unsaved CronEvent');
    }
    const action = new ActionInfo('delete', CronEvent.type, this.id, 'DELETE' as HttpMethod);
    await dataManager.callAction(action);
  }

  /**
   * Fire this cron job immediately (test mode)
   */
  async test(): Promise<{ status: string; counter: number }> {
    if (!this.id) {
      throw new Error('Cannot test unsaved CronEvent');
    }
    const action = new ActionInfo('test', CronEvent.type, this.id, 'POST' as HttpMethod);
    const response = await dataManager.callAction<undefined, { status: string; counter: number }>(action);
    return response as { status: string; counter: number };
  }
}

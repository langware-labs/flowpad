import { dataManager } from '../APIEntity';
import { dataContext } from '../FlowSync';
import { AgentHook } from '../entities/agent-hook';
import { ActionInfo } from '../models/ActionInfo';
import { HttpMethod } from '../models/ApiUrl';
import { TypeId } from '../FlowSync';
import type { HooksSnifferStatus } from './hooksSnifferService';
import { SnifferHook } from './sniffer-hook';

const HOOKS_SNIFFER_ACTION = 'hooks-sniffer';

class SnifferManager {
  private _entity: AgentHook | null = null;
  private _unwatch: (() => Promise<void>) | null = null;

  get entity(): AgentHook | null {
    return this._entity;
  }

  /**
   * Register entity in cache, await watch, set dataContext.
   * Called from bootstrap (main.ts) and enable().
   */
  async attach(entity: AgentHook): Promise<void> {
    if (this._unwatch) {
      await this._unwatch();
      this._unwatch = null;
    }
    this._entity = entity;
    // Register so dataManager.getByTypeIdFromCache() finds it by UUID typeId
    const ref = dataManager.getRef(new TypeId(AgentHook.type, entity.id));
    ref.entity = entity as any;
    this._unwatch = await entity.watch();
    dataContext.setSnifferHook(new SnifferHook(entity));
  }

  async fetchStatus(): Promise<void> {
    const action = new ActionInfo(HOOKS_SNIFFER_ACTION, null, null, 'GET' as HttpMethod);
    const response = await dataManager.callAction<undefined, HooksSnifferStatus>(action);
    const status = response || { enabled: false };
    dataContext.setSnifferEnabled(status.enabled);
  }

  async enable(): Promise<HooksSnifferStatus> {
    const action = new ActionInfo(HOOKS_SNIFFER_ACTION, null, null, 'POST' as HttpMethod);
    const response = await dataManager.callAction<undefined, HooksSnifferStatus>(action);
    const status = response || { enabled: false };
    if (status.hook_id) {
      const existing = AgentHook.getByIdFromCache(status.hook_id) as AgentHook | undefined;
      const entity = existing ?? new AgentHook({ id: status.hook_id, name: 'Hooks Sniffer' });
      await this.attach(entity);
    }
    dataContext.setSnifferEnabled(status.enabled);
    return status;
  }

  async disable(): Promise<HooksSnifferStatus> {
    const action = new ActionInfo(HOOKS_SNIFFER_ACTION, null, null, 'DELETE' as HttpMethod);
    const response = await dataManager.callAction<undefined, HooksSnifferStatus>(action);
    const status = response || { enabled: false };
    if (this._unwatch) {
      await this._unwatch();
      this._unwatch = null;
    }
    this._entity?.flowDataStream.clear();
    this._entity = null;
    dataContext.setSnifferEnabled(status.enabled);
    dataContext.setSnifferHook(null);
    return status;
  }
}

export const snifferManager = new SnifferManager();

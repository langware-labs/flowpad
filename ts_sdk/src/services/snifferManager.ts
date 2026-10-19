import { dataManager } from '../APIEntity';
import { dataContext } from '../FlowSync';
import { AgentHook } from '../entities/agent-hook';
import { ActionInfo } from '../models/ActionInfo';
import { HttpMethod } from '../models/ApiUrl';
import { TypeId } from '../FlowSync';
import { HOOKS_SNIFFER_ACTION, type HooksSnifferStatus } from './hooksSnifferService';
import { SnifferHook } from './sniffer-hook';
import type { DeferredInfo } from '../models/BootstrapInfo';


/** The user's last explicit sniffer decision. `null` = never decided, so the
 *  backend state stands. Owned here so every surface that flips the sniffer
 *  (settings toggle, startup notification, warnings popover) records the same
 *  decision — a stale `true` is what silently re-installs the hooks on boot. */
const SNIFFER_ENABLED_STORAGE_KEY = 'flowpad.snifferEnabled';

export function loadSnifferPreference(): boolean | null {
  try {
    const stored = localStorage.getItem(SNIFFER_ENABLED_STORAGE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch {
    // ignore — no storage (SSR / privacy mode)
  }
  return null;
}

export function saveSnifferPreference(enabled: boolean): void {
  try {
    localStorage.setItem(SNIFFER_ENABLED_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // ignore
  }
}

class SnifferManager {
  private _entity: AgentHook | null = null;
  private _unwatch: (() => Promise<void>) | null = null;
  private _revision = 0;

  get revision(): number {
    return this._revision;
  }

  get entity(): AgentHook | null {
    return this._entity;
  }

  /** Best-effort: once the hook entity is gone server-side the unwatch call
   *  404s, and a rejected teardown must never strand the caller mid-toggle. */
  private async _releaseWatch(): Promise<void> {
    const unwatch = this._unwatch;
    this._unwatch = null;
    if (!unwatch) return;
    try {
      await unwatch();
    } catch (e) {
      console.warn('[sniffer] unwatch failed (entity already gone?)', e);
    }
  }

  /**
   * Register entity in cache, await watch, set dataContext.
   * Explicit attachments supersede any pending discovery snapshot.
   */
  async attach(entity: AgentHook): Promise<void> {
    await this._attach(entity, ++this._revision);
  }

  private async _attach(entity: AgentHook, revision: number): Promise<void> {
    await this._releaseWatch();
    if (revision !== this._revision) return;
    this._entity = entity;
    // Register so dataManager.getByTypeIdFromCache() finds it by UUID typeId
    const ref = dataManager.getRef(new TypeId(AgentHook.type, entity.id));
    ref.entity = entity as any;
    const unwatch = await entity.watch();
    if (revision !== this._revision) {
      await unwatch().catch((error) => console.warn('[sniffer] stale watch cleanup failed', error));
      return;
    }
    this._unwatch = unwatch;
    dataContext.setSnifferHook(new SnifferHook(entity));
  }

  /** A slow startup snapshot must never undo a later user command. */
  async seed(info: Pick<DeferredInfo, 'sniffer_hook' | 'sniffer_installed'>, revision = this._revision): Promise<void> {
    if (revision !== this._revision) return;
    if (info.sniffer_installed == null && !info.sniffer_hook) return;
    if (info.sniffer_hook) {
      const hook = new AgentHook(info.sniffer_hook);
      hook.markAsExpanded();
      await this._attach(hook, revision);
    }
    if (revision !== this._revision) return;
    dataContext.setSnifferEnabled(!!info.sniffer_hook);
    if (info.sniffer_installed != null) dataContext.setSnifferInstalled(info.sniffer_installed);
    dataContext.setSnifferReady(true);
    window.sniffer = this._entity;
  }

  async fetchStatus(): Promise<void> {
    const revision = ++this._revision;
    const action = new ActionInfo(HOOKS_SNIFFER_ACTION, null, null, 'GET' as HttpMethod);
    const response = await dataManager.callAction<undefined, HooksSnifferStatus>(action);
    const status = response || { enabled: false };
    if (revision !== this._revision) return;
    dataContext.setSnifferEnabled(status.enabled);
    dataContext.setSnifferInstalled(!!status.installed);
    dataContext.setSnifferReady(true);
  }

  async enable(): Promise<HooksSnifferStatus> {
    const revision = ++this._revision;
    const action = new ActionInfo(HOOKS_SNIFFER_ACTION, null, null, 'POST' as HttpMethod);
    const response = await dataManager.callAction<undefined, HooksSnifferStatus>(action);
    const status = response || { enabled: false };
    if (revision !== this._revision) return status;
    if (status.hook_id) {
      const existing = AgentHook.getByIdFromCache(status.hook_id) as AgentHook | undefined;
      const entity = existing ?? new AgentHook({ id: status.hook_id, name: 'Hooks Sniffer' });
      await this._attach(entity, revision);
    }
    if (revision !== this._revision) return status;
    dataContext.setSnifferEnabled(status.enabled);
    dataContext.setSnifferInstalled(!!status.installed);
    dataContext.setSnifferReady(true);
    saveSnifferPreference(true);
    return status;
  }

  async disable(): Promise<HooksSnifferStatus> {
    const revision = ++this._revision;
    const action = new ActionInfo(HOOKS_SNIFFER_ACTION, null, null, 'DELETE' as HttpMethod);
    const response = await dataManager.callAction<undefined, HooksSnifferStatus>(action);
    const status = response || { enabled: false };
    if (revision !== this._revision) return status;
    await this._releaseWatch();
    if (revision !== this._revision) return status;
    this._entity?.flowDataStream.clear();
    this._entity = null;
    dataContext.setSnifferEnabled(status.enabled);
    dataContext.setSnifferInstalled(!!status.installed);
    dataContext.setSnifferHook(null);
    dataContext.setSnifferReady(true);
    saveSnifferPreference(false);
    return status;
  }
}

export const snifferManager = new SnifferManager();

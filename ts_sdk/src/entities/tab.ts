import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models';
import { QueryRequest } from '../FlowSync/query';

/**
 * Tab — the frontend mirror of the DB-only backend ``Tab`` entity
 * (flow_sdk/builtin/tab.py, docs/tab-management.md).
 *
 * A tab is a first-class placement row keyed by a hash of the DockPointer it
 * opens (``pointer`` == ``DockPointer.tabHash``). Every ``openDock`` ensures one
 * exists and is visible; closing flips ``visible=false`` (soft — the row
 * survives and the change broadcasts cross-client). The strip is one live query
 * of ``visible=true`` Tabs.
 *
 * Identity/dedup is the ``pointer`` field — ``ensureFor`` reconciles by querying
 * it, so two opens of the same pointer reuse one row regardless of which side
 * (frontend uuid4 / backend uuid5) minted the id. Active-tab is NOT a field
 * here: it stays URL-first/per-client (a synced active flag would yank focus
 * across clients).
 */
export interface ITab extends IEntity {
  /** Canonical DockPointer serialization — the natural key (DockPointer.tabHash). */
  pointer?: string;
  /** Denormalized target identity (off the pointer) for fast reverse lookup. */
  target_type?: string | null;
  target_id?: string | null;
  /** Visibility = membership. Non-null; a close broadcasts ``visible=false``. */
  visible?: boolean;
  /** name / project_id / tab_order / last_active_at come from IEntity. */
}

export interface IEnsureTabOpts {
  targetType?: string | null;
  targetId?: string | null;
  projectId?: string | null;
  name?: string | null;
}

@registerEntity
export class Tab extends APIEntity<Tab> implements ITab {
  static type: string = 'tab';

  pointer: string = '';
  target_type: string | null = null;
  target_id: string | null = null;
  visible: boolean = true;
  name: string | null = null;
  project_id: string | null = null;
  tab_order: number = 0;
  last_active_at: number | string | null = null;

  /**
   * Get-or-create the tab for a canonical pointer, and ensure it is visible.
   *
   * Dedup is by the ``pointer`` field (queried each call) — not by id-version —
   * so a reopen reuses the one row and re-shows a soft-closed tab. The denorm
   * target/project hints are refreshed; ``name`` is never clobbered with null
   * (a user-pinned rename survives).
   */
  static async ensureFor(pointer: string, opts: IEnsureTabOpts = {}): Promise<Tab> {
    const existing = await Tab.findByPointer(pointer);
    if (existing) {
      let dirty = false;
      if (!existing.visible) {
        existing.visible = true;
        dirty = true;
      }
      if (opts.targetType != null && existing.target_type !== opts.targetType) {
        existing.target_type = opts.targetType;
        dirty = true;
      }
      if (opts.targetId != null && existing.target_id !== opts.targetId) {
        existing.target_id = opts.targetId;
        dirty = true;
      }
      if (opts.projectId != null && existing.project_id !== opts.projectId) {
        existing.project_id = opts.projectId;
        dirty = true;
      }
      // name is a CREATE-only initial label (getTabName) — never overwrite an
      // existing row's name on reuse, so a user rename survives re-navigation.
      if (dirty) await existing.save();
      return existing;
    }
    const tab = new Tab({
      pointer,
      target_type: opts.targetType ?? null,
      target_id: opts.targetId ?? null,
      project_id: opts.projectId ?? null,
      name: opts.name ?? null,
      visible: true,
    } as Partial<ITab>);
    await tab.save();
    return tab;
  }

  /** Resolve the (at most one) Tab for a pointer. ``query`` reads the live
   *  cache before round-tripping, so a just-created row is found locally. */
  static async findByPointer(pointer: string): Promise<Tab | null> {
    const rows = await Tab.query<Tab>(
      new QueryRequest({ type: Tab.type, query: { match: { pointer } } as any }),
    );
    return rows[0] ?? null;
  }

  /**
   * Soft-close via the backend action (POST /graph/tab/<id>/close): the backend
   * flips ``visible=false`` and dispatches PTY/worker teardown by target_type.
   * Teardown is headless-owned, so close must round-trip — never just a local
   * ``visible=false``.
   */
  async closeTab(): Promise<void> {
    const action = new ActionInfo('close', Tab.type, this.id, 'POST');
    await dataManager.callAction<unknown, unknown>(action);
    this.visible = false;
  }

  /**
   * Rename via the backend action (POST /graph/tab/<id>/rename {name}). ``Tab.name``
   * is the generic source of truth; the backend reflects the rename onto the target
   * entity via the ``tab-renamed`` event bus (shell/AP mirror it + send PTY /rename).
   */
  async rename(name: string): Promise<void> {
    const action = new ActionInfo('rename', Tab.type, this.id, 'POST');
    action.bodyParameters = { name };
    await dataManager.callAction<{ name: string }, unknown>(action);
    this.name = name;
  }

  constructor(entity: Partial<ITab> = {}) {
    super(entity as IEntity);
    Object.assign(this, entity);
  }
}

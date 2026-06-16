import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models';

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
  /**
   * Display primitives the strip draws straight off the Tab (no Shell/AP fetch).
   * Both CREATE-only + static: ``icon_key`` is the resolved provider kind
   * (`shell`/`claude`/`codex`/`copilot`), ``worktree`` drives the badge.
   * (Named ``icon_key`` not ``icon`` — the base entity owns an ``icon`` getter.)
   */
  icon_key?: string | null;
  worktree?: boolean;
  /** name / project_id / tab_order / last_active_at come from IEntity. */
}

export interface IEnsureTabOpts {
  targetType?: string | null;
  targetId?: string | null;
  projectId?: string | null;
  name?: string | null;
  iconKey?: string | null;
  worktree?: boolean;
}

export interface INewTabOpts extends IEnsureTabOpts {
  /** The opener (current active tab id): a fresh tab lands right after it. */
  afterTabId?: string | null;
}

/**
 * One fully-resolved strip row, as the backend `list`/`new_tab`/`order`/`close`
 * actions return it (flow_sdk/builtin/tab.py `_serialize_row`). The strip renders
 * straight off these — order, label, icon and live status are all backend-owned;
 * the frontend never re-derives order from entities.
 */
export interface TabRow {
  id: string;
  pointer: string;
  target_type: string | null;
  target_id: string | null;
  project_id: string | null;
  name: string | null;
  icon_key: string | null;
  worktree: boolean;
  tab_order: number;
  last_active_at: number | string | null;
  status: string | null;
  is_disabled: boolean;
}

@registerEntity
export class Tab extends APIEntity<Tab> implements ITab {
  static type: string = 'tab';

  pointer: string = '';
  target_type: string | null = null;
  target_id: string | null = null;
  visible: boolean = true;
  icon_key: string | null = null;
  worktree: boolean = false;
  name: string | null = null;
  project_id: string | null = null;
  tab_order: number = 0;
  last_active_at: number | string | null = null;

  // ── Backend-owned ordered list (the single render source) ───────────────────
  // These call the collection-level `tab` actions (no entity id) and return the
  // canonical, project-filtered, ordered rows. The frontend renders them as-is.

  /** GET /graph/tab/list?project=<id> — the deterministic ordered render list for
   *  one project view (projectless tabs inline). `null` ⇒ no active project. */
  static async list(projectId: string | null = null): Promise<TabRow[]> {
    const info = new ActionInfo('list', Tab.type, null, 'GET');
    info.queryParameters = { project: projectId ?? '' };
    const res = await dataManager.callAction<undefined, { tabs: TabRow[] }>(info);
    return res?.tabs ?? [];
  }

  /** POST /graph/tab/new_tab — loader-driven get-or-create. A fresh tab lands
   *  right after `opts.afterTabId` (the opener); reopen keeps its slot. Returns
   *  the updated list. */
  static async newTab(pointer: string, opts: INewTabOpts = {}): Promise<TabRow[]> {
    const info = new ActionInfo('new_tab', Tab.type, null, 'POST');
    info.bodyParameters = {
      pointer,
      target_type: opts.targetType ?? null,
      target_id: opts.targetId ?? null,
      project_id: opts.projectId ?? null,
      name: opts.name ?? null,
      icon_key: opts.iconKey ?? null,
      worktree: opts.worktree ?? false,
      after_tab_id: opts.afterTabId ?? null,
    };
    const res = await dataManager.callAction<unknown, { tabs: TabRow[] }>(info);
    return res?.tabs ?? [];
  }

  /** GET /graph/tab/list_all — EVERY visible Tab (any kind, ALL projects), fully
   *  resolved, in global order. The single unscoped projection that the developer
   *  sessions view + footer projects-chip read; replaces the old reactive
   *  `tab?visible=true` entity query. (Project-scoped views use `list`.) */
  static async listAll(): Promise<TabRow[]> {
    const info = new ActionInfo('list_all', Tab.type, null, 'GET');
    const res = await dataManager.callAction<undefined, { tabs: TabRow[] }>(info);
    return res?.tabs ?? [];
  }

  /** POST /graph/tab/order — drag-drop commit. Splices `reorderId` into the
   *  drop-gap (after `afterId` / before `beforeId`) within the global order and
   *  returns the updated project-filtered list. No-op ⇒ unchanged list. */
  static async reorder(
    reorderId: string,
    afterId: string | null,
    beforeId: string | null,
    projectId: string | null = null,
  ): Promise<TabRow[]> {
    const info = new ActionInfo('order', Tab.type, null, 'POST');
    info.bodyParameters = {
      reorder_tab_id: reorderId,
      after_tab_id: afterId,
      before_tab_id: beforeId,
      project: projectId ?? '',
    };
    const res = await dataManager.callAction<unknown, { tabs: TabRow[] }>(info);
    return res?.tabs ?? [];
  }

  // Action-by-id helpers — invoke a backend Tab action WITHOUT constructing a
  // throwaway `new Tab({id})`. The strip renders from plain `TabRow` data (not
  // entities), so a fresh `Tab` with an already-cached id collides in the entity
  // store ("already registered with different entity"). These call the action by
  // id directly and return the canonical list.

  /** POST /graph/tab/<id>/close — soft-close (backend flips visible + dispatches
   *  target teardown). Returns the updated list. */
  static async closeById(id: string): Promise<TabRow[]> {
    const info = new ActionInfo('close', Tab.type, id, 'POST');
    const res = await dataManager.callAction<unknown, { tabs: TabRow[] }>(info);
    return res?.tabs ?? [];
  }

  /** POST /graph/tab/<id>/rename {name} — the backend reflects onto the backing
   *  entity via generic `Entity.rename`. Returns the updated list. */
  static async renameById(id: string, name: string): Promise<TabRow[]> {
    const info = new ActionInfo('rename', Tab.type, id, 'POST');
    info.bodyParameters = { name };
    const res = await dataManager.callAction<{ name: string }, { tabs: TabRow[] }>(info);
    return res?.tabs ?? [];
  }

  /** POST /graph/tab/<id>/activate — stamp recency (resolver seed for opener /
   *  close-to-last-active). */
  static async activateById(id: string): Promise<void> {
    const info = new ActionInfo('activate', Tab.type, id, 'POST');
    await dataManager.callAction<undefined, unknown>(info);
  }

  /** POST /graph/tab/<id>/set_name {name} — set ONLY the Tab label (no entity
   *  reflect, no `auto_rename` change). The PTY auto-title mirror: the active panel
   *  already saved the live name onto its Shell/AgenticProcess; this keeps the
   *  durable `Tab.name` in step so the chip stays right once inactive. NOT `rename`
   *  (which would pin `auto_rename=false` and stop future auto-titles). */
  static async setNameById(id: string, name: string): Promise<TabRow[]> {
    const info = new ActionInfo('set_name', Tab.type, id, 'POST');
    info.bodyParameters = { name };
    const res = await dataManager.callAction<{ name: string }, { tabs: TabRow[] }>(info);
    return res?.tabs ?? [];
  }

  /** Instance soft-close (also updates the local flag). */
  async closeTab(): Promise<TabRow[]> {
    const rows = await Tab.closeById(this.id);
    this.visible = false;
    return rows;
  }

  /** Instance rename (also updates the local name). */
  async rename(name: string): Promise<TabRow[]> {
    const rows = await Tab.renameById(this.id, name);
    this.name = name;
    return rows;
  }

  constructor(entity: Partial<ITab> = {}) {
    super(entity as IEntity);
    Object.assign(this, entity);
  }
}

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

  /**
   * Soft-close via the backend action (POST /graph/tab/<id>/close): the backend
   * flips ``visible=false`` and dispatches PTY/worker teardown by target_type.
   * Teardown is headless-owned, so close must round-trip — never just a local
   * ``visible=false``.
   */
  async closeTab(): Promise<TabRow[]> {
    const action = new ActionInfo('close', Tab.type, this.id, 'POST');
    const res = await dataManager.callAction<unknown, { tabs: TabRow[] }>(action);
    this.visible = false;
    return res?.tabs ?? [];
  }

  /**
   * Rename via the backend action (POST /graph/tab/<id>/rename {name}). ``Tab.name``
   * is the generic source of truth; the backend reflects the rename onto the target
   * entity by calling its generic ``Entity.rename`` (works for ANY backing entity —
   * conversation/agentic_process/shell/markdown; shell/AP also pin ``auto_rename``).
   */
  async rename(name: string): Promise<TabRow[]> {
    const action = new ActionInfo('rename', Tab.type, this.id, 'POST');
    action.bodyParameters = { name };
    const res = await dataManager.callAction<{ name: string }, { tabs: TabRow[] }>(action);
    this.name = name;
    return res?.tabs ?? [];
  }

  constructor(entity: Partial<ITab> = {}) {
    super(entity as IEntity);
    Object.assign(this, entity);
  }
}

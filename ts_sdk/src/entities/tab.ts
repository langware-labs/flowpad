import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models';
import { IDockPointer } from '../models/DockPointer';
import { EntityTypes } from '../schema/types';

/** A terminal target's display fields, read off the (cached/resolved) entity. */
interface TerminalTargetFields {
  worker_type?: string | null;
  cliOptions?: { worktree?: boolean } | null;
}

/** Provider/display kind for a terminal chip (vendor→glyph) denormalized onto
 *  `Tab.icon_key`. Shells use `'shell'`; an AgenticProcess maps its
 *  `worker_type`; unset/unknown → `'claude'` (the spawn default). */
function providerKindForWorkerType(workerType: string | null | undefined): string {
  const wt = (workerType ?? '').toLowerCase();
  if (wt === 'codex') return 'codex';
  if (wt === 'copilot') return 'copilot';
  return 'claude';
}

/** CREATE-only chip primitives (provider glyph + worktree badge), derived from
 *  the tab's target entity so the strip draws without fetching it. */
function displayForTarget(
  targetType: string | null,
  target: TerminalTargetFields | null,
): { iconKey: string | null; worktree: boolean } {
  if (targetType === EntityTypes.Shell) return { iconKey: 'shell', worktree: false };
  if (targetType === EntityTypes.AgenticProcess) {
    return {
      iconKey: providerKindForWorkerType(target?.worker_type),
      worktree: Boolean(target?.cliOptions?.worktree),
    };
  }
  return { iconKey: null, worktree: false };
}

const LEGACY_LAYOUT_SEGMENTS = new Set(['dock', 'dev', 'win']);

function targetDockPointer(targetType: string | null | undefined, targetId: string | null | undefined): {
  viewType: string;
  pointer: string;
} | null {
  if (!targetType || !targetId) return null;
  if (targetType === EntityTypes.Shell) {
    return { viewType: EntityTypes.Shell, pointer: `${EntityTypes.Shell}-${targetId}` };
  }
  if (targetType === EntityTypes.AgenticProcess) {
    return { viewType: EntityTypes.Shell, pointer: `${EntityTypes.AgenticProcess}-${targetId}` };
  }
  return { viewType: targetType, pointer: targetId };
}

function normalizeLegacyPointer(
  pointer: string,
  targetType: string | null | undefined,
  targetId: string | null | undefined,
): { viewType: string; pointer: string } | null {
  const separator = pointer.indexOf('|');
  const rawViewType = separator >= 0 ? pointer.slice(0, separator) : pointer;
  const rawSubPointer = separator >= 0 ? pointer.slice(separator + 1) : '';
  const targetDock = targetDockPointer(targetType, targetId);

  const fromPath = (rawPath: string): { viewType: string; pointer: string } | null => {
    const parts = rawPath.replace(/^\/+/, '').split('/').filter(Boolean);
    if (parts.length === 0) return targetDock;
    if (LEGACY_LAYOUT_SEGMENTS.has(parts[0])) parts.shift();
    const path = parts.join('/');
    if (!path) return targetDock;

    if (
      targetDock &&
      (path === targetDock.pointer ||
        path === `${targetType}-${targetId}` ||
        path === `${targetType}/${targetId}`)
    ) {
      return targetDock;
    }

    if (path.startsWith(`${EntityTypes.Shell}-`) || path.startsWith(`${EntityTypes.AgenticProcess}-`)) {
      return { viewType: EntityTypes.Shell, pointer: path };
    }

    const slash = path.indexOf('/');
    if (slash >= 0) {
      return { viewType: path.slice(0, slash), pointer: path.slice(slash + 1) };
    }
    return { viewType: path, pointer: '' };
  };

  if (LEGACY_LAYOUT_SEGMENTS.has(rawViewType)) {
    return fromPath(rawSubPointer);
  }
  if (rawViewType.includes('/')) {
    return fromPath(rawViewType);
  }
  if (!rawViewType && targetDock) {
    return targetDock;
  }
  if (!rawViewType) return null;
  return { viewType: rawViewType, pointer: rawSubPointer };
}

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
  /** Runtime-computed fields: backing entity status and close-in-progress flag. Never persisted. */
  status?: string | null;
  is_disabled?: boolean;
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

/** Backward-compatible name for older call sites/tests during the Tab migration. */
export interface TabRow extends ITab {
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
  status: string | null = null;
  is_disabled: boolean = false;

  /** Computed DockPointer from the stored pointer. Parsed directly (SDK layer, no UI dependency). */
  get dockPointer(): IDockPointer | null {
    if (!this.pointer) return null;
    try {
      const parsed = JSON.parse(this.pointer) as IDockPointer;
      const viewType = parsed.viewType ?? '';
      const subPointer = parsed.pointer ?? '';
      return {
        ...parsed,
        tabHash: parsed.tabHash ?? `${viewType}|${subPointer}`,
      };
    } catch {
      const normalized = normalizeLegacyPointer(this.pointer, this.target_type, this.target_id);
      if (!normalized) return null;
      const { viewType, pointer: subPointer } = normalized;
      return {
        viewType,
        pointer: subPointer,
        tabHash: `${viewType}|${subPointer}`,
      } as IDockPointer;
    }
  }

  /** Get the key used for chip identity (tabHash or fallback to id). */
  getKey(): string {
    return this.dockPointer?.tabHash ?? this.id;
  }

  // ── Backend-owned ordered list (the single render source) ───────────────────
  // These call the collection-level `tab` actions (no entity id) and return the
  // canonical, project-filtered, ordered rows. The frontend renders them as-is.

  /** GET /graph/tab/list?project=<id> — the deterministic ordered render list for
   *  one project view (projectless tabs inline). `null` ⇒ no active project. */
  static async list(projectId: string | null = null): Promise<Tab[]> {
    const info = new ActionInfo('list', Tab.type, null, 'GET');
    info.queryParameters = { project: projectId ?? '' };
    const res = await dataManager.callAction<undefined, { tabs: ITab[] }>(info);
    return Tab.fromResponse(res?.tabs ?? []);
  }

  /** POST /graph/tab/new_tab — loader-driven get-or-create. A fresh tab lands
   *  right after `opts.afterTabId` (the opener); reopen keeps its slot. Returns
   *  the updated list. */
  static async newTab(pointer: string, opts: INewTabOpts = {}): Promise<Tab[]> {
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
    const res = await dataManager.callAction<unknown, { tabs: ITab[] }>(info);
    return Tab.fromResponse(res?.tabs ?? []);
  }

  /**
   * THE tab chokepoint: get-or-create the Tab for a dock, with `project_id`
   * resolved from the dock's TARGET — never the ambient active project (that
   * re-parented tabs on a cross-project open). DockPointer stays a pure string
   * manipulator; all network/DB resolution lives here.
   *
   * Self-sufficient (cache-first, network fallback) so it's correct regardless
   * of call site: an entity dock resolves via `getByTypeId`; a vfs asset dock
   * via `getEntityByPath` (the pure, no-recovery path lookup). `project_id`: a
   * project tab belongs to its OWN id; otherwise the target entity's
   * `project_id`; a target-less dock → null. No-tab docks (home, bare shell)
   * return [].
   */
  static async getFromDockPointer(dock: IDockPointer): Promise<Tab[]> {
    const pointerJson = dock.toJSON?.();
    if (!pointerJson) return [];

    // An entity dock resolves via `getByTypeId` (already cache-first internally);
    // a vfs asset dock via the pure `getEntityByPath`. One cast names the fields
    // we read off the heterogeneous target (project + terminal-display).
    let targetTypeId = dock.targetTypeId ?? null;
    const target = (
      targetTypeId
        ? await dataManager.getByTypeId<APIEntity<any>>(targetTypeId).catch(() => null)
        : dock.vfsPath
          ? await dataManager.getEntityByPath<APIEntity<any>>(dock.vfsPath.toString())
          : null
    ) as (APIEntity<any> & TerminalTargetFields & { project_id?: string | null }) | null;
    if (!targetTypeId && target) targetTypeId = target.typeId;

    const projectId =
      targetTypeId?.type === EntityTypes.Project
        ? targetTypeId.id // a project belongs to itself
        : (target?.project_id ?? null);

    const { iconKey, worktree } = displayForTarget(targetTypeId?.type ?? null, target);

    return Tab.newTab(pointerJson, {
      targetType: targetTypeId?.type ?? null,
      targetId: targetTypeId?.id ?? null,
      projectId,
      name: dataManager.getTabName(dock),
      iconKey,
      worktree,
    });
  }

  /** GET /graph/tab/list_all — EVERY visible Tab (any kind, ALL projects), fully
   *  resolved, in global order. The single unscoped projection that the developer
   *  sessions view + footer projects-chip read; replaces the old reactive
   *  `tab?visible=true` entity query. (Project-scoped views use `list`.) */
  static async listAll(): Promise<Tab[]> {
    const info = new ActionInfo('list_all', Tab.type, null, 'GET');
    const res = await dataManager.callAction<undefined, { tabs: ITab[] }>(info);
    return Tab.fromResponse(res?.tabs ?? []);
  }

  /** POST /graph/tab/order — drag-drop commit. Splices `reorderId` into the
   *  drop-gap (after `afterId` / before `beforeId`) within the global order and
   *  returns the updated project-filtered list. No-op ⇒ unchanged list. */
  static async reorder(
    reorderId: string,
    afterId: string | null,
    beforeId: string | null,
    projectId: string | null = null,
  ): Promise<Tab[]> {
    const info = new ActionInfo('order', Tab.type, null, 'POST');
    info.bodyParameters = {
      reorder_tab_id: reorderId,
      after_tab_id: afterId,
      before_tab_id: beforeId,
      project: projectId ?? '',
    };
    const res = await dataManager.callAction<unknown, { tabs: ITab[] }>(info);
    return Tab.fromResponse(res?.tabs ?? []);
  }

  // Action-by-id helpers — invoke a backend Tab action WITHOUT constructing a
  // throwaway `new Tab({id})`. The strip renders from plain Tab data (not
  // entities), so a fresh `Tab` with an already-cached id collides in the entity
  // store ("already registered with different entity"). These call the action by
  // id directly and return the canonical list.

  /** POST /graph/tab/<id>/close — soft-close (backend flips visible + dispatches
   *  target teardown). Returns the updated list. */
  static async closeById(id: string): Promise<Tab[]> {
    const info = new ActionInfo('close', Tab.type, id, 'POST');
    const res = await dataManager.callAction<unknown, { tabs: ITab[] }>(info);
    return Tab.fromResponse(res?.tabs ?? []);
  }

  /** POST /graph/tab/<id>/rename {name} — the backend reflects onto the backing
   *  entity via generic `Entity.rename`. Returns the updated list. */
  static async renameById(id: string, name: string): Promise<Tab[]> {
    const info = new ActionInfo('rename', Tab.type, id, 'POST');
    info.bodyParameters = { name };
    const res = await dataManager.callAction<{ name: string }, { tabs: ITab[] }>(info);
    return Tab.fromResponse(res?.tabs ?? []);
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
  static async setNameById(id: string, name: string): Promise<Tab[]> {
    const info = new ActionInfo('set_name', Tab.type, id, 'POST');
    info.bodyParameters = { name };
    const res = await dataManager.callAction<{ name: string }, { tabs: ITab[] }>(info);
    return Tab.fromResponse(res?.tabs ?? []);
  }

  /** Instance soft-close (also updates the local flag). */
  async closeTab(): Promise<Tab[]> {
    const rows = await Tab.closeById(this.id);
    this.visible = false;
    return rows;
  }

  /** Instance rename (also updates the local name). */
  async rename(name: string): Promise<Tab[]> {
    const rows = await Tab.renameById(this.id, name);
    this.name = name;
    return rows;
  }

  /** Factory to deserialize Tab array from API response. Uses entity cache
   *  to reuse instances by id, preventing duplicate-registration warnings. */
  static fromResponse(data: ITab[]): Tab[] {
    return data.map((t) => {
      const cached = Tab.getByIdFromCache<Tab>(t.id ?? '');
      if (cached) {
        Object.assign(cached, t);
        return cached;
      }
      return new Tab(t);
    });
  }

  constructor(entity: Partial<ITab> = {}) {
    super(entity as IEntity);
    Object.assign(this, entity);
  }
}

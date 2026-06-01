import { v4 as uuidv4 } from 'uuid';
import { ActionInfo, ActionType, EntityExpansion, ExpansionType, JSONSchemaParser, Workspace } from '.';
import { Record, RecordRefs } from './fs/Record';
import { EntityFactory } from './schema/factory';
import { ExpansionRequest, QueryRequest } from './FlowSync/query';
import { DataManager, Manageable } from './FlowSync/store';
import { FlowData, FlowDataStream } from './flow_processing';
import { defaultEntityType, IEntity } from './IEntity';
import { DockPointerData } from './models/DockPointer';
import { TypeId } from './models/TypeId';
import { ViewType } from './utils/ui/view-types';
import { Callable } from './types';

/**
 * One row of an entity's member roster, as returned by the generic ``members``
 * action (``APIEntity.fetchMembers``). The hub normalizes ``user_email`` →
 * ``email`` etc. server-side (see ``_hub_reflect._normalize_hub_response``);
 * extra hub keys (``status``, ``role``, ``invitation_id``, …) pass through, so
 * this is intentionally open. ``Participant`` in ``entities/members.ts`` is the
 * structurally-compatible alias kept for existing import sites. */
export interface EntityMember {
  user_id?: string | null;
  email?: string | null;
  name?: string | null;
  role?: string | null;
  status?: string | null;
  [key: string]: unknown;
}
import { defineGlobal } from './utils/globals';
import { WikiLink } from './types/wiki';

/**
 * True when ``v`` is a string with at least one non-whitespace character.
 * Wire payloads occasionally carry non-string values for nominally-string
 * fields (legacy records, unmigrated data); the type guard keeps display-chain
 * call-sites from blowing up on `.trim()`.
 */
export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function getProxy<T extends Manageable & { [key: string | symbol]: any }>(target: T) {
  return new Proxy(target, {
    get(target, property, receiver) {
      // Implement any specific logic needed when properties are accessed
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      const oldValue = target[property];
      const result = Reflect.set(target, property, value, receiver);
      if (result && oldValue !== value) {
        // Skip dirty + notify for internal fields. Underscore-prefixed
        // properties (e.g. `_flowDataStream` lazy-init holder, `_dirty`,
        // `_data` caches) are private to the entity — they are not part
        // of the persisted schema and consumers do not subscribe to them.
        // Firing notifyPropertyChanged for them is what triggered the
        // render-phase "Cannot update component while rendering different
        // component" warning: a getter-with-side-effects (e.g. `flowDataStream`)
        // mutated `_flowDataStream` during a sibling component's render and
        // synchronously dispatched setState across all subscribers.
        const isInternal =
          typeof property === 'string' && property.startsWith('_');
        if (!isInternal && property !== 'dirty') {
          target.dirty = true;
          dataManager.notifyPropertyChanged(target.typeId, property as string);
        }
      }
      return result;
    },
  });
}

export const registerEntity = (constructor: new (json?: IEntity) => unknown) => {
  EntityFactory.registerEntity(constructor);
};

export class APIEntity<T extends APIEntity<T>> implements IEntity, Manageable {
  static type?: string = defaultEntityType;
  static autoLoadExpansions: ExpansionType[] = [];
  static icon: string | null = null;
  // Shared fields lifted from Python ``DBBaseRecord`` + ``Entity``. All
  // optional — subclasses populate the ones they care about. ``deepAssign``
  // in the base constructor copies wire fields onto the instance, so
  // subclasses no longer need to redeclare or manually assign these.
  id: string;
  uname?: string;
  name?: string;
  title?: string;
  key?: string;
  namespace?: string;
  tags?: string[];
  system?: boolean;
  /**
   * Backend FSIndexer flag: true when the on-disk Record this entity points
   * at can no longer be located. ``deepAssign`` in the constructor copies
   * this off the wire JSON; subclasses don't need to redeclare.
   */
  orphan?: boolean;
  /** ISO 8601 timestamp of the last ``orphan = true`` transition; null otherwise. */
  orphan_since?: string | null;
  created_by?: string;
  created_date?: Date;
  updated_by?: string;
  updated_date?: Date;
  created_through?: string;
  updated_through?: string;
  schema_version?: string;
  labels?: string[];
  root_vfs_path?: string;
  fs_storage_mount_path?: string;
  visitor_role?: string;
  _expand?: EntityExpansion;
  _dirty: boolean = true;
  _typeId: TypeId | null = null;
  /**
   * Wire-bound context references. Populated from the incoming
   * ``shared_context_entities`` wire field on deserialize; emitted back on
   * serialize. The public read accessor is ``sharedContextEntities``.
   *
   * Frontend code does NOT mutate this directly — to publish a link, call
   * the backend ``share-context`` action.
   */
  private _shared_context_entities_: TypeId[] = [];
  /**
   * Backend-computed private context. The Python side merges implicit
   * projections (project_id) with explicit attachments and ships the
   * deduped array over the wire — this slot just stores what arrived.
   * The FE never reads or mutates raw explicit attachments independently.
   * Read via ``privateContextEntities`` (identity getter).
   */
  private _private_context_entities_: TypeId[] = [];
  /**
   * Per-entry sidecar storage harvested by the backend at detection time.
   * Keyed by ``str(typeid)`` (e.g. ``"plan-b034e56e-..."``). Mirrors the
   * Python-side ``shared_context_entity_data`` / ``private_context_entity_data``
   * fields. For file-backed types this typically holds ``{path}`` so a dock
   * loader 404 can self-heal via ``?hint_path=...`` without a reverse-id
   * lookup. Read via ``getContextEntryData(typeid)``.
   */
  private _shared_context_entity_data: Record<string, Record<string, unknown>> = {};
  private _private_context_entity_data: Record<string, Record<string, unknown>> = {};
  _isLoaded: boolean = false;
  static nextInstanceIndex: number = 0;
  _instanceIndex: number = APIEntity.nextInstanceIndex++;
  protected _loadingPromise: Promise<void> | null = null;

  // Event emitter system
  protected _eventListeners: Map<string, Callable[]> = new Map();

  // Default FlowData stream for receiving WebSocket FlowData notifications
  protected _flowDataStream: FlowDataStream | null = null;

  get dirty(): boolean {
    return this._dirty;
  }

  get i(): number {
    return this._instanceIndex;
  }

  set dirty(value: boolean) {
    this._dirty = value;
  }

  get icon(): string | null {
    return (this.constructor as typeof APIEntity).icon;
  }

  get editorDockPointer(): DockPointerData {
    throw new Error(`editorDockPointer not implemented for ${this.constructor.name}`);
  }

  get saved(): boolean {
    return this.created_by !== undefined;
  }

  get isLoaded(): boolean {
    return this._isLoaded;
  }

  get identifier(): string {
    return this.uname ? `@${this.uname}` : this.id;
  }

  /**
   * Human-readable label for this entity. Used at every user-visible name
   * display site. Composed from ``getDisplayName()`` (subclass override hook,
   * defaults to ``null``) falling through to ``defaultDisplayName`` (the
   * universal chain over ``name`` → ``uname`` → ``title`` → ``<type>-<key>``
   * → ``<type>-<id-tail>``).
   *
   * Subclasses customize by overriding ``getDisplayName()``, NOT this getter.
   * Returning ``null`` from ``getDisplayName`` defers to the default chain.
   */
  get displayName(): string {
    return this.getDisplayName() ?? this.defaultDisplayName;
  }

  /**
   * Subclass override hook. Return a custom display string when the default
   * chain isn't what the entity wants (e.g. Project's cwd-basename branch,
   * CollaborationRoom's participant join). Return ``null`` to defer to
   * ``defaultDisplayName``. Base returns ``null``.
   */
  getDisplayName(): string | null {
    return null;
  }

  /**
   * Universal fallback chain. Read in order; first non-empty rung wins.
   *   1. ``this.name`` if non-empty (after trim)
   *   2. ``this.uname`` if non-empty
   *   3. first 2 words of ``this.title`` + ' …' (or just the title if ≤ 2 words)
   *   4. ``<type>-<key>`` if ``this.key`` is non-empty
   *   5. ``<type>-<id[0:4]>…<id[-4:]>`` (or ``<type>-<id>`` literal when id < 8 chars)
   */
  get defaultDisplayName(): string {
    const type = (this.constructor as typeof APIEntity).type ?? 'entity';

    // 1. name
    if (isNonEmptyString(this.name)) return this.name;

    // 2. uname
    if (isNonEmptyString(this.uname)) return this.uname;

    // 3. title prefix
    if (isNonEmptyString(this.title)) {
      const words = this.title.trim().split(/\s+/);
      const head = words.slice(0, 2).join(' ');
      return words.length > 2 ? `${head} …` : head;
    }

    // 4. <type>-<key>
    if (isNonEmptyString(this.key)) return `${type}-${this.key}`;

    // 5. <type>-<id-tail>
    const id = this.id ?? '';
    if (id.length < 8) return `${type}-${id || '?'}`;
    return `${type}-${id.slice(0, 4)}…${id.slice(-4)}`;
  }

  get expand(): EntityExpansion | undefined {
    return this._expand;
  }

  set expand(value: any) {
    this._expand = value;
  }

  get expansions(): ExpansionType[] {
    return this.expand?.expansions ?? [];
  }

  set expansions(expansions: ExpansionType[]) {
    if (!this.expand) {
      this.expand = { expansions: [] };
    }

    if (!this.expand.expansions) {
      this.expand.expansions = [];
    }
    if (!expansions) return;

    // Merge unique values
    this.expand.expansions = [...new Set([...this.expand.expansions, ...expansions])];
  }

  isExpanded(expansion: ExpansionType | ExpansionType[] | ExpansionRequest): boolean {
    if (!expansion) return true;
    if (Array.isArray(expansion)) {
      return expansion.every((e) => this.isExpanded(e));
    }
    if (expansion instanceof ExpansionRequest) {
      if (!expansion.expand) return true;
      return expansion.expand?.every((e) => this.isExpanded(e)) ?? false;
    }
    return this.expand?.expansions?.includes(expansion) ?? false;
  }

  setExpansion(expansion: ExpansionType) {
    if (this.isExpanded(expansion)) return;

    if (!this.expand) {
      this.expand = { expansions: [] }; // Ensure `expand` is initialized
    }
    if (!this.expand.expansions) {
      this.expand.expansions = [];
    }

    this.expand.expansions.push(expansion);
  }

  get is_private(): boolean | undefined {
    return this.expand?.is_private;
  }

  set is_private(value: boolean | undefined) {
    this.setExpansion('is_private');
    this.expand!.is_private = value;
  }

  get ImOwner(): boolean {
    return this.expand?.roles?.includes('owner') || false;
  }

  get ImAdmin(): boolean {
    return this.expand?.roles?.includes('admin') || false;
  }

  get ImEditor(): boolean {
    return this.expand?.roles?.includes('editor') || false;
  }

  get ImReader(): boolean {
    return this.expand?.roles?.includes('reader') || false;
  }

  get ImGuest(): boolean {
    return this.expand?.roles?.includes('guest') || false;
  }

  get ImAnonymousViewer(): boolean {
    return this.expand?.roles?.includes('anonymous_viewer') || false;
  }

  isAllowedAction(action: ActionType): boolean {
    if (!this.isExpanded('permissions')) {
      throw new Error(`Permissions not expanded on entity ${this.getType()}, can not check action permissions`);
    }
    if (!this.expand?.allowed_actions) return false;
    return this.expand?.allowed_actions.includes(action);
  }

  addToAllowedActions(action: ActionType) {
    this.setExpansion('permissions');
    if (this.isAllowedAction(action)) return;
    if (this.expand && !this.expand.allowed_actions) {
      this.expand.allowed_actions = [];
    }
    if (!this.expand?.allowed_actions?.includes(action)) {
      this.expand?.allowed_actions?.push(action);
    }
  }

  get readOnly(): boolean {
    if (!this.saved) return false;
    return !this.isAllowedAction('update');
  }

  get canCreate(): boolean {
    if (!this.saved) return false;
    return this.isAllowedAction('create');
  }

  get canInvite(): boolean {
    if (!this.saved) return false;
    return this.isAllowedAction('members');
  }

  get canDelete(): boolean {
    if (!this.saved) return false;
    return this.isAllowedAction('delete');
  }

  get canGetRelatedWorkspace(): boolean {
    if (!this.saved) return false;
    return this.isAllowedAction('get_related_workspace');
  }

  get scopeWorkspaces(): TypeId[] {
    if (!this.expand?.auth_scopes) {
      return [];
    }
    const workspaces: TypeId[] = [];
    this.expand?.auth_scopes.forEach((scope) => {
      scope.forEach((raw) => {
        const tid = new TypeId(raw);
        if (tid.type === Workspace.type) {
          workspaces.push(tid);
        }
      });
    });
    return workspaces;
  }

  constructor(entityJson: any = {}) {
    dataManager.deepAssign(this, entityJson);
    this.id = entityJson.id || uuidv4();
    if (entityJson.type && entityJson.type != this.getType()) {
      throw new Error(`Entity type mismatch: ${entityJson.type} != ${this.getType()}`);
    }
    // Move the wire-shaped ``shared_context_entities`` and the
    // backend-computed ``private_context_entities`` into private storage,
    // then drop the public aliases so toJSON's dynamic-property iterator
    // doesn't double-emit them.
    //
    // IMPORTANT — ``private_context_entities`` arrives ALREADY merged from
    // the backend: implicit projections (project_id) + explicit raw
    // attachments + dedup. The FE just deserializes the final list and
    // renders it. Computation lives server-side in
    // ``Entity.get_implicit_private_context_entities`` /
    // ``private_context_entities`` (Pydantic computed_field).
    const fromWireShared = (this as any).shared_context_entities as Array<unknown> | undefined;
    if (Array.isArray(fromWireShared) && fromWireShared.length > 0) {
      this._shared_context_entities_ = fromWireShared.map((v) =>
        v instanceof TypeId ? v : new TypeId(String(v)),
      );
    }
    delete (this as any).shared_context_entities;

    const fromWirePrivate = (this as any).private_context_entities as Array<unknown> | undefined;
    if (Array.isArray(fromWirePrivate) && fromWirePrivate.length > 0) {
      this._private_context_entities_ = fromWirePrivate.map((v) =>
        v instanceof TypeId ? v : new TypeId(String(v)),
      );
    }
    delete (this as any).private_context_entities;

    // Per-entry sidecar data (shared + private buckets). Same lift-into-
    // private-storage / drop-public-alias dance as the typeid arrays above
    // so toJSON's dynamic iterator doesn't double-emit them.
    const fromWireSharedData = (this as any).shared_context_entity_data as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (fromWireSharedData && typeof fromWireSharedData === 'object') {
      this._shared_context_entity_data = { ...fromWireSharedData };
    }
    delete (this as any).shared_context_entity_data;

    const fromWirePrivateData = (this as any).private_context_entity_data as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (fromWirePrivateData && typeof fromWirePrivateData === 'object') {
      this._private_context_entity_data = { ...fromWirePrivateData };
    }
    delete (this as any).private_context_entity_data;

    const proxy = getProxy(this);
    dataManager.register_new_entity(this.typeId, proxy);
    return proxy;
  }

  public get typeId(): TypeId {
    if (!this.id) {
      throw new Error('Entity has no ID');
    }
    if (!this.getType()) {
      throw new Error('Entity has no type');
    }
    if (!this._typeId) {
      this._typeId = new TypeId(this.getType(), this.identifier);
    }
    return this._typeId;
  }

  public get dockPointer(): DockPointerData {
    return new DockPointerData(ViewType.HOME, this.typeId?.toString());
  }

  public get searchDockPointer(): DockPointerData {
    return this.dockPointer;
  }

  /**
   * Navigate the dock to this entity. Delegates to the active
   * NavigationActions instance registered as the ``navigation`` global by
   * ``useDockNavigation`` in the UI. No-op when no navigation is available
   * (non-UI contexts, before first render).
   */
  public openDock(extraOptions?: Record<string, string>): void {
    const nav = (window as any).navigation as
      | { openDock: (pointer: DockPointerData, extraOptions?: Record<string, string>) => void }
      | undefined;
    nav?.openDock(this.dockPointer, extraOptions);
  }

  public clone(): T {
    // Get the full JSON representation of the current entity
    const jsonData = this.toJSON();

    // Remove properties that should be unique or reset for the clone
    jsonData.id = uuidv4();
    delete jsonData.created_by;
    delete jsonData.created_date;
    delete jsonData.updated_by;
    delete jsonData.updated_date;
    delete jsonData.schema_version;

    // Create a new instance of the same type with the cloned data
    const Constructor = this.constructor as new (json: any) => T;
    return new Constructor(jsonData);
  }

  public toJSON(): any {
    // Create a basic object with known properties
    const baseObject: any = {
      created_by: this.created_by,
      created_date: this.created_date,
      updated_by: this.updated_by,
      updated_date: this.updated_date,
      id: this.id,
      type: this.getType(),
      version: this.schema_version,
      // Wire-bound context only. Private context stays local — it's never
      // published or sent to the backend, by design. Direct-field projections
      // (project_id, assignee, ...) are emitted as their own typed fields by
      // the dynamic-property iterator below; the ``privateContextEntities``
      // getter folds them in at read time on this client only.
      shared_context_entities: this._shared_context_entities_.map((t) => t.toString()),
      // Per-entry sidecar — only the shared bucket survives toJSON, matching
      // the backend's share() exclusion of the private one.
      shared_context_entity_data: { ...this._shared_context_entity_data },
    };

    // Dynamically add all enumerable properties of the instance
    // This includes properties in subclasses
    for (const key in this) {
      if (!key.startsWith('_') && this.hasOwnProperty(key) && baseObject[key] === undefined) {
        if (this.schema && !this.isDbField(key)) {
          continue; // Skip non-database fields
        }

        const value: any = this[key];

        // Check if the value is an array
        if (Array.isArray(value)) {
          baseObject[key] = value.map((item) => {
            // Check if item is an object and has a toJSON method
            if (item && typeof item === 'object' && typeof item.toJSON === 'function') {
              return item.toJSON(); // Serialize nested object
            } else {
              return item; // Return simple value or non-serializable object directly
            }
          });
        } else if (value && typeof value === 'object' && typeof value.toJSON === 'function') {
          // Use the toJSON method of the nested object
          baseObject[key] = value.toJSON();
        } else {
          // Assign the value directly
          baseObject[key] = value;
        }
      }
    }

    // delete baseObject.expand?.roles;
    // delete baseObject.expand?.allowed_actions;
    // delete baseObject.expand?.auth_scopes;
    // delete baseObject.expand?.expansions;
    // delete baseObject.expand;
    return baseObject;
  }

  public static compare<U extends APIEntity<U>>(
    this: { new (): U },
    attribute: 'created_date' | 'updated_date',
    order: 'asc' | 'desc' = 'desc',
  ) {
    return (a: U, b: U) => {
      const aValue = a[attribute];
      const bValue = b[attribute];

      if (!aValue && !bValue) {
        return 0;
      }
      if (!aValue) {
        return order === 'asc' ? -1 : 1;
      }
      if (!bValue) {
        return order === 'asc' ? 1 : -1;
      }
      return order === 'asc' ? (aValue >= bValue ? 1 : -1) : aValue >= bValue ? -1 : 1;
    };
  }

  getType(): string {
    const classType = (this.constructor as typeof APIEntity).type;
    if (!classType) {
      throw new Error('Entity type not set');
    }
    return classType;
  }

  public static isType<U extends APIEntity<U>>(
    this: { new (): U; type: string },
    entity: APIEntity<any> | null,
  ): entity is U {
    return entity?.getType() === this.type;
  }

  public static getByIdFromCache<U extends APIEntity<U>>(this: { new (): U; type: string }, id: string): U | null {
    return dataManager.getByTypeIdFromCache<U>(new TypeId(this.type, id));
  }

  public static async getById<U extends APIEntity<U>>(
    this: { new (): U; type: string },
    id: string,
    query?: ExpansionRequest,
  ): Promise<U | null> {
    return await dataManager.getByTypeId<U>(new TypeId(this.type, id), query);
  }

  get hasBlobs(): boolean {
    if (!this.schema) {
      console.warn('hasBlobs: Schema not found, cant check blobs');
      throw new Error('hasBlobs: Schema not found, cant check blobs');
    }
    return this.schema.hasBlobs;
  }

  public isDbField(fieldName: string): boolean {
    if (!this.schema) {
      console.warn('isDbField: Schema not found, cant check blobs', this.type);
      return false;
    }
    const property = this.schema.getProperty(fieldName);
    if (!property) {
      return false;
    }

    return true;
  }

  get schema(): JSONSchemaParser {
    const schema = dataManager.getSchema(this.getType());
    return schema;
  }

  public static async query<U extends APIEntity<U>>(
    this: { new (): U; type: string },
    request: QueryRequest,
    invalidate: boolean = false,
  ): Promise<U[]> {
    // Create a new QueryRequest with entity type override
    const entityRequest = new QueryRequest({
      type: this.type,
      query: request.query,
      scope: request.scope,
      callback: request.callback,
      name: request.name || `${this.type} static query`,
    });
    return await dataManager.query<U>(entityRequest, invalidate);
  }

  public static async watchQuery<U extends APIEntity<U>>(
    this: { new (): U; type: string },
    request: QueryRequest,
  ): Promise<() => void> {
    // Create a new QueryRequest with entity type override
    const entityRequest = new QueryRequest({
      type: this.type,
      query: request.query,
      scope: request.scope,
      callback: request.callback,
      name: request.name || `${this.type} static watchQuery`,
    });

    return await dataManager.watchQuery<U>(entityRequest);
  }

  public markAsExpanded(): void {
    const loadingExpansions = (this.constructor as typeof APIEntity).getLoadingExpansions();
    if (!loadingExpansions.expand) {
      loadingExpansions.expand = [];
    }
    this.expand = { ...this.expand, expansions: [...loadingExpansions.expand] };
  }

  public async save(scope: TypeId[] | TypeId = []): Promise<T> {
    const isNew = !this.saved;
    if (!Array.isArray(scope)) {
      scope = [scope];
    }
    const entity = await dataManager.save<T>(this.typeId, scope);
    if (isNew) {
      this.markAsExpanded();
      this._isLoaded = true;
    }
    return entity;
  }

  /**
   * Push this entity to the hub via the standard graph action
   * ``POST /api/v1/graph/<type>/<id>/share``. The local backend's
   * ``share`` action handler forwards the create to the hub using the
   * stored cloud credentials. On success, ``remote`` is flipped.
   *
   * When ``recipients`` is provided (list of email strings) and the entity
   * is a Conversation, each recipient is invited via the standard
   * ``MembershipRequest`` pattern (one ``POST /graph/conversation/<id>/members``
   * per recipient). See ``Conversation.share`` on the Python side.
   */
  public async share(recipients?: string[]): Promise<T> {
    const info = new ActionInfo('share', this.typeId.type, this.typeId.id, 'POST');
    info.bodyParameters = { ...this.toJSON(), ...(recipients ? { recipients } : {}) };
    await dataManager.callAction<unknown, unknown>(info);
    (this as any).remote = true;
    return this as unknown as T;
  }

  /**
   * Per-instance cache for ``fetchMembers`` so repeat reads (e.g. multiple
   * UI consumers mounting against the same entity) don't each round-trip.
   * Undefined = never fetched; an array = the last fetched roster.
   */
  private _membersCache?: EntityMember[];

  /**
   * Generic roster fetch for any shareable entity — GET ``<type>/<id>/members``.
   *
   * The ``members`` action is ``reflect="hub"`` server-side: for a ``remote``
   * entity the local server forwards to the hub and mirrors the roster back
   * onto the local row; for a local-only entity it returns the cached
   * participants. Either way this returns the normalized ``EntityMember[]``.
   *
   * ``cache`` (default ``true``): return the per-instance cached roster when
   * present, so incidental reads are free. Pass ``cache: false`` to force a
   * fresh round-trip — the path a deliberate "reload" (e.g. the conversation
   * refresh button, or a post-invite/role-change refresh) must use so it
   * reflects hub state rather than a stale snapshot.
   */
  public async fetchMembers(opts: { cache?: boolean } = {}): Promise<EntityMember[]> {
    const useCache = opts.cache ?? true;
    if (useCache && this._membersCache) return this._membersCache;
    const info = new ActionInfo('members', this.typeId.type, this.typeId.id, 'GET');
    const res = await dataManager.callAction<undefined, EntityMember[]>(info);
    // Defensive: the hub utils coerce empty lists to {} upstream
    // (`resp.json().get('data') or {}`); treat any non-array as "no members".
    this._membersCache = Array.isArray(res) ? res : [];
    return this._membersCache;
  }

  /**
   * Remove a member by user id — DELETE ``<type>/<id>/members``. OWNER ONLY:
   * the hub enforces the owner gate (``delete_membership`` → 403 for non-owners
   * / owner-self), so this surfaces that as a thrown error rather than
   * silently no-op'ing. The DELETE body is a ``MembershipMethod``
   * (``{member_through: 'id', value: userId}``) — the shape the hub's
   * ``create_membership_identifiers`` expects.
   *
   * Invalidates the per-instance cache so the next ``fetchMembers`` reflects
   * the post-removal roster.
   */
  public async removeMember(userId: string): Promise<void> {
    const info = new ActionInfo('members', this.typeId.type, this.typeId.id, 'DELETE');
    info.bodyParameters = { member_through: 'id', value: userId };
    await dataManager.callAction<unknown, unknown>(info);
    this._membersCache = undefined;
  }

  /**
   * True when this entity has a hub-side counterpart at the same id. Mirrors
   * the Python ``Entity.remote`` field; flipped to ``true`` by ``share()``.
   */
  remote?: boolean;

  /** POST /entity-event {event, payload}. Unknown events are a server-side no-op. */
  public async entityEvent(event: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return APIEntity.entityEvent(this.typeId, event, payload);
  }

  /** Static form for callsites that hold only a TypeId. */
  public static async entityEvent(
    typeId: TypeId,
    event: string,
    payload: Record<string, unknown> = {},
  ): Promise<unknown> {
    const info = new ActionInfo('entity-event', typeId.type, typeId.id, 'POST');
    info.bodyParameters = { event, payload };
    return await dataManager.callActionPreferWS<unknown, unknown>(info);
  }

  public async delete(): Promise<void> {
    console.log(
      `🗑️ [APIEntity.delete] Starting deletion of ${this.typeId.type}:${this.typeId.id} (${this.constructor.name})`,
    );
    try {
      const result = await dataManager.delete(this.typeId);
      console.log(`✅ [APIEntity.delete] Successfully deleted ${this.typeId.type}:${this.typeId.id}`);
      return result;
    } catch (error) {
      console.error(`❌ [APIEntity.delete] Failed to delete ${this.typeId.type}:${this.typeId.id}:`, error);
      throw error;
    }
  }

  public subscribe(callback?: (entity: T | null) => void | Promise<void>): () => void {
    return dataManager.subscribe<T>(this.typeId, callback, true);
  }

  public async watch(): Promise<() => Promise<void>> {
    return await dataManager.watch(new TypeId(this.getType(), this.id));
  }

  /**
   * Outgoing wiki links from this entity. Hits
   * `GET /api/v1/graph/{type}/{id}/wiki/links`.
   */
  public async getLinks(): Promise<WikiLink[]> {
    const info = new ActionInfo('wiki', this.typeId.type, this.typeId.id, 'GET');
    info.subpath = 'links';
    return (await dataManager.callAction<undefined, WikiLink[]>(info)) ?? [];
  }

  /**
   * Inbound wiki links pointing at this entity. Hits
   * `GET /api/v1/graph/{type}/{id}/wiki/backlinks`.
   */
  public async getBacklinks(): Promise<WikiLink[]> {
    const info = new ActionInfo('wiki', this.typeId.type, this.typeId.id, 'GET');
    info.subpath = 'backlinks';
    return (await dataManager.callAction<undefined, WikiLink[]>(info)) ?? [];
  }

  /**
   * Re-extract this entity's outgoing wiki edges. Mirrors `Entity.reindex` on
   * the Python side. Hits `POST /api/v1/graph/{type}/{id}/wiki/reindex`.
   *
   * Pass `body` when the caller already has the markdown text in hand
   * (e.g. the editor toolbar after an out-of-band wikilink insert) so the
   * server doesn't need to re-read the record from disk.
   */
  public async reindex(body?: string): Promise<WikiLink[]> {
    const info = new ActionInfo('wiki', this.typeId.type, this.typeId.id, 'POST');
    info.subpath = 'reindex';
    if (body !== undefined) info.bodyParameters = { body };
    return (await dataManager.callAction<undefined, WikiLink[]>(info)) ?? [];
  }

  public async get_related_workspace(): Promise<Workspace | undefined> {
    if (!this.saved) return undefined;
    const actionInfo = new ActionInfo('get_related_workspace', this.typeId.type, this.typeId.id, 'GET');
    const ws = await dataManager.callAction<undefined, APIEntity<Workspace>>(actionInfo);
    if (!ws) return undefined;
    let workspace = Workspace.getByIdFromCache(ws.id);
    if (!workspace) workspace = new Workspace(ws);
    return workspace;
  }

  public findWorkspaceScope(workspaceTypeId: TypeId | null): TypeId[] {
    if (!this.expand?.auth_scopes) {
      return [];
    }
    const parsedScopes: TypeId[][] = this.expand.auth_scopes.map((scope) =>
      scope.map((raw) => new TypeId(raw)),
    );
    let selectedScope = parsedScopes.find((scope) =>
      workspaceTypeId
        ? scope.some(
            (typeId) =>
              typeId.id === workspaceTypeId.id && typeId.type === workspaceTypeId.type,
          )
        : false,
    );
    if (!selectedScope && parsedScopes.length > 0) {
      selectedScope = parsedScopes[0];
    }
    return selectedScope || [];
  }

  public async ingest(
    files: File[] | null = null,
    links: string[] | null = null,
    texts: string[] | null = null,
    resources: TypeId[] | null = null,
  ): Promise<void> {
    if (!this.saved) return undefined;
    try {
      const formData = new FormData();
      for (const file of files || []) {
        formData.append('files', file);
      }
      for (const link of links || []) {
        formData.append('links', link);
      }
      for (const text of texts || []) {
        formData.append('texts', text);
      }
      for (const resource of resources || []) {
        formData.append('resources', resource.toString());
      }
      const actionInfo = new ActionInfo('ingest', this.typeId.type, this.typeId.id, 'POST');
      actionInfo.bodyParameters = formData;
      await dataManager.callAction<FormData, undefined>(actionInfo);
    } catch (e) {
      console.error('Failed to run ingest: ', e);
    }
  }

  /**
   * Add a label to the entity locally (does not save to server).
   */
  public add_label_local(label: string): void {
    if (!this.labels) {
      this.labels = [];
    }
    // Check if label already exists
    if (!this.labels.includes(label)) {
      this.labels.push(label);
      this.dirty = true;
    }
  }

  /**
   * Remove a label from the entity locally (does not save to server). Returns true if removed, false if not found.
   */
  public remove_label_local(label: string): boolean {
    if (!this.labels) {
      return false;
    }
    const originalCount = this.labels.length;
    this.labels = this.labels.filter((l) => l !== label);
    if (this.labels.length < originalCount) {
      this.dirty = true;
      return true;
    }
    return false;
  }

  /**
   * Get all labels for the entity.
   */
  public get_labels(): string[] {
    return [...(this.labels || [])];
  }

  // ── context_entities surface ──────────────────────────────────────────
  //
  // Two buckets, split by the rule "if it came over the wire it is shared,
  // otherwise private":
  //   * ``sharedContextEntities`` — wire-bound; what every reader of this
  //     entity sees. Mutated only by the backend (call a ``share-context``
  //     action to publish).
  //   * ``privateContextEntities`` — also wire-bound now: the **backend**
  //     computes the merged list (implicit projections like ``project_id``
  //     PLUS the user's explicit attachments) via
  //     ``Entity.get_implicit_private_context_entities`` +
  //     ``private_context_entities`` Pydantic computed_field. The FE just
  //     renders the list. **The FE never combines implicit + explicit
  //     locally.** This file used to host a ``_directFieldsAsTypeIds`` hook
  //     for FE-side projection; it was removed when projection moved to
  //     the backend.

  /** Wire-bound context. Read-only on the frontend — publish via a backend
   *  ``share-context`` action. */
  public get sharedContextEntities(): TypeId[] {
    return [...this._shared_context_entities_];
  }

  /** Computed-by-backend private context (implicit projections + explicit
   *  attachments, deduped server-side). Returned as-is — no FE-side
   *  projection. */
  public get privateContextEntities(): TypeId[] {
    return [...this._private_context_entities_];
  }

  /**
   * Return the per-entry sidecar data harvested by the backend at detection
   * time (e.g. ``{path: "/Users/.../foo.md"}`` for file-backed entries).
   * Checks the private sidecar first (matches the backend precedence), then
   * shared. Returns ``undefined`` when no data was harvested for the typeid.
   *
   * Use this when rendering a chip that may navigate to an entity that
   * hasn't been indexed yet — pass ``data.path`` as ``?hint_path=...`` to
   * the entity GET so the BE can self-heal the 404 by single-file-indexing.
   */
  public getContextEntryData(typeid: TypeId | string): Record<string, unknown> | undefined {
    const key = typeid instanceof TypeId ? typeid.toString() : typeid;
    return this._private_context_entity_data[key] ?? this._shared_context_entity_data[key];
  }

  // NOTE: ``addContextEntities`` / ``removeContextEntities`` /
  // ``_normalizeContextEntities`` lived here as FE-side mutation primitives
  // for the private bucket. They were removed when the FE became
  // display-only for context: the FE renders whatever the backend ships in
  // ``private_context_entities`` (a Pydantic computed_field that merges
  // implicit projections + explicit attachments, server-side). To attach
  // something to a private context, use a dedicated backend action and let
  // the WS broadcast deliver the updated array. The FE never combines or
  // mutates context on its own.

  private _bucketView(bucket: 'private' | 'shared' | 'both'): TypeId[] {
    if (bucket === 'shared') return this.sharedContextEntities;
    if (bucket === 'private') return this.privateContextEntities;
    return [...this.sharedContextEntities, ...this.privateContextEntities];
  }

  /** All context entries of the given type. Default 'both' returns shared first then private. */
  public contextOfType(type: string, bucket: 'private' | 'shared' | 'both' = 'both'): TypeId[] {
    return this._bucketView(bucket).filter((t) => t.type === type);
  }

  /** First context entry of the given type, or null. */
  public firstContextOfType(type: string, bucket: 'private' | 'shared' | 'both' = 'both'): TypeId | null {
    return this._bucketView(bucket).find((t) => t.type === type) ?? null;
  }

  /**
   * Publish one or many TypeIds to this entity's *shared* context via the
   * backend ``share-context`` action. The frontend can't mutate
   * ``_shared_context_entities_`` directly — sharing is a backend decision
   * — so this is the canonical publish path.
   *
   * On success the backend returns the updated shared list; we apply it
   * locally so the next render sees the change without waiting for the WS
   * broadcast. Returns the post-update list as TypeIds.
   */
  public async shareContextEntities(input: TypeId | TypeId[]): Promise<TypeId[]> {
    const targets = this._normalizeContextEntities(input);
    if (targets.length === 0) return [...this._shared_context_entities_];
    const info = new ActionInfo('share-context', this.typeId.type, this.typeId.id, 'POST');
    info.bodyParameters =
      targets.length === 1
        ? { typeid: targets[0].toString() }
        : { typeids: targets.map((t) => t.toString()) };
    const result = await dataManager.callAction<
      { typeid?: string; typeids?: string[] },
      { ok: boolean; id: string; type: string; shared_context_entities: string[] }
    >(info);
    return this._applySharedFromResponse(result?.shared_context_entities);
  }

  /**
   * Remove one or many TypeIds from this entity's *shared* context via the
   * backend ``unshare-context`` action. Mirror of ``shareContextEntities``.
   */
  public async unshareContextEntities(input: TypeId | TypeId[]): Promise<TypeId[]> {
    const targets = this._normalizeContextEntities(input);
    if (targets.length === 0) return [...this._shared_context_entities_];
    const info = new ActionInfo('unshare-context', this.typeId.type, this.typeId.id, 'POST');
    info.bodyParameters =
      targets.length === 1
        ? { typeid: targets[0].toString() }
        : { typeids: targets.map((t) => t.toString()) };
    const result = await dataManager.callAction<
      { typeid?: string; typeids?: string[] },
      { ok: boolean; id: string; type: string; shared_context_entities: string[] }
    >(info);
    return this._applySharedFromResponse(result?.shared_context_entities);
  }

  /** Rebuild ``_shared_context_entities_`` from the wire response of a
   *  share/unshare-context call, notify subscribers, and return the new list. */
  private _applySharedFromResponse(payload: string[] | undefined): TypeId[] {
    if (!Array.isArray(payload)) return [...this._shared_context_entities_];
    const parsed: TypeId[] = [];
    for (const raw of payload) {
      try {
        parsed.push(new TypeId(raw));
      } catch {
        // Skip malformed entries from server.
      }
    }
    this._shared_context_entities_ = parsed;
    dataManager.notifyPropertyChanged(this.typeId, 'shared_context_entities');
    return [...parsed];
  }

  /**
   * Add a label to the entity using the label API.
   */
  public async add_label(label: string, description?: string, color?: string): Promise<boolean> {
    try {
      // POST to label action with the new label, returns full labels list
      const actionInfo = new ActionInfo('label', this.typeId.type, this.typeId.id, 'POST');
      actionInfo.subpath = label; // Include label name in URL path
      actionInfo.bodyParameters = {
        description: description,
        color: color,
      };

      const result = await dataManager.callAction<any, string[]>(actionInfo);

      // Update local labels with the returned full list
      if (Array.isArray(result)) {
        this.labels = result;
        this.dirty = true;
      }

      return true;
    } catch (error) {
      console.error('Failed to add label:', error);
      return false;
    }
  }

  /**
   * Remove a label from the entity using the label API.
   */
  public async remove_label(label: string): Promise<boolean> {
    try {
      // DELETE to label action with the label to remove, returns full labels list
      const actionInfo = new ActionInfo('label', this.typeId.type, this.typeId.id, 'DELETE');
      actionInfo.subpath = label; // Include label name in URL path

      const result = await dataManager.callAction<any, string[]>(actionInfo);

      // Update local labels with the returned full list
      if (Array.isArray(result)) {
        this.labels = result;
        this.dirty = true;
      }

      return true;
    } catch (error) {
      console.error('Failed to remove label:', error);
      return false;
    }
  }

  /**
   * Get all available labels from the ontology.
   */
  public async get_ontology_labels(): Promise<any[]> {
    try {
      const actionInfo = new ActionInfo('ontology', this.typeId.type, this.typeId.id, 'GET');
      const result = await dataManager.callAction(actionInfo);

      return (result as any)?.labels || [];
    } catch (error) {
      console.error('Failed to get ontology labels:', error);
      return [];
    }
  }

  /**
   * Get the first and closest ancestor by type using the entity scope.
   * Uses the same logic as breadcrumbs to find ancestors.
   */
  public async get_ancestor(ancestor_type: string): Promise<APIEntity<any> | null> {
    if (!this.saved) {
      return null;
    }

    // Get the current workspace from dataContext (same as breadcrumb logic)
    const { dataContext } = await import('./FlowSync/context');
    const workspaceTypeId = dataContext.workspaceTypeId;

    if (!workspaceTypeId) {
      return null;
    }

    // Get expanded entity with auth_scopes (same as breadcrumb logic)
    const expandedEntity = await dataManager.getByTypeId(
      this.typeId,
      new ExpansionRequest({ expand: ['auth_scopes'] }),
    );

    if (!expandedEntity) {
      return null;
    }

    // Find the workspace scope
    const selectedScope = expandedEntity.findWorkspaceScope(workspaceTypeId);

    // Search through the scope for the first entity of the requested type
    for (const currentTypeId of selectedScope) {
      if (currentTypeId.type === ancestor_type && currentTypeId.id !== this.id) {
        const ancestorEntity = await dataManager.getByTypeId(currentTypeId);
        if (ancestorEntity) {
          return ancestorEntity;
        }
      }
    }

    return null;
  }

  /**
   * Fetch the filesystem record refs for this entity.
   * Returns a Record with recordFolderRef (record folder) and mainRef (primary content).
   * Use ref.child() to navigate further: entity.record().then(r => r.mainRef?.child("subdir"))
   */
  public async record(): Promise<Record> {
    const actionInfo = new ActionInfo('record', this.typeId.type, this.typeId.id, 'GET');
    actionInfo.subpath = 'refs';
    const result = await dataManager.callAction<void, RecordRefs>(actionInfo);
    return new Record(result as RecordRefs);
  }

  /**
   * Set the public access for the entity.
   * @param isPublic - Whether the entity should be public or private.
   */
  public async setPublicAccess(isPublic: boolean): Promise<void> {
    const actionInfo = new ActionInfo('set_public_access', this.typeId.type, this.typeId.id, 'POST');
    actionInfo.bodyParameters = { is_public: isPublic };
    await dataManager.callAction<{ is_public: boolean }, { public: boolean }>(actionInfo);
  }

  static getLoadingExpansions() {
    const expansions: ExpansionType[] = ['permissions', 'auth_scopes'];
    const schema = dataManager.getSchema(this.type!);
    if (!schema) {
      console.warn('Schema not found for', this.type!);
    }
    if (schema?.hasBlobs) {
      expansions.push('blobs');
    }
    const expansion_request = new ExpansionRequest({
      expand: [...new Set([...expansions, ...this.autoLoadExpansions])],
    });
    return expansion_request;
  }

  /**
   * Load method called once when entity is first fetched.
   * Ensures only one load operation runs at a time by reusing the same promise.
   * Subclasses should override handleLoad() to implement loading logic.
   */
  async load(): Promise<void> {
    if (!this.saved || this.isLoaded) {
      return;
    }

    if (this._loadingPromise) {
      return this._loadingPromise;
    }

    this._loadingPromise = (async () => {
      try {
        await this.handleLoad();
        this._isLoaded = true;
      } catch (error) {
        this._loadingPromise = null;
        throw error;
      }
    })();

    return this._loadingPromise;
  }

  /**
   * Protected method that subclasses override to implement entity-specific loading logic.
   * This is called by load() and should not be called directly.
   * Default implementation does nothing.
   */
  protected async handleLoad(): Promise<void> {
    // Default implementation - override in subclasses
  }

  /**
   * Reload method that explicitly calls load() regardless of isLoaded flag.
   * Use this when you need to re-initialize the entity.
   */
  async reload(): Promise<void> {
    this._isLoaded = false;
    this._loadingPromise = null;
    await this.load();
  }

  // Event emitter methods

  /**
   * Register an event listener for one or more event types
   * @param eventType - Event type or array of event types to listen to
   * @param callback - Callback function to invoke when event fires
   * @returns Unsubscribe function to remove the listener
   */
  on(eventType: string | string[], callback: Callable): () => void {
    if (!Array.isArray(eventType)) {
      eventType = [eventType];
    }

    eventType.forEach((type) => {
      if (!this._eventListeners.has(type)) {
        this._eventListeners.set(type, []);
      }
      this._eventListeners.get(type)!.push(callback);
    });

    return () => eventType.forEach((type) => this.off(type, callback));
  }

  /**
   * Remove an event listener
   * @param eventType - Event type to remove listener from
   * @param callback - The callback function to remove
   */
  off(eventType: string, callback: Callable): void {
    const listeners = this._eventListeners.get(eventType);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index > -1) {
        listeners.splice(index, 1);
        // Clean up empty listener arrays
        if (listeners.length === 0) {
          this._eventListeners.delete(eventType);
        }
      }
    }
  }

  /**
   * Emit an event to all registered listeners
   * @param eventType - Event type to emit
   * @param data - Optional data to pass to listeners
   */
  emit(eventType: string, ...args: any[]): void {
    const listeners = this._eventListeners.get(eventType);
    if (listeners) {
      // Forward ALL args, not just the first. Several call sites emit multiple
      // values — e.g. onEntityEvent → emit('entity_event', event, payload) and
      // emit('status', newStatus, oldStatus). The previous single-`data` form
      // silently dropped every argument after the first, so consumers
      // subscribing via `on('entity_event', (event, payload) => ...)` received
      // an undefined payload. Single-arg emits are unaffected (callback(arg)).
      listeners.forEach((callback) => callback(...args));
    }
  }

  // FlowData stream methods

  /**
   * Get the default FlowData stream for this entity
   * Lazily creates the stream on first access to avoid overhead for entities that don't use it
   */
  get flowDataStream(): FlowDataStream {
    if (!this._flowDataStream) {
      this._flowDataStream = new FlowDataStream({
        id: `${this.getType()}-${this.id}-default`,
        name: `Default Stream for ${this.getType()}`,
      });
    }
    return this._flowDataStream;
  }

  /**
   * Handle incoming FlowData from WebSocket
   * Ingests to the entity's default stream (with consolidation) and emits 'flow_data' event
   * @param flowData - The FlowData to handle
   */
  handleFlowData(flowData: FlowData): void {
    this.flowDataStream.ingest(flowData);
    this.emit('flow_data', flowData);
  }

  /**
   * Mirror of Python `Entity.emit_entity_event` arriving over the WS transport.
   * Dispatched by `DataManager.onFlowData` for envelopes with
   * `element_type === 'entity_event'` — these never enter the flow-data stream
   * or renderer. Default impl re-emits as the `'entity_event'` event so callers
   * can subscribe via `entity.on('entity_event', (event, payload) => ...)`.
   * Subclasses may override for entity-specific dispatch (e.g. a typed handler
   * registry).
   */
  onEntityEvent(event: string, payload: Record<string, unknown>): void {
    this.emit('entity_event', event, payload);
  }
}

// Create the singleton DataManager instance
export const dataManager = new DataManager<APIEntity<any>>();

// Define store as a global for console debugability
defineGlobal('store', dataManager);

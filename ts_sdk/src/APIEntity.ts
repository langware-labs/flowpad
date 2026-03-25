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
import { defineGlobal } from './utils/globals';

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
        if (property !== 'dirty' && property !== '_dirty') {
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
  id: string;
  uname?: string;
  created_by?: string;
  created_date?: Date;
  updated_by?: string;
  updated_date?: Date;
  schema_version?: string;
  _expand?: EntityExpansion;
  _dirty: boolean = true;
  _typeId: TypeId | null = null;
  labels?: string[];
  root_vfs_path?: string;
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
      scope.forEach((typeId) => {
        if (typeId.type === Workspace.type) {
          workspaces.push(typeId);
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
      console.warn('isDbField: Schema not found, cant check blobs');
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
    let selectedScope = this.expand?.auth_scopes.find((scope) => {
      // Log to see the scope and typeId for debugging

      return scope.some((typeId) => {
        // Ensure workspaceTypeId is available and compare correctly
        if (workspaceTypeId) {
          return typeId.id === workspaceTypeId.id && typeId.type === workspaceTypeId.type;
        }
        return false;
      });
    });

    if (!selectedScope && this.expand?.auth_scopes?.length > 0) {
      selectedScope = this.expand?.auth_scopes[0];
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
  emit(eventType: string, data?: any): void {
    const listeners = this._eventListeners.get(eventType);
    if (listeners) {
      listeners.forEach((callback) => callback(data));
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
}

// Create the singleton DataManager instance
export const dataManager = new DataManager<APIEntity<any>>();

// Define store as a global for console debugability
defineGlobal('store', dataManager);

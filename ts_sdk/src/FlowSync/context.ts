import { EventEmitter } from 'events';
import { computed, makeObservable, observable, runInAction } from 'mobx';
import { v4 as uuidv4 } from 'uuid';
import apiClient from '../client';
import {
  ActionInfo,
  Agent,
  ExpansionRequest,
  Plugin,
  PluginManifest,
  QueryFilter,
  QueryRequest,
  Visitor,
  WebDomain,
} from '..';
import { AgenticProcess } from '../process/agentic-process';
import { APIEntity, dataManager } from '../APIEntity';
import { ComputeNode } from '../entities/compute_node';
import { Flow } from '../entities/flow';
import { IChatOptionsValues } from '../entities/flow/flow-types';
import { Project } from '../entities/project';
import { User } from '../entities/user';
import type { Shell } from '../entities/shell';
import { Workflow } from '../entities/workflow';
import { Workspace } from '../entities/workspace';
import { TypeId } from '../models/TypeId';
import { UserWarning } from '../models/UserWarning';
import { defineGlobal } from '../utils/globals';
import { SnifferHook } from '../services/sniffer-hook';
import { sdkConfig } from '../config/index';
import { ConnectionManager } from '../websocket';
import { AuthError, AuthEventType, authManager } from './auth';
import {
  getContextEntityFromLocalStorage,
  loadContextState,
  saveContextState,
  setContextEntityToLocalStorage,
} from './context-local-storage';
import { EntityFactory } from './factory';
import { EntityTypes } from '../schema/types';

export class FlowNotFoundError extends Error {
  constructor(message: string = 'Flow not found') {
    super(message);
    this.name = 'FlowNotFoundError';
  }
}

export class FlowAuthenticationError extends Error {
  constructor(message: string = 'Authentication required') {
    super(message);
    this.name = 'FlowAuthenticationError';
  }
}

export class FlowAccessDeniedError extends Error {
  constructor(message: string = 'Access denied') {
    super(message);
    this.name = 'FlowAccessDeniedError';
  }
}

export enum ContextEventType {
  CONTEXT_CHANGED = 'context_changed',
}

export const UIEvents = {
  NAVIGATE_TO_ENTITY: 'navigate-to-entity',
} as const;

export type UIEventType = (typeof UIEvents)[keyof typeof UIEvents];

export interface OntologyData {
  labels: Array<{
    label: string;
    description?: string;
    color?: string;
  }>;
}

export interface PluginEntry {
  manifest?: PluginManifest;
  personalInstall?: Plugin;
  workspaceInstall?: Plugin;
}

export enum ContextEntitiesEnum {
  CurrentWorkspaceTypeId = 'CurrentWorkspaceTypeId',
  CurrentFlowTypeId = 'CurrentFlowTypeId',
  CurrentProjectTypeId = 'CurrentProjectTypeId',
  CurrentComputeNodeTypeId = 'CurrentComputeNodeTypeId',
  CurrentUserTypeId = 'CurrentUserTypeId',
  CurrentActiveEntityTypeId = 'CurrentActiveEntityTypeId',
  CurrentDomainTypeId = 'CurrentDomainTypeId',
  CurrentVisitorTypeId = 'CurrentVisitorTypeId',
  CurrentAgentTypeId = 'CurrentAgentTypeId',
  CurrentWorkflowTypeId = 'CurrentWorkflowTypeId',
  CurrentProcessTypeId = 'CurrentProcessTypeId',
}

export interface CreateFlowOptions {
  /** Whether to set the flow in context (default: true) */
  setContext?: boolean;
  /** Initial chat options for the flow */
  chatOptions?: IChatOptionsValues;
}

class DataContext extends EventEmitter {
  stateItem = 'flowpad-state';
  persistedState: { [key: string]: TypeId } = {};

  private _contextEntitiesMap = observable.map<ContextEntitiesEnum, TypeId | null | undefined>([
    [ContextEntitiesEnum.CurrentWorkspaceTypeId, null],
    [ContextEntitiesEnum.CurrentFlowTypeId, null],
    [ContextEntitiesEnum.CurrentProjectTypeId, null],
    [ContextEntitiesEnum.CurrentComputeNodeTypeId, null],
    [ContextEntitiesEnum.CurrentUserTypeId, null],
    [ContextEntitiesEnum.CurrentActiveEntityTypeId, null],
    [ContextEntitiesEnum.CurrentDomainTypeId, null],
    [ContextEntitiesEnum.CurrentVisitorTypeId, null],
    [ContextEntitiesEnum.CurrentAgentTypeId, null],
    [ContextEntitiesEnum.CurrentWorkflowTypeId, null],
    [ContextEntitiesEnum.CurrentProcessTypeId, null],
  ]);

  // Bootstrap state - single source of truth for UI
  // This stores errors from SDK initialization (network, auth, service unavailable, etc.)
  bootstrapError: AuthError | null = null;
  isBootstrapping: boolean = true;
  bootstrapInfo: any = null; // Store the full bootstrap response including desktop_info

  // User warnings - displayed in the footer status line
  _warnings: UserWarning[] = [];

  /**
   * Get the environment name from bootstrap info
   */
  get envName(): string | null {
    return this.bootstrapInfo?.env?.env_name ?? null;
  }

  /**
   * Get the cloud API URL from bootstrap info
   */
  get cloudApiUrl(): string | null {
    return this.bootstrapInfo?.env?.cloud_api_url ?? null;
  }

  /**
   * Get whether cloud login is available (valid cloud token exists)
   */
  get cloudLoginAvailable(): boolean {
    return this.bootstrapInfo?.desktop_info?.cloud_login_available ?? false;
  }

  /**
   * Get the desktop info from bootstrap
   */
  get desktopInfo(): any {
    return this.bootstrapInfo?.desktop_info ?? null;
  }

  /**
   * Fetch cloud user info and set it as the active user in context.
   * Called fire-and-forget after bootstrap when cloudLoginAvailable is true.
   */
  async loadCloudUser(): Promise<void> {
    try {
      const data = await apiClient.get<{ logged_in: boolean; user: Record<string, unknown> }>('/auth/status');
      if (data?.logged_in && data.user) {
        const cloudUser = new User(data.user);
        cloudUser.markAsExpanded();
        await this.setContextEntityTypeId(ContextEntitiesEnum.CurrentUserTypeId, cloudUser.typeId);
      }
    } catch {
      // Non-critical — local user stays in context
    }
  }

  /**
   * Log out from the cloud account via the OAuth disconnect action.
   * The server clears local credentials and returns the cloud logout URL;
   * the OAuth service opens it in a browser window (same mechanism as login).
   */
  async cloudLogout(): Promise<void> {
    const { oauthService, OAUTH_PROVIDERS } = await import('../services/oauth/oauth-service');
    await oauthService.disconnect(OAUTH_PROVIDERS.FLOWPAD_CLOUD);
  }

  /**
   * Check if the environment is desktop
   */
  get isDesktop(): boolean {
    return this.envName?.toLowerCase() === 'desktop';
  }

  /**
   * Get the app version from bootstrap info
   */
  get version(): string | null {
    return this.bootstrapInfo?.env?.version ?? null;
  }

  /**
   * Get the current warnings list
   */
  get warnings(): UserWarning[] {
    return this._warnings;
  }

  /**
   * Add a warning to the list (replaces existing warning with same ID)
   */
  addWarning(warning: UserWarning): void {
    runInAction(() => {
      // Remove existing warning with same ID
      this._warnings = this._warnings.filter((w) => w.id !== warning.id);
      this._warnings.push(warning);
    });
    this.emit(ContextEventType.CONTEXT_CHANGED);
  }

  /**
   * Remove a warning by ID
   */
  removeWarning(warningId: string): void {
    runInAction(() => {
      this._warnings = this._warnings.filter((w) => w.id !== warningId);
    });
    this.emit(ContextEventType.CONTEXT_CHANGED);
  }

  /**
   * Set the entire warnings list (replaces all existing warnings)
   */
  setWarnings(warnings: UserWarning[]): void {
    runInAction(() => {
      this._warnings = warnings;
    });
    this.emit(ContextEventType.CONTEXT_CHANGED);
  }

  /**
   * Clear all warnings
   */
  clearWarnings(): void {
    runInAction(() => {
      this._warnings = [];
    });
    this.emit(ContextEventType.CONTEXT_CHANGED);
  }

  setSnifferHook(hook: SnifferHook | null): void {
    runInAction(() => {
      this.snifferHook = hook;
    });
  }

  setSnifferEnabled(value: boolean): void {
    runInAction(() => {
      this.snifferEnabled = value;
    });
    this.emit(ContextEventType.CONTEXT_CHANGED);
  }

  /**
   * Set the active shell session ID and notify subscribers
   */
  setActiveShellId(sessionId: string): void {
    if (this.activeShellId === sessionId) return;
    runInAction(() => {
      this.activeShellId = sessionId;
    });
    let shell: Shell | null = null;
    if (sessionId) {
      try {
        shell = dataManager.getByTypeIdFromCache<Shell>(new TypeId(EntityTypes.Shell, sessionId)) ?? null;
      } catch {
        // sessionId may not yet be a valid TypeId (e.g. during init)
      }
    }
    defineGlobal('shell', shell);
    this.emit(ContextEventType.CONTEXT_CHANGED);
  }

  setWorkdir(path: string | null): void {
    if (this.workdir === path) return;
    runInAction(() => {
      this.workdir = path;
    });
    this.emit(ContextEventType.CONTEXT_CHANGED);
  }

  // WebSocket connection - only set when connected
  connection: WebSocket | null = null;

  get isConnected(): boolean {
    return this.connection !== null;
  }

  // Active shell session ID - persisted across refreshes via URL
  activeShellId: string = '';

  // Active working directory — shown in the footer
  workdir: string | null = null;

  get activeEntityTypeId(): TypeId | null {
    return this.getContextEntityTypeId(ContextEntitiesEnum.CurrentActiveEntityTypeId);
  }

  get activeEntity(): APIEntity<any> | null {
    return this.getContextEntity(ContextEntitiesEnum.CurrentActiveEntityTypeId);
  }

  get someone(): TypeId | null {
    return this.userTypeId || this.visitorTypeId;
  }

  activeOntology: OntologyData | null = null;
  activeLabels: string[] = [];
  manifests: PluginManifest[] = [];
  plugins: Plugin[] = [];
  snifferHook: SnifferHook | null = null;
  snifferEnabled: boolean = false;

  constructor() {
    super();
    makeObservable(this, {
      user: computed,
      workspace: computed,
      activeEntity: computed,
      activeEntityTypeId: computed,
      workspaceTypeId: computed,
      userTypeId: computed,
      flowTypeId: computed,
      projectTypeId: computed,
      computeNodeTypeId: computed,
      domainTypeId: computed,
      visitorTypeId: computed,
      flow: computed,
      project: computed,
      computeNode: computed,
      domain: computed,
      visitor: computed,
      someone: computed,
      workflowTypeId: computed,
      workflow: computed,
      agenticProcessTypeId: computed,
      agenticProcess: computed,
      activeShell: computed,
      activeOntology: observable,
      bootstrapError: observable,
      isBootstrapping: observable,
      bootstrapInfo: observable,
      connection: observable,
      isConnected: computed,
      activeShellId: observable,
      workdir: observable,
      envName: computed,
      cloudApiUrl: computed,
      cloudLoginAvailable: computed,
      desktopInfo: computed,
      isDesktop: computed,
      version: computed,
      _warnings: observable,
      warnings: computed,
      snifferHook: observable,
      snifferEnabled: observable,
    });
    this.setupAuthListeners();
    this.setupConnectionListeners();
  }

  private setupAuthListeners() {
    // Listen to authManager events
    // authManager has already created/fetched entities and put them in dataManager cache
    authManager.on(AuthEventType.AUTH_STATUS_CHANGED, (user: User | null) => void this.handleAuthStatusChanged(user));
    authManager.on(AuthEventType.AUTH_ERROR, (error: AuthError) => void this.handleBootstrapError(error));
    authManager.on(AuthEventType.TOKEN_EXPIRED, () => void this.handleTokenExpired());
    authManager.on(
      AuthEventType.VISITOR_SUCCESS,
      (visitorData: { visitor_id?: string }) => void this.handleVisitorSuccess(visitorData),
    );
  }

  private async handleAuthStatusChanged(user: User | null) {
    runInAction(() => {
      this.bootstrapError = null;
      this.isBootstrapping = false;
    });

    if (user && user.typeId) {
      // User entity is already in dataManager cache
      // Just set the TypeId in context
      await this.setContextEntityTypeId(ContextEntitiesEnum.CurrentUserTypeId, user.typeId);
      // Clear visitor when user logs in
      await this.setContextEntityTypeId(ContextEntitiesEnum.CurrentVisitorTypeId, null);
    } else {
      // User logged out
      await this.setContextEntityTypeId(ContextEntitiesEnum.CurrentUserTypeId, null);
    }
    // setContextEntityTypeId already emits CONTEXT_CHANGED
  }

  private handleBootstrapError(error: AuthError) {
    runInAction(() => {
      this.bootstrapError = error;
      this.isBootstrapping = false;
    });
    this.emit(ContextEventType.CONTEXT_CHANGED);
  }

  private handleTokenExpired() {
    runInAction(() => {
      this.bootstrapError = null;
      this.isBootstrapping = false;
    });
    this.emit(ContextEventType.CONTEXT_CHANGED);
  }

  private async handleVisitorSuccess(visitorData: { visitor_id?: string }) {
    runInAction(() => {
      this.bootstrapError = null;
      this.isBootstrapping = false;
    });

    if (visitorData.visitor_id) {
      // Visitor entity should be in dataManager cache already
      const visitorTypeId = new TypeId('visitor', visitorData.visitor_id);
      await this.setContextEntityTypeId(ContextEntitiesEnum.CurrentVisitorTypeId, visitorTypeId);
    }
    // setContextEntityTypeId already emits CONTEXT_CHANGED
  }

  private setupConnectionListeners() {
    const connectionManager = ConnectionManager.getInstance();

    connectionManager.on('on_open', () => {
      runInAction(() => {
        this.connection = connectionManager.getSocket();
      });
      // Expose to window when connected
      defineGlobal('connection', this.connection);
      this.emit(ContextEventType.CONTEXT_CHANGED);
    });

    connectionManager.on('on_close', () => {
      runInAction(() => {
        this.connection = null;
      });
      // Remove from window when disconnected
      defineGlobal('connection', null);
      this.emit(ContextEventType.CONTEXT_CHANGED);
    });
  }

  activeEntityTypeId2ContextEnum(typeId: TypeId): ContextEntitiesEnum | null {
    switch (typeId.type) {
      case User.type:
        return ContextEntitiesEnum.CurrentUserTypeId;
      case Workspace.type:
        return ContextEntitiesEnum.CurrentWorkspaceTypeId;
      case Flow.type:
        return ContextEntitiesEnum.CurrentFlowTypeId;
      case Project.type:
        return ContextEntitiesEnum.CurrentProjectTypeId;
      case ComputeNode.type:
        return ContextEntitiesEnum.CurrentComputeNodeTypeId;
      case Agent.type:
        return ContextEntitiesEnum.CurrentAgentTypeId;
      case Workflow.type:
        return ContextEntitiesEnum.CurrentWorkflowTypeId;
      case AgenticProcess.type:
        return ContextEntitiesEnum.CurrentProcessTypeId;
      default:
        return null;
    }
  }

  get user(): User | null {
    return this.getContextEntity(ContextEntitiesEnum.CurrentUserTypeId) as User | null;
  }

  get workspace(): Workspace | null {
    const typeId = this.getContextEntityTypeId(ContextEntitiesEnum.CurrentWorkspaceTypeId);
    if (!typeId) {
      return null;
    }
    const result = this.getContextEntity(ContextEntitiesEnum.CurrentWorkspaceTypeId) as Workspace | null;
    return result;
  }
  async _onRemovedFromContext(_entityKey: ContextEntitiesEnum, _typeId: TypeId): Promise<void> {
    // Observable update and CONTEXT_CHANGED event are handled by setContextEntityTypeId after this completes
    // No need to update observable or emit here to avoid double updates/emissions
  }
  async _onAddedToContext(_entityKey: ContextEntitiesEnum, typeId: TypeId): Promise<void> {
    let entity = dataManager.getByTypeIdFromCache(typeId);
    if (!entity) {
      entity = await this.loadContextEntity(typeId);
    } else {
      await entity.load(); // tests mock flows never being fetched
      // Check if cached entity has required expansions
      const entityConstructor = EntityFactory.getEntityConstructor(typeId.type);
      const expansionRequest = (entityConstructor as typeof APIEntity).getLoadingExpansions();
      if (!entity.isExpanded(expansionRequest)) {
        // Entity exists in cache but doesn't have required expansions, reload it
        await this.loadContextEntity(typeId);
      }
    }
    if (_entityKey === ContextEntitiesEnum.CurrentFlowTypeId && entity) {
      defineGlobal('flow', entity);
    }
    if (_entityKey === ContextEntitiesEnum.CurrentWorkspaceTypeId && entity) {
      defineGlobal('workspace', entity);
    }
    // Load history for process entities when added to context
    if (_entityKey === ContextEntitiesEnum.CurrentProcessTypeId && entity instanceof AgenticProcess) {
      defineGlobal('process', entity);
      await entity.loadHistory();
    }
  }

  async setContextEntityTypeId(entityKey: ContextEntitiesEnum, newTypeId: TypeId | null): Promise<void> {
    const existingTypeId = this._contextEntitiesMap.get(entityKey);
    if (!existingTypeId && !newTypeId) {
      return;
    }
    if (existingTypeId && existingTypeId.equals(newTypeId)) {
      return;
    }

    if (existingTypeId) {
      if (!newTypeId) {
        await this._onRemovedFromContext(entityKey, existingTypeId);
      } else {
        await this._onAddedToContext(entityKey, newTypeId);
        await this._onRemovedFromContext(entityKey, existingTypeId);
      }
    } else {
      await this._onAddedToContext(entityKey, newTypeId!);
    }

    // Update observable AFTER ensuring entity is loaded with proper expansions
    runInAction(() => {
      this._contextEntitiesMap.set(entityKey, newTypeId);
    });

    setContextEntityToLocalStorage(entityKey, newTypeId);

    if (entityKey === ContextEntitiesEnum.CurrentWorkspaceTypeId && newTypeId) {
      defineGlobal('workspace', this.workspace);
    }
    // Load compute node when project is set
    if (entityKey === ContextEntitiesEnum.CurrentProjectTypeId && newTypeId) {
      void this.refreshProject();
    }

    // Emit CONTEXT_CHANGED event AFTER observable update so components get the updated values
    this.emit(ContextEventType.CONTEXT_CHANGED);
  }

  getContextEntityTypeId(entityKey: ContextEntitiesEnum): TypeId | null {
    return this._contextEntitiesMap.get(entityKey) ?? null;
  }

  getContextEntity(entityKey: ContextEntitiesEnum): APIEntity<any> | null {
    const typeId = this.getContextEntityTypeId(entityKey);
    if (!typeId) {
      return null;
    }

    const entity = dataManager.getByTypeIdFromCache<APIEntity<any>>(typeId);
    return entity ?? null;
  }

  get userTypeId(): TypeId | null {
    return this.getContextEntityTypeId(ContextEntitiesEnum.CurrentUserTypeId) ?? null;
  }

  get workspaceTypeId(): TypeId | null {
    return this.getContextEntityTypeId(ContextEntitiesEnum.CurrentWorkspaceTypeId) ?? null;
  }

  get flowTypeId(): TypeId | null {
    return this.getContextEntityTypeId(ContextEntitiesEnum.CurrentFlowTypeId) ?? null;
  }

  get projectTypeId(): TypeId | null {
    return this.getContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId) ?? null;
  }

  get computeNodeTypeId(): TypeId | null {
    return this.getContextEntityTypeId(ContextEntitiesEnum.CurrentComputeNodeTypeId) ?? null;
  }

  get agentTypeId(): TypeId | null {
    return this.getContextEntityTypeId(ContextEntitiesEnum.CurrentAgentTypeId) ?? null;
  }

  get flow(): Flow | null {
    return this.getContextEntity(ContextEntitiesEnum.CurrentFlowTypeId) as Flow | null;
  }

  get project(): Project | null {
    return this.getContextEntity(ContextEntitiesEnum.CurrentProjectTypeId) as Project | null;
  }

  get computeNode(): ComputeNode | null {
    return this.getContextEntity(ContextEntitiesEnum.CurrentComputeNodeTypeId) as ComputeNode | null;
  }

  /** Lazily-hydrated @sandbox compute node from bootstrap (E2B-backed). Null when E2B is not configured. */
  private _sandboxComputeNode: ComputeNode | null = null;
  get sandboxComputeNode(): ComputeNode | null {
    if (!this.bootstrapInfo?.sandbox_available || !this.bootstrapInfo?.sandbox_compute_node) {
      return null;
    }
    if (this._sandboxComputeNode === null) {
      this._sandboxComputeNode = new ComputeNode(this.bootstrapInfo.sandbox_compute_node as any);
      this._sandboxComputeNode.markAsExpanded();
    }
    return this._sandboxComputeNode;
  }

  get domainTypeId(): TypeId | null {
    return this.getContextEntityTypeId(ContextEntitiesEnum.CurrentDomainTypeId) ?? null;
  }

  get domain(): APIEntity<WebDomain> | null {
    return this.getContextEntity(ContextEntitiesEnum.CurrentDomainTypeId);
  }

  get visitorTypeId(): TypeId | null {
    return this.getContextEntityTypeId(ContextEntitiesEnum.CurrentVisitorTypeId) ?? null;
  }

  get visitor(): APIEntity<Visitor> | null {
    return this.getContextEntity(ContextEntitiesEnum.CurrentVisitorTypeId);
  }

  get workflowTypeId(): TypeId | null {
    return this.getContextEntityTypeId(ContextEntitiesEnum.CurrentWorkflowTypeId) ?? null;
  }

  get workflow(): Workflow | null {
    return this.getContextEntity(ContextEntitiesEnum.CurrentWorkflowTypeId) as Workflow | null;
  }

  get agenticProcessTypeId(): TypeId | null {
    return this.getContextEntityTypeId(ContextEntitiesEnum.CurrentProcessTypeId) ?? null;
  }

  get agenticProcess(): AgenticProcess | null {
    return this.getContextEntity(ContextEntitiesEnum.CurrentProcessTypeId) as AgenticProcess | null;
  }

  get activeShell(): Shell | null {
    if (!this.activeShellId) return null;
    return dataManager.getByTypeIdFromCache<Shell>(new TypeId(EntityTypes.Shell, this.activeShellId)) ?? null;
  }

  // @ts-ignore - Intentionally unused, reserved for future use
  private _saveStateToLocalStorage() {
    this.persistedState = saveContextState(this.persistedState, this);
  }

  // @ts-ignore - Intentionally unused, reserved for future use
  private _loadStateFromLocalStorage() {
    this.persistedState = loadContextState();
  }

  async initContext(options?: { setupWorkspace?: boolean; setupProject?: boolean }) {
    this._loadStateFromLocalStorage();
    if (options?.setupWorkspace) {
      await this.setupWorkspace();
    }
    if (options?.setupProject) {
      await this.setupProject();
    }
  }

  async getUserWorkspaces(): Promise<Workspace[]> {
    const query = new ExpansionRequest({ expand: ['permissions'] });
    const filter = new QueryFilter(query);
    const request = new QueryRequest({
      type: 'workspace',
      query: filter,
      name: 'context getUserWorkspaces query',
    });
    return await Workspace.query(request);
  }

  async createNewUserWorkspace(): Promise<Workspace> {
    if (!this.user) {
      throw new Error('Cannot create workspace without user');
    }
    const query = new ExpansionRequest({ expand: ['permissions'] });
    const workspace = new Workspace({ name: this.user.name + ' Workspace' });
    await workspace.save();
    const expanded = await dataManager.getByTypeId<Workspace>(workspace.typeId, query);
    if (!expanded) {
      throw new Error('Failed to load new workspace');
    }
    return expanded;
  }

  async setupWorkspace() {
    if (!this.userTypeId) {
      return;
    }

    const workspaces = await this.getUserWorkspaces();

    if (workspaces.length === 0) {
      const newWorkspace = await this.createNewUserWorkspace();
      workspaces.push(newWorkspace);
    }

    // Check if there's a persisted workspace in localStorage
    const persistedWorkspaceTypeId = getContextEntityFromLocalStorage(ContextEntitiesEnum.CurrentWorkspaceTypeId);

    if (persistedWorkspaceTypeId && workspaces.some((workspace) => workspace.typeId.equals(persistedWorkspaceTypeId))) {
      await this.setContextEntityTypeId(ContextEntitiesEnum.CurrentWorkspaceTypeId, persistedWorkspaceTypeId);
    } else {
      // Fallback to personal workspace (where user is owner)
      const myWorkspace = workspaces.find((ws) => ws.ImOwner);
      if (myWorkspace) {
        await this.setContextEntityTypeId(ContextEntitiesEnum.CurrentWorkspaceTypeId, myWorkspace.typeId);
      } else if (workspaces.length > 0) {
        await this.setContextEntityTypeId(ContextEntitiesEnum.CurrentWorkspaceTypeId, workspaces[0]?.typeId);
      } else {
        await this.setContextEntityTypeId(ContextEntitiesEnum.CurrentWorkspaceTypeId, null);
      }
    }

    // Verify workspace is actually available
    const workspaceTypeId = this.getContextEntityTypeId(ContextEntitiesEnum.CurrentWorkspaceTypeId);
    const workspaceEntity = workspaceTypeId ? dataManager.getByTypeIdFromCache<Workspace>(workspaceTypeId) : null;

    // Force MobX to re-evaluate by accessing the getter
    const workspaceFromGetter = this.workspace;

    if (workspaceTypeId && !workspaceEntity) {
      await this.loadContextEntity(workspaceTypeId);
    } else if (workspaceTypeId && workspaceEntity && !workspaceFromGetter) {
      // Entity is in cache but getter returns null - likely missing required expansions
      // Wait for _onAddedToContext to finish loading with proper expansions
      const entityConstructor = EntityFactory.getEntityConstructor(workspaceTypeId.type);
      const expansionRequest = (entityConstructor as typeof APIEntity).getLoadingExpansions();
      const isExpanded = workspaceEntity.isExpanded(expansionRequest);

      if (!isExpanded) {
        await this.loadContextEntity(workspaceTypeId);
      }
    }
  }

  async setupProject() {
    // Skip if no user logged in
    if (!this.userTypeId) {
      return;
    }

    // Check localStorage first - it has the user's last selected project
    const persistedProjectTypeId = getContextEntityFromLocalStorage(ContextEntitiesEnum.CurrentProjectTypeId);

    // If persisted project matches current, nothing to do
    if (persistedProjectTypeId && this.project?.typeId.equals(persistedProjectTypeId)) {
      return;
    }

    // Skip query if no persisted project and we already have a project from bootstrap
    if (!persistedProjectTypeId && this.project) {
      return;
    }

    // Fetch user's projects to validate persisted one or find fallback
    const query = new QueryRequest({
      type: Project.type,
      name: 'context setupProject query',
    });
    const projects = await Project.query(query);

    if (projects.length === 0) {
      return;
    }

    // Restore persisted project if it exists, otherwise fall back to first available
    let targetProject = persistedProjectTypeId
      ? projects.find((project) => project.typeId.equals(persistedProjectTypeId))
      : null;
    targetProject ??= projects[0];

    await this.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, targetProject.typeId);
  }

  private async setComputeNode(computeNode: ComputeNode | null) {
    defineGlobal('computeNode', computeNode);
    await this.setContextEntityTypeId(ContextEntitiesEnum.CurrentComputeNodeTypeId, computeNode?.typeId ?? null);
  }

  async refreshProject() {
    if (!this.project) {
      await this.setComputeNode(null);
      return;
    }
    // Compute node is always set from bootstrap — never fetch it separately.
    defineGlobal('project', this.project);
    defineGlobal('project', this.project);
  }
  async loadContextEntity(typeId: TypeId) {
    if (typeof typeId === 'string') {
      typeId = new TypeId(typeId);
    }
    const entityConstructor = EntityFactory.getEntityConstructor(typeId.type);
    const query = (entityConstructor as typeof APIEntity).getLoadingExpansions();
    const fetchEntity = await dataManager.getByTypeId(typeId, query);
    return fetchEntity ?? null;
  }
  async loadFlow(typeId: TypeId): Promise<Flow> {
    const query = new ExpansionRequest({ expand: ['permissions', 'auth_scopes'] });
    const flow: Flow | null = await dataManager.getByTypeId<Flow>(typeId, query);

    if (!flow) {
      throw new FlowNotFoundError('Flow not found');
    }

    try {
      //await flow.load();
      await this.setContextEntityTypeId(ContextEntitiesEnum.CurrentFlowTypeId, flow.typeId);
      if (flow.workspace_id) {
        await this.setContextEntityTypeId(
          ContextEntitiesEnum.CurrentWorkspaceTypeId,
          new TypeId(Workspace.type, flow.workspace_id),
        );
      }
      if (flow.projectTypeId) {
        await this.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, flow.projectTypeId);
        await this.refreshProject();
      }
      return flow;
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
        const errorMessage = (error as { response?: { data?: { message?: string } } }).response?.data?.message || '';
        const isEntityNotFound = errorMessage.includes('Target entity not found');

        if (isEntityNotFound) {
          throw new FlowAccessDeniedError('Flow not found or access denied');
        }

        throw new FlowAuthenticationError('Authentication required');
      }

      throw error;
    }
  }

  async setActiveEntityTypeId(activeEntityTypeId: TypeId | null) {
    // Validate non-null TypeId has both type and id
    if (activeEntityTypeId !== null && (!activeEntityTypeId.type || !activeEntityTypeId.id)) {
      console.error('Invalid typeId navigation', activeEntityTypeId);
      return;
    }
    const contextEnum = activeEntityTypeId ? this.activeEntityTypeId2ContextEnum(activeEntityTypeId) : null;
    if (contextEnum) {
      await this.setContextEntityTypeId(contextEnum, activeEntityTypeId);
    }
    await this.setContextEntityTypeId(ContextEntitiesEnum.CurrentActiveEntityTypeId, activeEntityTypeId);
  }

  /**
   * Creates a new Flow and optionally sets it as the current flow in context.
   * The flow is NOT saved to the backend - it will be saved on first message.
   * @param workspaceId - Optional workspace ID. If not provided, uses current workspace (best effort).
   * @param options - Optional settings for flow creation.
   * @param options.setContext - Whether to set the flow in context (default: true).
   * @returns The created Flow.
   */
  createFlow(workspaceId?: string, options?: CreateFlowOptions): Flow {
    const { setContext = true } = options ?? {};
    const wsId = workspaceId ?? this.workspace?.id;
    const newFlow = new Flow({ workspace_id: wsId });
    if (setContext) {
      void this.setContextEntityTypeId(ContextEntitiesEnum.CurrentFlowTypeId, newFlow.typeId);
    }
    return newFlow;
  }

  async createProjectAndFlow(options?: CreateFlowOptions): Promise<{ processId: string; projectId: string }> {
    if (!this.someone) {
      throw new Error('No one is logged in');
    }
    if (!this.agentTypeId?.id) {
      throw new Error('No agent in context');
    }
    const { setContext = true, chatOptions } = options ?? {};
    const newProjectId = uuidv4();
    const newProject = new Project({ id: newProjectId });
    await newProject.save([this.someone]);

    // Use Project.createFlow method
    const flowTypeId = await newProject.createFlow(this.agentTypeId.id);

    const project = dataManager.getByTypeIdFromCache<Project>(new TypeId(Project.type, newProjectId));
    if (!project) {
      throw new Error('Project not found');
    }
    const flow = dataManager.getByTypeIdFromCache<Flow>(flowTypeId);
    if (!flow) {
      throw new Error('Flow not found');
    }

    flow.markAsExpanded();
    flow._isLoaded = true;

    // Apply chat options to flow if provided
    if (chatOptions) {
      flow.options.applyValues(chatOptions);
    }

    if (setContext) {
      void this.setContextEntityTypeId(ContextEntitiesEnum.CurrentFlowTypeId, flow.typeId);
      void this.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, project.typeId);
      void this.refreshProject();
    }
    return { processId: flowTypeId.id, projectId: newProjectId };
  }

  async refreshOntology() {
    if (!this.activeEntity) {
      this.activeOntology = null;
      this.emit(ContextEventType.CONTEXT_CHANGED);
      return;
    }

    try {
      const actionInfo = new ActionInfo('ontology', this.activeEntity.typeId.type, this.activeEntity.typeId.id, 'GET');
      const result = await dataManager.callAction(actionInfo);
      runInAction(() => {
        this.activeOntology = (result as any)?.data || this.getCurrentOntology();
      });
      this.emit(ContextEventType.CONTEXT_CHANGED);
    } catch (error) {
      console.error('Error fetching ontology, using mock data:', error);
      runInAction(() => {
        this.activeOntology = this.getCurrentOntology();
      });
      this.emit(ContextEventType.CONTEXT_CHANGED);
    }
  }

  private getCurrentOntology(): OntologyData {
    // TODO, Connect the Ontology management
    return {
      labels: [
        { label: 'task.priority.high', description: 'High priority tasks', color: '#dc2626' },
        { label: 'task.priority.medium', description: 'Medium priority tasks', color: '#f59e0b' },
        { label: 'task.priority.low', description: 'Low priority tasks', color: '#10b981' },
        { label: 'project.status.active', description: 'Active projects', color: '#3b82f6' },
        { label: 'project.status.completed', description: 'Completed projects', color: '#6b7280' },
        { label: 'project.status.on-hold', description: 'Projects on hold', color: '#f97316' },
        { label: 'feature.type.enhancement', description: 'Feature enhancements', color: '#8b5cf6' },
        { label: 'feature.type.bug-fix', description: 'Bug fixes', color: '#ef4444' },
        { label: 'feature.type.new', description: 'New features', color: '#06b6d4' },
        { label: 'team.frontend', description: 'Frontend team', color: '#14b8a6' },
        { label: 'team.backend', description: 'Backend team', color: '#f59e0b' },
        { label: 'team.design', description: 'Design team', color: '#ec4899' },
      ],
    };
  }
}

export const dataContext = new DataContext();

// Define context as a global for console debugability
defineGlobal('context', dataContext);
defineGlobal('ctx', dataContext);
defineGlobal('dataContext', dataContext);

import { decode, encode } from '@msgpack/msgpack';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { ApiError, isApiError } from '../ApiResponse';
import apiClient, { apiStats, clearStats, GRAPH_API_PREFIX } from '../client';
import config from '../config';
import { IEntity } from '../IEntity';
import { ActionInfo, BootstrapInfo, ScanInfo } from '../models';
import { TypeId } from '../models/TypeId';
import { UserRole } from '../services/membershipService';
import {
  ConnectionManager,
  ControlMessage,
  DataOpType,
  OAuthMessage,
  PtyOutputMessage,
  RestApiMessage,
  TranscriptMessage,
} from '../websocket';
import { FlowData, FlowDataSource } from '../flow_processing';
import { getUtmParams } from './auth';
import { ExpansionType } from './expand';
import { EntityFactory } from '../schema/factory';
import { SubscriptionMap, TypeIdMap, WatchMap, WatchQueryMap } from './map';
import { ExpansionRequest, QueryRequest } from './query';
import { ActionType, JSONSchemaParser } from './schema';
import { IStream, IStreamConfig, WSStream } from './stream';
import { ptyOrphanBuffer } from '../services/shell/ptyOrphanBuffer';

export enum EntityStatus {
  NA = 'NA',
  FETCHING = 'FETCHING',
  READY = 'READY',
  ERROR = 'ERROR',
}

export interface EntityExpansion {
  roles?: UserRole[] | null;
  allowed_actions?: ActionType[] | null;
  auth_scopes?: string[][] | null;
  is_private?: boolean;
  expansions?: ExpansionType[] | null;
}

interface PendingPromise<T> {
  resolve: (value: T | null) => void;
  reject: (reason: any) => void;
}

class EntityRef<T> {
  status: EntityStatus = EntityStatus.NA;
  error: ApiError | null = null;
  entity: T | null = null;
  entityPendingPromises: PendingPromise<T>[] = [];
  pendingUpdate: any = null;

  constructor(entity: T | null = null) {
    this.entity = entity;
  }
}

export interface Manageable {
  typeId: TypeId;
  dirty: boolean;
  get saved(): boolean;
  load(): Promise<void>;
  toJSON(): any;
  expand?: EntityExpansion;
  isExpanded(expansion: ExpansionType | ExpansionType[] | ExpansionRequest): boolean;
  isDbField(fieldName: string): boolean;
}

export class DataManager<T extends Manageable> extends EventEmitter {
  entities: TypeIdMap<EntityRef<T>> = new TypeIdMap<EntityRef<T>>();

  schemas: { [type: string]: JSONSchemaParser } = {};
  streams: WSStream[] = [];
  saveIntervalMs: number = 5000;
  isPopupOpen = false;
  dataOpQueryInvalidation = false;
  private subscriptions: SubscriptionMap<T> = new SubscriptionMap<T>();
  private _inFlightGets: Map<string, Promise<unknown>> = new Map();
  private watches: WatchMap = new WatchMap();
  private watchedQueries: WatchQueryMap<T> = new WatchQueryMap<T>();
  private streamingRequestsCount: number = 0;
  scanInfo: ScanInfo | null = null;
  recordsRoot: string | null = null;

  constructor() {
    super();
    this.attach_connection_manager(ConnectionManager.getInstance());
    // Schedule the repeated function call every 5 seconds
    //setInterval(() => this.onSaveAllDirty(), this.saveIntervalMs);
  }

  public attach_connection_manager(manager: ConnectionManager) {
    manager.on('on_open', this.onConnectionOpen.bind(this));
    manager.on('on_close', this.onConnectionClose.bind(this));
    manager.on('on_data_op', this.onDataOp.bind(this));
    manager.on('on_stream_msg', this.onStreamMessage.bind(this));
    manager.on('on_bin_msg', this.onBinMessage.bind(this));
    manager.on('on_control_msg', this.onControlMessage.bind(this));
    manager.on('on_oauth_msg', this.onOAuthMessage.bind(this));
    manager.on('on_pty_output_msg', this.onPtyOutputMessage.bind(this));
    manager.on('on_flow_data', this.onFlowData.bind(this));
  }

  public detach_connection_manager(manager: ConnectionManager) {
    manager.off('on_open', this.onConnectionOpen.bind(this));
    manager.off('on_close', this.onConnectionClose.bind(this));
    manager.off('on_data_op', this.onDataOp.bind(this));
    manager.off('on_stream_msg', this.onStreamMessage.bind(this));
    manager.off('on_bin_msg', this.onBinMessage.bind(this));
    manager.off('on_control_msg', this.onControlMessage.bind(this));
    manager.off('on_oauth_msg', this.onOAuthMessage.bind(this));
    manager.off('on_pty_output_msg', this.onPtyOutputMessage.bind(this));
    manager.off('on_flow_data', this.onFlowData.bind(this));
  }

  public getSchema(type: string): JSONSchemaParser {
    return this.schemas[type.toLowerCase()];
  }

  public async loadSchemas(allSchemasJson?: any) {
    if (!Array.isArray(allSchemasJson)) {
      try {
        allSchemasJson = await apiClient.get(config.API_PREFIXES.schema);
        if (!allSchemasJson) {
          return null;
        }
      } catch (error) {
        console.error('Error loading schemas', error);
        throw error;
      }
    }
    for (const schemaJson of allSchemasJson) {
      const schema = new JSONSchemaParser(schemaJson);
      if (!schema.entity_type) {
        console.warn('Schema does not have a type property', schemaJson);
        continue;
      }
      if (this.schemas[schema.entity_type]) {
        // console.warn(
        //   `Schema already loaded for type: ${schema.entity_type}, skipping`,
        // );
        continue;
      }
      this.schemas[schema.entity_type] = schema;
    }
    return allSchemasJson;
  }

  setScanInfo(info: ScanInfo): void {
    this.scanInfo = info;
    this.emit('scan_info_changed', info);
  }

  onScanInfoChange(callback: (info: ScanInfo) => void): () => void {
    this.on('scan_info_changed', callback);
    return () => this.off('scan_info_changed', callback);
  }

  async refreshScanInfo(): Promise<void> {
    try {
      const raw = await apiClient.get<any>('/graph/compute_node/@local/fs-records/index-status');
      this.setScanInfo({
        total_indexed: raw?.per_type?.reduce((s: number, t: any) => s + (t.entity_count ?? 0), 0) ?? 0,
        last_indexed_at: raw?.last_indexed_at ?? null,
        never_indexed: raw?.never_indexed ?? true,
        stale: raw?.stale ?? false,
      });
    } catch { /* non-fatal */ }
  }

  public async bootstrap(domain?: string, session?: boolean): Promise<BootstrapInfo> {
    const actionInfo = new ActionInfo('bootstrap');
    const queryParams: any = {};

    if (domain) {
      queryParams.domain = domain;
    }
    if (session !== undefined) {
      queryParams.session = session;
    }

    // Add UTM params from current URL
    const utmParams = getUtmParams();
    Object.assign(queryParams, utmParams);

    if (Object.keys(queryParams).length > 0) {
      actionInfo.queryParameters = queryParams;
    }

    try {
      const info = await this.callAction<null, BootstrapInfo>(actionInfo);
      if (info.scan_info) this.setScanInfo(info.scan_info);
      if (info.records_root) this.recordsRoot = info.records_root;
      return info;
    } catch (error: any) {
      console.error('Error calling bootstrap action:', error);
      // Re-throw all errors so they can be handled by initSdk and displayed to the user
      throw error;
    }
  }

  get schemaLoaded() {
    return Object.keys(this.schemas).length > 0;
  }

  private onConnectionOpen() {
    // Reset watch counts so watch() re-POSTs to the backend with the new connection_id.
    // After a reconnect the backend has lost all watch registrations.
    const watchedTypeIds = Array.from(this.watches.keys());
    this.watches.clear();
    for (const typeId of watchedTypeIds) {
      void this.watch(typeId);
    }
  }

  private onConnectionClose() {
    // Reconnection is handled solely by ConnectionManager.reconnect().
    // Do not call connect() here — a second caller races with ConnectionManager
    // and creates duplicate WebSocket instances (same connection_id, two sockets).
  }
  public async createStream(config: IStreamConfig): Promise<WSStream | null> {
    const connection_manager = ConnectionManager.getInstance();
    if (!connection_manager.connected) {
      console.warn('Connection not established, can not create stream');
      return null;
    }
    const actionInfo = new ActionInfo('ws_stream');
    actionInfo.method = 'POST';
    actionInfo.bodyParameters = { stream_info: config };
    const iStream = await this.callAction<any, IStream>(actionInfo);
    iStream.config = config;
    const stream = new WSStream(iStream);
    if (this.streams[iStream.id]) {
      console.warn('Stream already exists', iStream.id);
    }
    stream.on('ON_SEND', async (data: Blob) => {
      const socket = connection_manager.getSocket();
      if (!socket) {
        console.warn('Socket not found, can not send stream data');
        return;
      }
      const dataBuffer = new Uint8Array(await data.arrayBuffer());
      const msg = encode([iStream.id, dataBuffer]);
      socket.send(msg);
    });
    stream.on('ON_CLOSE', async () => {
      await this.closeStream(iStream.id);
    });
    this.streams[iStream.id] = stream;
    return stream;
  }
  public async closeStream(stream_id: number) {
    const actionInfo = new ActionInfo('delete_ws_stream');
    actionInfo.method = 'DELETE';
    actionInfo.queryParameters = { stream_id };
    await this.callAction<any, any>(actionInfo);
    this.streams.splice(stream_id, 1);
  }

  private async onBinMessage(data: ArrayBuffer) {
    if (!data) {
      console.warn('Stream bin message is empty', data);
      return;
    }
    // const arrayBuffer = new Uint8Array(await data.arrayBuffer());
    const decoded = decode(data);
    if (!decoded || !Array.isArray(decoded) || decoded.length < 2) {
      console.warn('Stream bin message is invalid', decoded);
      return;
    }
    const stream_id = decoded[0];
    const stream = this.streams[stream_id];
    if (!stream) {
      console.warn('Stream not found on binary message', data);
    }
    // const byteArray = decoded[1]
    // let byteString = '';
    // for (let i = 0; i < byteArray.length; i++) {
    //   byteString += byteArray[i].toString(16).padStart(2, '0') + ' ';
    // }
    await stream.handleBinMessage(decoded[1]);
  }

  private async onStreamMessage(data: TranscriptMessage) {
    if (!data) {
      console.warn('Stream message is empty', data);
      return;
    }
    if (!data.stream_id) {
      console.warn('Stream ID is empty', data);
    }
    const stream = this.streams[data.stream_id];
    if (!stream) {
      console.warn('Stream not found', data);
    }
    await stream.handleMessage(data);
  }

  private onControlMessage(data: ControlMessage) {
    this.isPopupOpen = data.state;
  }
  private onOAuthMessage(data: OAuthMessage) {
    this.emit('on_oauth_msg', data);
  }
  private onPtyOutputMessage(msg: PtyOutputMessage): void {
    const shellId = (msg as any).shell_id ?? (msg as any).session_id ?? '';
    if (!shellId) return;
    const typeId = new TypeId('shell', shellId);
    const ref = this.entities.get(typeId);
    const shell = ref?.entity as any;
    if (shell?.ptyConnection) {
      // Fast path: route directly through PtyConnection (always present on Shell).
      const decoded = shell.ptyConnection.routeOutput(msg.data ?? '', msg.seq, msg.timestamp_ms);
      if (decoded !== null) {
        this.emit('on_pty_decoded', shellId, decoded);
      }
    } else if (typeof shell?.routePtyOutput === 'function') {
      // Compat path: non-Shell entities that implement routePtyOutput.
      const decoded = shell.routePtyOutput(msg.data ?? '', msg.seq, msg.timestamp_ms);
      if (decoded !== null) {
        this.emit('on_pty_decoded', shellId, decoded);
      }
    } else {
      // Shell not yet in entity cache — buffer for when it arrives.
      ptyOrphanBuffer.buffer(shellId, msg.data ?? '', msg.seq, msg.timestamp_ms);
    }
  }

  private onFlowData(typeId: TypeId, flowDataJson: any) {
    // Get entity from cache
    const entity = this.getByTypeIdFromCache<T>(typeId);
    if (!entity) {
      console.debug(`[DataManager.onFlowData] Entity not found in cache for typeId: ${typeId.toString()}`);
      return;
    }

    // Create FlowData from JSON
    const elementType = flowDataJson.element_type || flowDataJson.elementType || 'notification';
    const attributes = flowDataJson.attributes || {};
    // Backend sends content as 'flow_value', fallback to 'content' for compatibility
    const content = flowDataJson.flow_value ?? flowDataJson.content ?? '';

    // Set timestamp if not present
    if (!attributes['t']) {
      attributes['t'] = new Date().toISOString();
    }

    const flowData = new FlowData(elementType, content, attributes);
    // The FlowData constructor already reads `attributes['source']` and sets
    // `flowData.source` to the matching FlowDataSource enum value (or
    // FlowDataSource.Unknown when absent). For backend-translated events
    // (sniffer hooks via convert_hook_event, history replay, etc.) the
    // source is set authoritatively upstream, so we respect it here. Only
    // events that don't carry a source attribute (legacy WS-only paths) get
    // tagged as WebSocket.
    if (flowData.source === FlowDataSource.Unknown) {
      flowData.source = FlowDataSource.WebSocket;
    }

    // Route to entity's handleFlowData method if it exists
    if (typeof (entity as any).handleFlowData === 'function') {
      (entity as any).handleFlowData(flowData);
    }
  }

  private onDataOp(typeIdStr: string, op: DataOpType, data: IEntity) {
    const typeId = new TypeId(typeIdStr);
    // Skip non-entity data (e.g., flow report elements that have element_type but no id)
    // These are handled by other listeners (e.g., instruction trace handlers)
    // Note: delete operations may have null/empty data, so we only skip for non-delete ops
    if (op !== 'delete' && (!data || !('id' in data))) {
      return;
    }

    const ctor = EntityFactory.getEntityConstructor(typeId.type);
    if (!ctor) {
      console.warn(`Data op messages ignored, Entity constructor not found for type: ${typeId.type}`);
      return;
    }
    // Handle delete operation by removing from all query results
    if (op === 'delete') {
      this.watchedQueries.removeEntityFromResults(typeId.type, typeId);
    } else if (op === 'create' || this.dataOpQueryInvalidation) {
      // For create operations, always update watched queries so new entities appear in lists.
      // For other ops (update), only invalidate if dataOpQueryInvalidation is enabled.
      const watchedQueries = this.watchedQueries.getWatchCallbacksByType(typeId.type);

      for (const watchedQuery of watchedQueries) {
        if (!watchedQuery.request.query || watchedQuery.request.query.validate(data)) {
          // Rerun query and update results through WatchedQuery
          void this._query(watchedQuery.request).then((queryResult) => {
            watchedQuery.updateResults(queryResult);
          });
        }
      }
    }

    switch (op) {
      case 'create': {
        const entity = this.castAndDeepAssign(data);
        this.register_new_entity(typeId, entity);
        this._notifyAllAliases(typeId, entity, entity);
        break;
      }
      case 'update': {
        if (!this.hasRef(typeId)) {
          return;
        }
        const ref = this.getRef(typeId);
        if (!ref.entity) {
          // Entity fetch is in-flight — buffer the update; fetchByTypeId will apply it on completion
          ref.pendingUpdate = data;
          return;
        }
        ref.entity = this.castAndDeepAssign(data);
        ref.status = EntityStatus.READY;
        // Aliases share the same `ref` so cache reads stay consistent automatically;
        // subscribers on alias keys still need to be notified.
        this._notifyAllAliases(typeId, ref.entity, ref.entity);
        break;
      }
      case 'delete': {
        const ref = this.entities.get(typeId);
        const entity = ref?.entity ?? null;
        this._deleteWithAliases(typeId);
        this._notifyAllAliases(typeId, entity, null);
        break;
      }
    }
    this.resolvePendingRequests();
  }

  async saveAllDirty() {
    for (const entityRef of this.entities.values()) {
      if (entityRef.entity?.saved && entityRef.entity?.dirty) {
        await this.save(entityRef.entity.typeId);
      }
    }
  }

  public async clearCache() {
    for (const typeId of this.entities.keys()) {
      this.subscriptions.get(typeId)?.forEach((cb) => void cb(null));
      this.entities.delete(typeId);
    }
  }

  public async reset() {
    await this.clearCache();
    clearStats();
    this.streamingRequestsCount = 0;
  }

  get apiStats() {
    const stats = apiStats.clone();
    stats.streamingRequests = this.streamingRequestsCount;
    stats.totalRequests += this.streamingRequestsCount;
    return stats;
  }

  printStats(title?: string): void {
    const stats = this.apiStats;

    // Get all unique methods from successful, failed, and in-flight requests
    const allMethods = new Set([
      ...Object.keys(stats.successfulRequests),
      ...Object.keys(stats.failedRequests),
      ...Object.keys(stats.inFlightRequests),
    ]);

    const tableData: Array<{
      Method: string;
      Successful: number;
      Failed: number;
      InFlight: number;
      Total: number;
    }> = [];

    // Add data for each method
    for (const method of allMethods) {
      const successful = stats.getSuccessfulByMethod(method);
      const failed = stats.getFailedByMethod(method);
      const inFlight = stats.getInFlightByMethod(method);
      tableData.push({
        Method: method,
        Successful: successful,
        Failed: failed,
        InFlight: inFlight,
        Total: successful + failed + inFlight,
      });
    }

    // Sort by method name for consistent output
    tableData.sort((a, b) => a.Method.localeCompare(b.Method));

    // Add streaming requests row if there are any
    if (stats.streamingRequests > 0) {
      tableData.push({
        Method: 'STREAMING',
        Successful: stats.streamingRequests,
        Failed: 0,
        InFlight: 0,
        Total: stats.streamingRequests,
      });
    }

    // Add summary row
    tableData.push({
      Method: '--- TOTAL ---',
      Successful: stats.totalSuccessfulRequests,
      Failed: stats.totalFailedRequests,
      InFlight: stats.totalInFlightRequests,
      Total: stats.totalRequests,
    });

    if (tableData.length <= 1) {
      console.log(title ? `${title}: No API requests recorded` : 'No API requests recorded');
      return;
    }

    if (title) {
      console.log(`\n=== ${title} ===`);
    }
    console.table(tableData);
    console.log(`Total API requests: ${stats.totalRequests}`);
    console.log(
      `Success rate: ${stats.totalRequests > 0 ? (((stats.totalSuccessfulRequests + stats.streamingRequests) / stats.totalRequests) * 100).toFixed(1) : 0}%`,
    );
  }

  public notifyPropertyChanged(typeId: TypeId, property: string) {
    const ref = this.entities.get(typeId);
    if (!ref) {
      console.debug(`Notify skipped (${property}), Entity ${typeId.toString()} not found`);
      return;
    }

    if (ref.entity?.saved) {
      try {
        if (ref.entity.isDbField(property)) {
          ref.entity.dirty = true;
        }
      } catch (_e) {
        // Silently ignore if schema is not available or isDbField check fails
      }
    }
    this._notifyAllAliases(typeId, ref.entity, ref.entity);
  }

  /**
   * Notify all watched queries for an entity's type that results have changed.
   * Use after mutating an entity in-place (e.g. after attachPty wires shell state)
   * so React hooks re-render without waiting for a WS update or re-query.
   */
  public notifyEntityChanged(entity: T): void {
    const type = DataManager.getTypeOfObject(entity);
    if (!type) return;
    const watchedQueries = this.watchedQueries.getWatchCallbacksByType(type);
    for (const watchedQuery of watchedQueries) {
      watchedQuery.notifyCallbacks();
    }
  }

  /**
   * Compute the alternate cache keys for an entity. Entities loaded with both
   * a `uname` and a real UUID `id` are normally cached only under
   * `<type>-@<uname>` (because `APIEntity.identifier` prefers `@uname`). We
   * also mirror them under `<type>-<id>` so consumers that resolve refs by
   * raw UUID — e.g. `process.project_id` → `Project.getByIdFromCache(uuid)` —
   * find the entity. Returns an array to keep room for future alias kinds.
   */
  private _aliasTypeIdsFor(entity: any): TypeId[] {
    if (!entity?.uname || !entity?.id || entity.id === `@${entity.uname}`) return [];
    try {
      return [new TypeId(entity.getType(), entity.id)];
    } catch {
      return [];
    }
  }

  /**
   * Delete a cache entry AND any alias entries pointing to the same entity.
   * Symmetric: works whether the caller passes the primary or an alias key.
   */
  private _deleteWithAliases(typeId: TypeId): void {
    const ref = this.entities.get(typeId);
    this.entities.delete(typeId);
    if (ref?.entity) {
      for (const alias of this._aliasTypeIdsFor(ref.entity)) {
        if (!alias.equals(typeId)) this.entities.delete(alias);
      }
    }
  }

  /**
   * Notify subscribers of `typeId` AND of any alias keys for the same entity.
   * Caller must pass the entity (read BEFORE any deletion) so aliases compute
   * correctly even when notifying about a removal (`value === null`).
   */
  private _notifyAllAliases(typeId: TypeId, entity: any | null, value: any | null): void {
    this.subscriptions.get(typeId)?.forEach((cb) => void cb(value));
    if (entity) {
      for (const alias of this._aliasTypeIdsFor(entity)) {
        if (!alias.equals(typeId)) {
          this.subscriptions.get(alias)?.forEach((cb) => void cb(value));
        }
      }
    }
  }

  public register_new_entity(typeId: TypeId, entity: any) {
    const ref = this.getRef(typeId);
    if (ref.entity && ref.entity !== entity) {
      console.warn(`Entity ${typeId.toString()} already registered with different entity`, new Error().stack);
    }
    ref.entity = entity;
    ref.status = EntityStatus.READY;
    for (const alias of this._aliasTypeIdsFor(entity)) {
      if (!alias.equals(typeId)) this.entities.set(alias, ref);
    }
  }

  public hasRef(typeId: TypeId): boolean {
    return this.entities.has(typeId);
  }

  public getByTypeIdFromCache<U extends T>(typeId: TypeId): U | null {
    const ref = this.entities.get(typeId);
    if (ref && ref.entity) {
      return ref.entity as U;
    }
    return null;
  }

  public invalidateCacheByTypeId(typeId: TypeId): void {
    this._deleteWithAliases(typeId);
  }

  public removeEntityFromCache(typeId: TypeId): void {
    this.watchedQueries.removeEntityFromResults(typeId.type, typeId);
    const ref = this.entities.get(typeId);
    const entity = ref?.entity ?? null;
    this._deleteWithAliases(typeId);
    this._notifyAllAliases(typeId, entity, null);
  }

  public getRef(typeId: TypeId): EntityRef<T> {
    let ref = this.entities.get(typeId);
    if (!ref) {
      ref = new EntityRef();
      this.entities.set(typeId, ref);
    }
    return ref;
  }

  public async waitForTypeId(typeId: TypeId): Promise<T | null> {
    const ref = this.getRef(typeId);
    // if (ref.status === 'READY') {
    //   if (!ref.entity) {
    //     throw new Error('Entity not found but ready');
    //   }
    //   return ref.entity as T;
    // }
    // if (ref.status === 'ERROR') {
    //   return null;
    // }
    const p = new Promise<T | null>((resolve, reject) => {
      ref.entityPendingPromises.push({ resolve, reject });
    });
    this.resolvePendingRequests();
    return p;
  }

  private resolvePendingRequests() {
    for (const ref of this.entities.values()) {
      if (ref.status === EntityStatus.READY) {
        ref.entityPendingPromises.forEach((p) => {
          p.resolve(ref.entity);
        });
        ref.entityPendingPromises = [];
      }
      if (ref.status === EntityStatus.ERROR) {
        ref.entityPendingPromises.forEach((p) => {
          p.reject(ref.error);
        });
        ref.entityPendingPromises = [];
      }
    }
  }

  private async fetchByTypeId<U extends T>(
    typeId: TypeId,
    expansions: ExpansionRequest | null = null,
  ): Promise<U | null> {
    const ref = this.getRef(typeId);
    ref.status = EntityStatus.FETCHING;
    const entityJson = await apiClient.get(`${GRAPH_API_PREFIX}/${typeId.type}/${typeId.id}`, {
      params: expansions?.toJSON(),
    });

    const entity = this.castAndDeepAssign<U>(entityJson);
    //Load entity if load flag is set in query
    if (expansions?.load && entity) {
      await entity.load();
    }
    ref.entity = entity;
    ref.status = EntityStatus.READY;

    // Apply any update that arrived via WebSocket while the GET was in-flight
    if (ref.pendingUpdate) {
      ref.entity = this.castAndDeepAssign(ref.pendingUpdate);
      ref.pendingUpdate = null;
    }

    return ref.entity as U | null;
  }

  public async refreshByTypeId(typeId: TypeId): Promise<T | null> {
    const ref = this.getRef(typeId);
    if (ref.status === EntityStatus.FETCHING) {
      return await this.waitForTypeId(typeId);
    }
    try {
      return await this.fetchByTypeId(typeId);
    } catch (error) {
      console.error(`Error refreshing entity by type ID: ${typeId.toString()}`, error);
      ref.status = EntityStatus.ERROR;
      if (isApiError(error)) {
        ref.error = error;
      }
      throw error;
    } finally {
      this.resolvePendingRequests();
    }
  }

  public async getByTypeId<U extends T>(typeId: TypeId, requiredExpansions?: ExpansionRequest): Promise<U | null> {
    if (!requiredExpansions) {
      requiredExpansions = new ExpansionRequest();
    }
    const ref = this.getRef(typeId);
    const cachedEntity = this.getByTypeIdFromCache<U>(typeId);
    if (cachedEntity) {
      if (!cachedEntity.saved) {
        if (requiredExpansions?.load) {
          await ref.entity?.load();
        }
        return cachedEntity;
      }
      if (cachedEntity.isExpanded(requiredExpansions)) {
        return cachedEntity;
      }
    }
    if (ref?.status === EntityStatus.FETCHING) {
      const entity = await this.waitForTypeId(typeId);
      if (entity && entity.isExpanded(requiredExpansions)) {
        return entity as U;
      }
    }
    try {
      requiredExpansions = this.mergeExpansionsWithQuery(
        ref.entity?.expand?.expansions ?? undefined,
        requiredExpansions,
      );
      const entity = await this.fetchByTypeId<U>(typeId, requiredExpansions);
      if (entity && requiredExpansions?.load) {
        await entity.load();
      }
      return entity;
    } catch (error) {
      console.error(`store.ts:Error fetching entity by type ID: ${typeId.toString()}`, error);
      ref.status = EntityStatus.ERROR;
      throw error;
    } finally {
      this.resolvePendingRequests();
    }
  }

  private mergeExpansionsWithQuery(
    expansions: ExpansionType[] | undefined,
    query?: ExpansionRequest,
  ): ExpansionRequest | undefined {
    if (expansions && expansions.length > 0) {
      query ??= new ExpansionRequest({});
      query.expand ??= [];
      query.expand = [...new Set([...expansions, ...query.expand])];
    }
    return query;
  }

  public async registerType(entity_type: string): Promise<boolean> {
    const endpoint = `${GRAPH_API_PREFIX}/register_type`;
    return (await apiClient.post<any>(endpoint, {
      entity_type: entity_type,
    })) as any;
  }

  public async save<U extends T>(selfTypeId: TypeId, scope: TypeId[] = []): Promise<U> {
    const ref = this.entities.get(selfTypeId);
    if (!ref) {
      throw new Error('Can not create, Entity not defined');
    }
    if (ref.status === EntityStatus.FETCHING) {
      // TODO There probably should be a better way to handle this
      await this.waitForTypeId(selfTypeId);
    }

    const entity = ref.entity;
    if (!entity) {
      throw new Error('Can not create, Empty ref entity');
    }
    const entityJson = entity.toJSON();
    const entityType = entity.typeId.type;
    if (!entityType) {
      throw new Error('Can not create, Entity type not found');
    }
    let scope_path = '';
    for (const parent_type_id of scope) {
      scope_path = `${scope_path}/${parent_type_id.type}/${parent_type_id.id}`;
    }
    try {
      let newEntityJson: IEntity | null = null;
      if (!entity.saved) {
        ref.status = EntityStatus.FETCHING;
        const endpoint = `${GRAPH_API_PREFIX}${scope_path}/${entity.typeId.type}`;
        newEntityJson = (await apiClient.post<IEntity>(endpoint, entityJson)) as IEntity;
      } else if (ref.status === EntityStatus.READY) {
        if (!ref.entity) {
          throw new Error('Entity missing on ref');
        }
        if (!ref.entity.typeId.id) {
          throw new Error('Entity missing id on ref');
        }
        ref.status = EntityStatus.FETCHING;
        const endpoint = `${GRAPH_API_PREFIX}${scope_path}/${entity.typeId.type}/${ref.entity.typeId.id}`;
        newEntityJson = (await apiClient.put<IEntity>(endpoint, entityJson)) as IEntity;
      }
      if (!newEntityJson) {
        throw new Error('No data returned');
      }
      ref.entity = this.castAndDeepAssign(newEntityJson);
      ref.status = EntityStatus.READY;
      if (ref.entity) {
        ref.entity.dirty = false;
      }
      return ref.entity as U;
    } catch (error) {
      console.error(`Error saving entity by ID: ${selfTypeId.toString()}`, error);
      // @ts-ignore
      console.log('testUserToken', apiClient.testUserToken);
      ref.status = EntityStatus.ERROR;
      if (isApiError(error)) {
        ref.error = error;
        console.log(error.stack);
      }
      throw error;
    } finally {
      this.resolvePendingRequests();
    }
  }

  private async callStreamingAction<_Req, Res>(actionInfo: ActionInfo): Promise<Res> {
    this.streamingRequestsCount++;
    const endpoint = actionInfo.actionUrl;
    const fullUrl = `${config.SERVER_URL}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
    };
    // @ts-ignore
    if (apiClient.testUserToken) {
      // @ts-ignore
      headers['Authorization'] = `Bearer ${apiClient.testUserToken}`;
    }

    const response = await fetch(fullUrl, {
      method: actionInfo.method,
      headers: headers,
      body: actionInfo.method !== 'GET' ? JSON.stringify(actionInfo.bodyParameters) : undefined,
      credentials: 'include', // Important for visitor cookies
      signal: actionInfo.abortSignal,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Handle 204 No Content - valid response with no body (e.g., nothing to resume)
    if (response.status === 204) {
      return null as unknown as Res;
    }

    if (!response.body) {
      throw new Error('Response body is null - server may not support streaming');
    }

    // Return the response as-is for streaming processing by the caller
    return response as unknown as Res;
  }

  public async callAction<_Req, Res>(actionInfo: ActionInfo): Promise<Res> {
    // Handle streaming actions with the new helper
    if (actionInfo.isStreaming) {
      return await this.callStreamingAction<_Req, Res>(actionInfo);
    }

    const endpoint = actionInfo.actionUrl;

    let requestConfig = undefined;
    if (actionInfo.isRawResponse) {
      requestConfig = {
        transformResponse: (data: any) => {
          return { data };
        },
        signal: actionInfo.abortSignal || undefined,
        responseType: actionInfo.responseType || undefined,
      };
    }

    // In-flight dedup for GETs: share a pending request with concurrent callers
    // (e.g. StrictMode double-invoke, or multiple components mounting at once).
    // Safe because GETs are idempotent. Mutations (POST/PUT/DELETE) are never deduped.
    const method = actionInfo.method ?? 'GET';
    const isDedupable = method === 'GET' && !actionInfo.abortSignal;
    if (isDedupable) {
      const key = endpoint;
      const pending = this._inFlightGets.get(key);
      if (pending) return pending as Promise<Res>;
      const promise = (async () => {
        try {
          const raw = (await apiClient.get<Res>(endpoint, requestConfig)) as unknown as Res;
          return actionInfo.castResponse ? (this.castAndDeepAssign(raw) as unknown as Res) : raw;
        } finally {
          this._inFlightGets.delete(key);
        }
      })();
      this._inFlightGets.set(key, promise);
      return promise;
    }

    let response: Res;

    switch (method) {
      case 'POST':
      case 'PUT':
        if (!actionInfo.queryParameters) {
          throw new Error(`Can not call ${method} action ${actionInfo.name}, Missing request data`);
        }
        response =
          method === 'POST'
            ? ((await apiClient.post<Res>(endpoint, actionInfo.bodyParameters, requestConfig)) as unknown as Res)
            : ((await apiClient.put<Res>(endpoint, actionInfo.bodyParameters, requestConfig)) as unknown as Res);
        break;
      case 'DELETE':
        response = (await apiClient.delete<Res>(endpoint, {
          data: actionInfo.bodyParameters,
          ...requestConfig,
        })) as unknown as Res;
        break;
      default:
        // Fallthrough GET that opted out of dedup (e.g. has abortSignal)
        response = (await apiClient.get<Res>(endpoint, requestConfig)) as unknown as Res;
        break;
    }
    return actionInfo.castResponse ? (this.castAndDeepAssign(response) as unknown as Res) : response;
  }

  public async callActionOverWS<_Req, Res>(actionInfo: ActionInfo, options?: import('../websocket').IWSRestOptions): Promise<Res> {
    const connectionManager = ConnectionManager.getInstance();

    if (!connectionManager.connected) {
      throw new Error('WebSocket not connected. Cannot call action over WebSocket.');
    }

    const message: RestApiMessage = {
      message_type: 'rest_api_msg',
      message_id: uuidv4(),
      method: actionInfo.method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      scope: actionInfo.scope.map((tid) => ({ type: tid.type, id: tid.id })),
      direct_resource_type: null,
      target_typeid: actionInfo.targetEntity
        ? { type: actionInfo.targetEntity.type, id: actionInfo.targetEntity.id }
        : null,
      action: actionInfo.name,
      sub_path: actionInfo.subpath,
      query_params: actionInfo.queryParameters as Record<string, unknown> | null,
      body: actionInfo.bodyParameters as Record<string, unknown> | null,
    };

    const response = await connectionManager.sendRestApiMessage<Res>(message, options);
    return actionInfo.castResponse ? (this.castAndDeepAssign(response) as unknown as Res) : response;
  }

  /**
   * Call an action over the WebSocket when the socket is OPEN, otherwise fall
   * back to the REST path. The branch is decided up front from the connection
   * state — there is no post-failure retry, so a non-idempotent mutation can
   * never be sent twice.
   *
   * For non-file mutations (e.g. a text-only message send) the WS hop skips an
   * HTTP round-trip when a live socket already exists; REST keeps the call
   * working when it doesn't. Multipart/file actions must NOT use this — binary
   * bodies don't travel over the WS rest_api_msg channel.
   */
  public async callActionPreferWS<_Req, Res>(
    actionInfo: ActionInfo,
    options?: import('../websocket').IWSRestOptions,
  ): Promise<Res> {
    if (ConnectionManager.getInstance().connected) {
      return this.callActionOverWS<_Req, Res>(actionInfo, options);
    }
    return this.callAction<_Req, Res>(actionInfo);
  }

  public getCachedQueryResults<U extends T>(request: QueryRequest): U[] | undefined {
    const watchedQuery = this.watchedQueries.getWatchedQuery(request);
    return watchedQuery?.results as U[] | undefined;
  }

  public async watchQuery<U extends T>(request: QueryRequest): Promise<() => void> {
    if (!request.callback) {
      throw new Error('QueryRequest must have a callback for watchQuery');
    }

    // Check if a WatchedQuery exists
    const watchedQuery = this.watchedQueries.getWatchedQuery(request);
    let queryResult: U[];

    if (!watchedQuery) {
      // No cache exists - fetch from API
      queryResult = await this._query<U>(request);
    } else if (watchedQuery.pendingPromise) {
      // In-flight request - await it
      queryResult = (await watchedQuery.pendingPromise) as U[];
    } else {
      // Cache exists with results - use it (even if results are empty/null)
      queryResult = watchedQuery.results as U[];
    }

    const removeWatchCallback = this.watchedQueries.registerWatch(request, queryResult);
    void (request.callback as (entities: U[]) => void | Promise<void>)(queryResult);

    // Return callback to remove watch
    return removeWatchCallback;
  }

  // DEPRECATED: Use watchQuery instead
  // subscribeQuery has been removed to simplify the architecture.
  // watchQuery now handles both initial fetch and subscription.

  public async query<U extends T>(request: QueryRequest, invalidate: boolean = false): Promise<U[]> {
    // If invalidate is false, check cache before querying
    if (!invalidate) {
      // Check cache before querying
      const watchedQuery = this.watchedQueries.getWatchedQuery(request);
      if (watchedQuery) {
        // Check if there's an in-flight request
        if (watchedQuery.pendingPromise) {
          return (await watchedQuery.pendingPromise) as U[];
        }

        // Check if we have cached results
        if (watchedQuery.results !== undefined) {
          return watchedQuery.results as U[];
        }
      }
    }

    return await this._query<U>(request);
  }

  private async _query<U extends T>(request: QueryRequest): Promise<U[]> {
    const { type, query, scope } = request;

    // Check if WatchedQuery with pending promise already exists (another call beat us to it)
    const existingWatchedQuery = this.watchedQueries.getWatchedQuery(request);
    if (existingWatchedQuery?.pendingPromise) {
      return (await existingWatchedQuery.pendingPromise) as U[];
    }

    // Create the promise that will be stored in WatchedQuery
    const queryPromise = (async (): Promise<U[]> => {
      // Check all scope entities are saved
      for (const parent_type_id of scope) {
        const parent_ref = this.entities.get(parent_type_id);
        if (parent_ref && parent_ref.entity && !parent_ref.entity.saved) {
          return [];
        }
      }

      let apiQuery: any = {};
      if (query) {
        apiQuery = query.toJSON();
      }
      let scope_path = '';
      for (const parent_type_id of scope) {
        scope_path = `${scope_path}/${parent_type_id.type}/${parent_type_id.id}`;
      }
      const endpoint = `${GRAPH_API_PREFIX}${scope_path}/${type}`;
      const entitiesJson: IEntity[] = (await apiClient.get<IEntity[]>(endpoint, {
        params: apiQuery,
      })) as unknown as IEntity[];
      const queryResult: U[] = [];
      for (const entityJson of entitiesJson) {
        if (!entityJson['type'] || !entityJson['id']) {
          console.warn(`[DataManager] Skipping entity with missing type or id during query for type: ${type}`);
          continue;
        }
        const constructor = EntityFactory.getEntityConstructor(entityJson['type']);
        if (!constructor) {
          console.warn(`[DataManager] Skipping entity, constructor not found for type: ${entityJson['type']}`);
          continue;
        }
        // Use same identifier logic as APIEntity.identifier to ensure consistent cache lookups
        const identifier = entityJson['uname'] ? `@${entityJson['uname']}` : entityJson['id'];
        let typeId: TypeId;
        try {
          typeId = new TypeId(entityJson['type'], identifier);
        } catch (e) {
          console.warn(`[DataManager] Skipping entity with invalid id "${identifier}" for type: ${entityJson['type']}`);
          continue;
        }
        const entity = this.castAndDeepAssign(entityJson);
        this.register_new_entity(entity.typeId, entity);
        const ref = this.getRef(entity.typeId);
        queryResult.push(ref.entity as U);
      }

      return queryResult;
    })();

    // Register the pending promise BEFORE awaiting it
    this.watchedQueries.registerWatchResults(request, undefined as any, queryPromise);

    // Now await the promise
    try {
      const results = await queryPromise;

      // Update the WatchedQuery with final results and clear pending promise
      const watchedQuery = this.watchedQueries.getWatchedQuery(request);
      if (watchedQuery) {
        watchedQuery.results = results;
        watchedQuery.pendingPromise = undefined;
      }
      return results;
    } catch (error) {
      // Clear pending promise on error
      const watchedQuery = this.watchedQueries.getWatchedQuery(request);
      if (watchedQuery) {
        watchedQuery.pendingPromise = undefined;
      }
      throw error;
    }
  }

  subscribe<U extends T>(
    typeId: TypeId,
    callback?: (entity: U | null) => void | Promise<void>,
    // TODO [FLOWPAD-1059] Remove initialFetch and use useQuery instead
    initialFetch: boolean = false,
  ): () => void {
    if (!this.subscriptions.has(typeId)) {
      this.subscriptions.set(typeId, new Set());
    }
    const callbacks = this.subscriptions.get(typeId);
    if (callback) callbacks?.add(callback as (entity: T | null) => void | Promise<void>);
    if (initialFetch) {
      // Immediately call new callback
      const cached = this.getByTypeIdFromCache<U>(typeId);
      void callback?.(cached);
      // Initiate fetch if entity is not in cache
      if (!cached) {
        void this.refreshByTypeId(typeId);
      }
    }
    // Return unsubscribe function
    return () => {
      if (callback) callbacks?.delete(callback as (entity: T | null) => void | Promise<void>);
    };
  }

  async watch(typeId: TypeId): Promise<() => Promise<void>> {
    const watchersCount = this.watches.get(typeId) || 0;
    this.watches.set(typeId, watchersCount + 1);
    if (watchersCount === 0) {
      const connection_manager = ConnectionManager.getInstance();
      if (connection_manager.connected) {
        const connection_id = connection_manager.id;
        try {
          await apiClient.post<any, IEntity>(`${config.API_PREFIXES.graph}/${typeId.type}/${typeId.id}/watch`, {
            connection_id: connection_id,
          });
        } catch (e) {
          // Watch POST failed — don't block callers. The watch will be
          // re-registered on the next WebSocket reconnect via onConnectionOpen.
          console.warn(`[Store] watch POST failed for ${typeId.toString()}, will retry on reconnect:`, e);
        }
      }
    }

    return async () => {
      const watchersCount = this.watches.get(typeId);
      if (!watchersCount) {
        return;
      }
      this.watches.set(typeId, watchersCount - 1);
      if (watchersCount - 1 <= 0) {
        this.watches.delete(typeId);
        return await this.unwatch(typeId);
      }
    };
  }

  private async unwatch(typeId: TypeId) {
    if (!this.getByTypeIdFromCache(typeId)) {
      // Entity is not in cache, so it is probably deleted
      return;
    }
    const connection_manager = ConnectionManager.getInstance();
    if (connection_manager.connected) {
      const connection_id = connection_manager.id;
      await apiClient.post(`${config.API_PREFIXES.graph}/${typeId.type}/${typeId.id}/unwatch`, {
        connection_id: connection_id,
      });
    }
  }

  public async delete(typeId: TypeId): Promise<void> {
    const ref = this.entities.get(typeId);
    if (!ref) {
      throw new Error('Can not delete, Entity not defined');
    }
    const entity = ref.entity;
    if (!entity) {
      throw new Error('Can not delete, Empty ref entity');
    }

    try {
      let isDeleted: boolean = true;
      if (entity.saved) {
        const endpoint = `${GRAPH_API_PREFIX}/${typeId.type}/${typeId.id}`;
        console.log(`🌐 [DataManager.delete] Making DELETE request to ${endpoint}`);
        isDeleted = (await apiClient.delete<IEntity>(endpoint)) as unknown as boolean;
        console.log(`📡 [DataManager.delete] API response for ${typeId.type}:${typeId.id}, deleted: ${isDeleted}`);
      } else {
        console.log(`📝 [DataManager.delete] Entity not saved, skipping API call for ${typeId.type}:${typeId.id}`);
      }
      if (!isDeleted) {
        throw new Error('No data returned');
      }
      this._deleteWithAliases(typeId);
      // Keep query-driven UIs reactive even when backend doesn't emit a delete DataOp.
      // If a delete DataOp arrives later, removeEntityFromResults is idempotent.
      this.watchedQueries.removeEntityFromResults(typeId.type, typeId);
      console.log(`🗂️ [DataManager.delete] Removed ${typeId.type}:${typeId.id} from local entities cache`);
      console.log(`🔔 [DataManager.delete] Waiting for DataOp from server for query invalidation...`);
    } catch (error) {
      console.error(`❌ [DataManager.delete] Error deleting entity by ID: ${typeId.toString()}`, error);
      ref.status = EntityStatus.ERROR;
      if (isApiError(error)) {
        ref.error = error;
      }
      throw error;
    }
  }

  private static getTypeOfObject(obj: any) {
    if (typeof obj !== 'object' || obj === null) {
      return undefined;
    }
    // Object may be a proxy or a json object
    if ('type' in obj) {
      return obj.type;
    } else if ('constructor' in obj && 'type' in obj.constructor) {
      return obj.constructor.type;
    }
    return undefined;
  }

  public async getCurrentUser(): Promise<any> {
    try {
      let currentUser = (await apiClient.get<any>(`${config.API_PREFIXES.currentUser}`)) as unknown as any;
      currentUser = this.castAndDeepAssign(currentUser);
      return currentUser;
    } catch {
      return null;
    }
  }

  public castAndDeepAssign<U extends T>(source: any) {
    const entityType = DataManager.getTypeOfObject(source);

    if (!entityType || !('id' in source)) {
      throw new Error('Invalid entity type or ID');
    }
    // Use same identifier logic as APIEntity.identifier to ensure consistent cache lookups
    const sourceIdentifier = source.uname ? `@${source.uname}` : source.id;
    const sourceTypeId = new TypeId(entityType, sourceIdentifier);
    const cachedSource = this.getByTypeIdFromCache<U>(sourceTypeId);
    if (cachedSource) {
      source.expand = this.mergeExpansions(cachedSource.expand, source.expand);

      const maybeOnEntityUpdate = (cachedSource as any).onEntityUpdate;
      const hasEntityUpdateHook = typeof maybeOnEntityUpdate === 'function';
      if (hasEntityUpdateHook) {
        try {
          maybeOnEntityUpdate.call(cachedSource, source);
        } catch (error) {
          console.warn(`[DataManager.castAndDeepAssign] onEntityUpdate failed for ${sourceTypeId.toString()}:`, error);
        }
      }

      // When entities provide their own update hook, avoid clobbering normalized
      // state fields with raw snake_case payloads.
      if (hasEntityUpdateHook && source && typeof source === 'object' && 'state' in source) {
        const { state: _ignoredState, ...rest } = source;
        this.deepAssign(cachedSource, rest);
      } else {
        this.deepAssign(cachedSource, source);
      }
      // ``deepAssign`` re-adds the raw ``shared_context_entities`` /
      // ``private_context_entities`` string arrays without the constructor's
      // string→TypeId parse, leaving the internal ``_shared_context_entities_``
      // / ``_private_context_entities_`` arrays (which the getters read) stale.
      this._rehydrateContextEntities(cachedSource, source);
      cachedSource.dirty = false;
      return cachedSource;
    }
    const entityConstructor = EntityFactory.getEntityConstructor(entityType);
    if (!entityConstructor) {
      throw new Error(`Entity constructor not found for type: ${entityType}`);
    }
    return new entityConstructor(source) as U;
  }

  /**
   * Loads an entity from JSON data into the DataManager cache
   * Creates entity instance and registers it as if fetched from API
   */
  public updateEntityFromJson<U extends T>(entityJson: any): U {
    const entity = this.castAndDeepAssign<U>(entityJson);
    // Register the entity in cache if it's not already there
    if (!this.getByTypeIdFromCache(entity.typeId)) {
      this.register_new_entity(entity.typeId, entity);
    }
    return entity;
  }

  /**
   * Field-name whitelist for the TypeId auto-coercion in `deepAssign`.
   *
   * The default heuristic — "if the value looks like a TypeId string, treat it
   * as one" — corrupts plain-string fields whose values happen to match the
   * `<type>-<id>` shape. The canonical example is `target_typeid_str` on
   * `AgenticProcess` / `Run`: the Python schema declares it `str | None`, the
   * on-disk record stores it as the string `"project-<uuid>"`, but
   * `deepAssign` would otherwise wrap it into a TypeId object — breaking
   * `useProcessesForTarget` queries (string match on the server, object
   * mismatch on the client validator) and silently disabling the chat
   * toolbar's history.
   *
   * The list below names every field whose value should NEVER be promoted to
   * a TypeId, regardless of how it looks. Add new entries here when a plain
   * string id field is introduced and its values can collide with the TypeId
   * shape. Reference IDs (project_id, created_by, …) are intentionally NOT in
   * this set — current consumers rely on the auto-coercion for those.
   */
  private static TYPEID_COERCION_DENYLIST: ReadonlySet<string> = new Set([
    'target_typeid_str',
    'message',
    'text',
    'instruction',
    'title',
    'sender_name',
  ]);

  public deepAssign(target: any, source: any) {
    for (const key in source) {
      if (typeof source[key] === 'object' && source[key] !== null) {
        if (!target[key]) {
          target[key] = Array.isArray(source[key]) ? [] : {};
        }
        target[key] = this.deepAssign(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  }

  private mergeArrays<T>(arr1?: T[] | null, arr2?: T[] | null): T[] | null {
    if (!arr1 && !arr2) return null;
    return [...new Set([...(arr1 ?? []), ...(arr2 ?? [])])];
  }

  private mergeExpansions(exp1?: EntityExpansion, exp2?: EntityExpansion): EntityExpansion {
    // TODO [FLOWPAD-891] Delete mergeExpansions and don't use entity.expand.expansions array
    return {
      roles: this.mergeArrays(exp1?.roles, exp2?.roles),
      allowed_actions: this.mergeArrays(exp1?.allowed_actions, exp2?.allowed_actions),
      auth_scopes: this.mergeArrays(exp1?.auth_scopes, exp2?.auth_scopes),
      is_private: exp1?.is_private ?? exp2?.is_private,
      expansions: this.mergeArrays(exp1?.expansions, exp2?.expansions),
    };
  }

  /**
   * Check if this instance matches the global store
   */
  public isSingleton(): boolean {
    //@ts-ignore
    return this === window['store'];
  }

  /**
   * Print a table of all watched queries with their details for debugging
   */
  public watchQueryPrint(): void {
    const tableData: Array<{
      'Instance ID': number;
      Type: string;
      'Callback Name': string;
      'Results Count': number;
    }> = [];

    const allQueries = this.watchedQueries.getAllWatchedQueries();

    // Get all watched queries and iterate through their callbacks
    for (const watchedQuery of allQueries) {
      const callbacks = watchedQuery.getQueryCallbacks();

      if (callbacks.length === 0) {
        // Show watched query even without callbacks
        tableData.push({
          'Instance ID': watchedQuery.instance_id,
          Type: watchedQuery.request.type,
          'Callback Name': '(no callbacks)',
          'Results Count': watchedQuery.results?.length ?? 0,
        });
      } else {
        // Show one row per callback
        for (const queryCallback of callbacks) {
          tableData.push({
            'Instance ID': watchedQuery.instance_id,
            Type: watchedQuery.request.type,
            'Callback Name': queryCallback.name,
            'Results Count': watchedQuery.results?.length ?? 0,
          });
        }
      }
    }

    if (tableData.length === 0) {
      console.log('No watched queries found');
      return;
    }

    console.table(tableData);
    console.log(`Total watched queries: ${this.watchedQueries.getAllWatchedQueries().length}`);
  }
}

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import config from './config'; // Import the 'config' module
import { TypeId } from './models/TypeId';
import {
  ConnectionSlot,
  HubConnectionStatus,
  HubLoginStatus,
  LocalConnectionStatus,
  makeConnectionSlot,
} from './services/cloud_status';
import { defineGlobal } from './utils/globals';

type MessageType =
  | 'entity_msg'
  | 'data_op_msg'
  | 'stream_msg'
  | 'transcript_msg'
  | 'control_msg'
  | 'oauth_msg'
  | 'rest_api_msg'
  | 'response_msg'
  | 'pty_output_msg'
  | 'flow_data_msg'
  | 'llm_config_msg'
  | 'hub_client_error_msg'
  | 'auth_expired_msg'
  | 'cloud_login_status_msg'
  | 'cloud_connection_status_msg'
  | 'ui_command'
  | 'recovered_msg';


interface BaseMessage {
  message_type: MessageType;
  message_id: string;
}

export interface IWSRestOptions {
  /** Request timeout in milliseconds. Defaults to ConnectionManager.requestTimeoutMs (30 000). */
  timeout?: number;
}

// interface EchoMessage extends BaseMessage {
//   messageType: "echo";
//   text: string;
// }

// interface PingMessage extends BaseMessage {
//   messageType: "ping";
//   text: string;
// }

// interface PongMessage extends BaseMessage {
//   messageType: "pong";
//   text: string;
// }

// interface HangupMessage extends BaseMessage {
//   messageType: "hangup";
//   text: string;
// }

type ITypeId = string | { type: string; id: string };

interface EntityMessage extends BaseMessage {
  from_entity?: ITypeId;
  to_entity: ITypeId;
}

export interface IStreamMessage extends BaseMessage {
  stream_id: number;
}

export interface TranscriptMessage extends IStreamMessage {
  text: string;
}

export interface ControlMessage extends BaseMessage {
  state: boolean;
}

export interface OAuthMessage extends BaseMessage {
  oauth_request_id: string;
  status: 'success' | 'error';
  message?: string | null;
  user?: Record<string, any> | null;
}

export interface HubClientErrorMessage extends BaseMessage {
  message_type: 'hub_client_error_msg';
  status_code: number;
  method: string;
  path: string;
  message: string;
  suppressed_count?: number;
}

export interface AuthExpiredMessage extends BaseMessage {
  message_type: 'auth_expired_msg';
  reason: string;
}

export interface CloudLoginStatusMessage extends BaseMessage {
  message_type: 'cloud_login_status_msg';
  status: HubLoginStatus;
  user?: Record<string, unknown> | null;
  reason?: string | null;
}

export interface CloudConnectionStatusMessage extends BaseMessage {
  message_type: 'cloud_connection_status_msg';
  status: HubConnectionStatus;
  error?: string | null;
}

/**
 * Server → client directive to drive the UI (navigate, open, etc.).
 * Emitted by the local Flowpad server when an agent invokes a `flow navigate ...`
 * command. The server resolves targeting via presence tracking and sends this
 * to the single active tab.
 */
export interface UiCommandMessage extends BaseMessage {
  message_type: 'ui_command';
  /** Discriminator for the specific action the UI should perform. */
  kind: 'navigate_entity' | string;
  /** For `navigate_entity`: the entity's type (e.g. "shell", "project"). */
  type?: string;
  /** For `navigate_entity`: the entity's id. */
  id?: string;
}

export interface LlmConfigMessage extends BaseMessage {
  message_type: 'llm_config_msg';
  is_configured: boolean;
  auth_method: 'oauth' | 'api_key' | 'none';
  auth_data?: {
    is_authenticated: boolean;
    auth_method: 'oauth' | 'api_key' | 'none';
    oauth_info?: {
      subscription_type: string | null;
      rate_limit_tier: string | null;
      scopes: string[];
      expires_at: number | null;
      is_expired: boolean;
    } | null;
    api_key_info?: {
      key_prefix: string;
      source: string;
    } | null;
    user_profile?: {
      email: string | null;
      account_uuid: string | null;
      organization_name: string | null;
      organization_uuid: string | null;
    } | null;
    credentials_source: string | null;
    error: string | null;
  };
  // OAuth request fields (for tracking which OAuth request completed)
  oauth_request_id?: string;
  status?: 'success' | 'error';
}

export interface RestApiMessage extends BaseMessage {
  message_type: 'rest_api_msg';
  message_id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  scope: Array<{ type: string; id: string }>;
  direct_resource_type?: string | null;
  target_typeid?: { type: string; id: string } | null;
  action?: string | null;
  sub_path?: string | null;
  query_params?: Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
  // Per-call hub-reflection opt-in (default false). The WS-REST handler copies
  // this onto request_info.hub_reflect (the HTTP path uses the Hub-Reflect header).
  hub_reflect?: boolean;
  // Renderer-minted correlation id (the HTTP path uses the X-Trace-Id header).
  // The WS-REST handler copies this onto request_info.trace_id.
  trace_id?: string;
}

export interface ResponseMessage extends BaseMessage {
  message_type: 'response_msg';
  response_message_id: string;
  content?: unknown;
  error?: string | null;
}

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface PtyOutputMessage extends BaseMessage {
  message_type: 'pty_output_msg';
  provider_node_id: string;
  shell_id: string;
  data: string; // base64-encoded
  seq?: number; // Sequence number for output replay (refresh recovery)
  timestamp_ms?: number; // Unix epoch milliseconds when the chunk was captured on the server
}

export interface FlowDataMessage extends EntityMessage {
  message_type: 'flow_data_msg';
  flow_data: {
    // Serialized FlowData fields
    element_type?: string;
    data_type?: string;
    attributes?: Record<string, string>;
    content?: string;
    [key: string]: any;
  };
}

export type DataOpType = 'create' | 'update' | 'delete';

/** Enum form of {@link DataOpType}. Use these members instead of bare
 *  'create' / 'update' / 'delete' string literals when matching a
 *  data_op frame's ``op``. */
export enum DataOp {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
}

interface DataOpMessage extends EntityMessage {
  op: DataOpType;
  data?: { [key: string]: any }; // Use a dictionary to represent the data or define the specific structure if known
}

export class ConnectionManager extends EventEmitter {
  id = uuidv4();
  private static instance: ConnectionManager;
  private socket: WebSocket | null = null;
  private pendingRequests: Map<string, PendingRequest<unknown>> = new Map();
  private requestTimeoutMs: number = 30000;

  // Reconnect state
  private reconnectAttempts: number = 0;
  private baseReconnectDelay: number = 500; // ms
  private isReconnecting: boolean = false;

  // Local WS connection slot — same enum vocabulary as the cloud side
  // (narrower: no auth_rejected/verified since the local server is the
  // user's own process). Mutated only at the socket lifecycle points
  // below; broadcast via 'connection_status_changed'.
  private _connection: ConnectionSlot<LocalConnectionStatus> = makeConnectionSlot<LocalConnectionStatus>('disconnected');

  get connectionStatus(): LocalConnectionStatus {
    return this._connection.status;
  }

  get connectionSlot(): Readonly<ConnectionSlot<LocalConnectionStatus>> {
    return this._connection;
  }

  private setConnectionStatus(status: LocalConnectionStatus, error: string | null = null) {
    const prev = this._connection.status;
    const prevError = this._connection.error;
    this._connection = { status, error };
    void import('./FlowSync/context').then((mod) => mod.dataContext.setLocalConnectionStatus?.(status));
    if (prev !== status || prevError !== error) {
      this.emit('connection_status_changed', this._connection);
    }
  }

  // In-flight connect promise. Set when a `new WebSocket(...)` is created and
  // cleared on `open` or on `close-before-open` of that same socket. Lets
  // concurrent callers (e.g. `waitForConnected`) await the same handshake
  // instead of racing each other or seeing `undefined` during CONNECTING.
  private _openPromise: Promise<void> | null = null;

  public resetReconnectState() {
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
  }

  constructor() {
    super();
    ConnectionManager.instance = this;
  }

  public async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    // CONNECTING: another caller already started a handshake — return that
    // promise so awaiters actually wait for `open`. Previously this branch
    // returned `undefined`, which silently let downstream WS calls fire
    // before the socket opened.
    if (this.socket?.readyState === WebSocket.CONNECTING && this._openPromise) {
      return this._openPromise;
    }

    let resolve_promise: () => void = () => {};
    let reject_promise: (err: Error) => void = () => {};
    const connected_promise = new Promise<void>((resolve, reject) => {
      resolve_promise = resolve;
      reject_promise = reject;
    });
    this._openPromise = connected_promise;
    this.setConnectionStatus('connecting');
    try {
      const ws_url = `${config.WS_URL}/${this.id}`;
      const ws = new WebSocket(ws_url);
      this.socket = ws;
      ws.binaryType = 'arraybuffer';
      let didOpen = false;
      ws.addEventListener('open', (event) => {
        didOpen = true;
        if (this._openPromise === connected_promise) this._openPromise = null;
        this.setConnectionStatus('connected');
        this.onOpen(event);
        resolve_promise();
      });
      // Listen for messages
      ws.addEventListener('message', (event) => {
        try {
          if (event.data instanceof ArrayBuffer) {
            this.onBinMessage(event.data);
          } else if (typeof event.data === 'string') {
            this.onMessage(JSON.parse(event.data));
          } else {
            console.error('Unknown ws message type:', event.data);
          }
        } catch (e) {
          const errorMsg = e instanceof Error ? e.message : String(e);
          console.error(`Error parsing message(${errorMsg}):${event.data}`, event.data);
        }
      });
      ws.addEventListener('close', (event) => {
        // Only clear this.socket if it still points to this WebSocket instance.
        // A newer connect() call may have already replaced it — don't clobber that.
        if (this.socket === ws) {
          this.socket = null;
          if (this._openPromise === connected_promise) this._openPromise = null;
        }
        if (!didOpen) {
          this.setConnectionStatus('error', `WebSocket closed before connecting (code: ${event.code})`);
        } else {
          this.setConnectionStatus('disconnected');
        }
        this.onClose(event);
        if (!didOpen) {
          reject_promise(new Error(`WebSocket closed before connecting (code: ${event.code})`));
        }
      });
      ws.addEventListener('error', (event) => {
        console.error('WebSocket error:', event);
        this.setConnectionStatus('error', 'WebSocket error');
      });
    } catch (e) {
      console.error('Error connecting to WebSocket server:', e);
      if (this._openPromise === connected_promise) this._openPromise = null;
      this.setConnectionStatus('error', e instanceof Error ? e.message : String(e));
      reject_promise(e instanceof Error ? e : new Error(String(e)));
    }
    return connected_promise;
  }

  /**
   * Resolve once the socket is OPEN, with a hard timeout fence.
   *
   * Idempotent and safe under concurrency: multiple callers share the same
   * in-flight `_openPromise`. Use this from any code path that is about to
   * issue a WS-only action (e.g. `callActionOverWS`) and cannot block the
   * UI indefinitely if the server is unreachable.
   *
   * Throws `Error('WebSocket connect timed out after Xms')` on timeout —
   * does NOT mutate the underlying socket; a later attempt may still succeed.
   */
  public async waitForConnected(timeoutMs: number = 5000): Promise<void> {
    if (this.connected) return;

    // Kick a connect if none is in flight. connect() short-circuits when
    // OPEN/CONNECTING, so this is cheap to call concurrently.
    if (!this._openPromise) {
      void this.connect();
    }
    const open = this._openPromise;
    if (!open) return; // race: connect() resolved synchronously to OPEN

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`WebSocket connect timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([open, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  onOpen(event: Event) {
    // Reset reconnect attempts on successful connection
    this.reconnectAttempts = 0;
    this.emit('on_open');
    return event;
  }

  onClose(event: CloseEvent) {
    this.emit('on_close');
    // Automatically reconnect on unexpected disconnect
    if (!event.wasClean && !this.isReconnecting) {
      console.warn('[ConnectionManager] Connection closed unexpectedly, reconnecting...', {
        code: event.code,
        reason: event.reason,
      });
      void this.reconnect();
    }
    return event;
  }

  /**
   * Reconnect with exponential backoff. Retries indefinitely — no hard cap.
   * Uses setTimeout instead of recursive await to avoid growing the Promise chain
   * (which was a memory leak when the server was down for a long time).
   */
  private async reconnect(): Promise<void> {
    if (this.isReconnecting) {
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    const delay =
      Math.min(this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 10000) + // Max 10 seconds
      Math.random() * 1000; // Add jitter

    console.log(`[ConnectionManager] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      await this.connect();
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      this.emit('on_reconnected');
      console.log('[ConnectionManager] Reconnected successfully');
    } catch (error) {
      console.error('[ConnectionManager] Reconnect failed:', error);
      this.isReconnecting = false;
      // Schedule next attempt without recursive await (avoids Promise chain memory leak)
      setTimeout(() => void this.reconnect(), 0);
    }
  }

  onMessage(data: BaseMessage) {
    if (data.message_type === 'entity_msg') {
      return null;
    }
    if (data.message_type === 'control_msg') {
      return this.onControlMessage(data as ControlMessage);
    }
    if (data.message_type === 'transcript_msg') {
      return this.onStreamMessage(data as TranscriptMessage);
    }
    if (data.message_type === 'data_op_msg') {
      return this.onDataOpMessage(data as DataOpMessage);
    }
    if (data.message_type === 'oauth_msg') {
      return this.onOAuthMessage(data as OAuthMessage);
    }
    if (data.message_type === 'response_msg') {
      return this.onResponseMessage(data as ResponseMessage);
    }
    if (data.message_type === 'pty_output_msg') {
      return this.onPtyOutputMessage(data as PtyOutputMessage);
    }
    if (data.message_type === 'flow_data_msg') {
      return this.onFlowDataMessage(data as FlowDataMessage);
    }
    if (data.message_type === 'llm_config_msg') {
      return this.onLlmConfigMessage(data as LlmConfigMessage);
    }
    if (data.message_type === 'hub_client_error_msg') {
      return this.onHubClientErrorMessage(data as HubClientErrorMessage);
    }
    if (data.message_type === 'auth_expired_msg') {
      return this.onAuthExpiredMessage(data as AuthExpiredMessage);
    }
    if (data.message_type === 'cloud_login_status_msg') {
      return this.onCloudLoginStatusMessage(data as CloudLoginStatusMessage);
    }
    if (data.message_type === 'cloud_connection_status_msg') {
      return this.onCloudConnectionStatusMessage(data as CloudConnectionStatusMessage);
    }
    if (data.message_type === 'ui_command') {
      return this.onUiCommandMessage(data as UiCommandMessage);
    }
    if (data.message_type === 'recovered_msg') {
      return this.onRecoveredMessage(data);
    }
  }

  /** Distinct PTY-recovery signal: the backend watchdog respawned a session's
   *  worker after a restart and this client is watching it. Consumers (the
   *  terminal) re-attach their PTY stream. See flow_sdk/server/pty_recovery.py. */
  onRecoveredMessage(data: BaseMessage) {
    this.emit('on_recovered', data);
  }

  onCloudLoginStatusMessage(data: CloudLoginStatusMessage) {
    this.emit('on_cloud_login_status_msg', data);
  }

  onCloudConnectionStatusMessage(data: CloudConnectionStatusMessage) {
    this.emit('on_cloud_connection_status_msg', data);
  }

  onUiCommandMessage(data: UiCommandMessage) {
    this.emit('on_ui_command', data);
  }

  onBinMessage(data: ArrayBuffer) {
    // print all the data in the buffer
    // const byteArray = new Uint8Array(data);
    // let byteString = '';
    // for (let i = 0; i < byteArray.length; i++) {
    //   byteString += byteArray[i].toString(16).padStart(2, '0') + ' ';
    // }
    this.emit('on_bin_msg', data);
  }

  onControlMessage(data: ControlMessage) {
    this.emit('on_control_msg', data);
  }

  onStreamMessage(data: TranscriptMessage) {
    this.emit('on_stream_msg', data);
  }

  private parseTypeId(rawTypeId: ITypeId): TypeId | null {
    try {
      if (typeof rawTypeId === 'string') {
        // Backward compatibility for old "type:id" payloads.
        if (rawTypeId.includes(':') && !rawTypeId.includes('-')) {
          const [type, id] = rawTypeId.split(':', 2);
          if (!type || !id) return null;
          return new TypeId(type, id);
        }
        return new TypeId(rawTypeId);
      }

      if (
        rawTypeId &&
        typeof rawTypeId === 'object' &&
        'type' in rawTypeId &&
        'id' in rawTypeId &&
        typeof rawTypeId.type === 'string' &&
        typeof rawTypeId.id === 'string'
      ) {
        return new TypeId(rawTypeId.type, rawTypeId.id);
      }
    } catch (error) {
      console.warn('Failed parsing websocket TypeId:', rawTypeId, error);
    }
    return null;
  }

  onDataOpMessage(data: DataOpMessage) {
    const typeId = this.parseTypeId(data.to_entity);
    if (!typeId) {
      console.warn('Ignoring data_op message with invalid to_entity:', data.to_entity);
      return;
    }
    this.emit('on_data_op', typeId.toString(), data.op, data.data);
  }
  onOAuthMessage(data: OAuthMessage) {
    this.emit('on_oauth_msg', data);
  }
  onLlmConfigMessage(data: LlmConfigMessage) {
    this.emit('on_llm_config_msg', data);
  }
  onHubClientErrorMessage(data: HubClientErrorMessage) {
    this.emit('on_hub_client_error_msg', data);
  }
  onAuthExpiredMessage(data: AuthExpiredMessage) {
    this.emit('on_auth_expired_msg', data);
  }
  onPtyOutputMessage(data: PtyOutputMessage) {
    this.emit('on_pty_output_msg', data);
  }

  onFlowDataMessage(data: FlowDataMessage) {
    const typeId = this.parseTypeId(data.to_entity);
    if (!typeId) {
      console.warn('Ignoring flow_data message with invalid to_entity:', data.to_entity);
      return;
    }

    // Emit event for listeners
    this.emit('on_flow_data', typeId, data.flow_data);
  }

  onResponseMessage(data: ResponseMessage) {
    if (!data.response_message_id) {
      // Server push/handshake response, not a reply to sendRestApiMessage.
      return;
    }

    const pending = this.pendingRequests.get(data.response_message_id);
    if (!pending) {
      if (
        data.content &&
        typeof data.content === 'object' &&
        'message_type' in data.content &&
        data.content.message_type === 'pty_output_msg'
      ) {
        this.onPtyOutputMessage(data.content as PtyOutputMessage);
        return;
      }
      console.warn('Received response for unknown request:', data.response_message_id);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(data.response_message_id);

    if (data.error) {
      pending.reject(new Error(data.error));
    } else {
      pending.resolve(data.content);
    }
  }

  sendRestApiMessage<T>(message: RestApiMessage, options?: IWSRestOptions): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const timeoutMs = options?.timeout ?? this.requestTimeoutMs;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(message.message_id);
        reject(new Error(`Request timeout for message_id: ${message.message_id}`));
      }, timeoutMs);

      this.pendingRequests.set(message.message_id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      this.socket.send(JSON.stringify(message));
    });
  }

  send(data: any) {
    if (!this.socket) {
      throw new Error('WebSocket not connected');
    }
    this.socket.send(data);
  }

  get connected() {
    if (!this.socket) {
      return false;
    }
    return this.socket.readyState === WebSocket.OPEN;
  }

  public static getInstance(): ConnectionManager {
    if (!ConnectionManager.instance) {
      ConnectionManager.instance = new ConnectionManager();
    }
    return ConnectionManager.instance;
  }

  public getSocket() {
    return this.socket;
  }
}

// Create singleton instance and define as global for console debugability
export const connectionManager = ConnectionManager.getInstance();
defineGlobal('connection_manager', connectionManager);

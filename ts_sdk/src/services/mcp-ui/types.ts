/**
 * MCP UI Protocol Types
 *
 * Based on the official MCP Apps Extension (SEP-1865) specification.
 * See: https://github.com/modelcontextprotocol/ext-apps
 */

/**
 * Protocol version for MCP UI communication
 */
export const MCP_UI_PROTOCOL_VERSION = '2025-11-25';

/**
 * JSON-RPC 2.0 message types
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/**
 * MCP UI method names (official SDK constants)
 */
export const MCPUIMethods = {
  // Guest → Host (Requests)
  INITIALIZE: 'ui/initialize',
  MESSAGE: 'ui/message',
  OPEN_LINK: 'ui/open-link',
  TOOLS_CALL: 'tools/call',
  RESOURCES_READ: 'resources/read',

  // Guest → Host (Notifications)
  INITIALIZED: 'ui/notifications/initialized',
  SIZE_CHANGE: 'ui/notifications/size-change',

  // Host → Guest (Notifications)
  TOOL_INPUT: 'ui/notifications/tool-input',
  TOOL_INPUT_PARTIAL: 'ui/notifications/tool-input-partial',
  TOOL_RESULT: 'ui/notifications/tool-result',
  TOOL_CANCELLED: 'ui/notifications/tool-cancelled',
  HOST_CONTEXT_CHANGED: 'ui/notifications/host-context-changed',

  // Lifecycle
  RESOURCE_TEARDOWN: 'ui/resource-teardown',
} as const;

/**
 * Host context information sent to guest
 */
export interface HostContext {
  theme?: 'light' | 'dark' | 'auto';
  displayMode?: 'inline' | 'modal' | 'fullscreen';
  viewport?: {
    width: number;
    height: number;
  };
  locale?: string;
}

/**
 * App info sent by guest during initialization
 */
export interface AppInfo {
  name: string;
  version: string;
}

/**
 * Host info sent to guest during initialization
 */
export interface HostInfo {
  name: string;
  version: string;
}

/**
 * Capabilities negotiated during initialization
 */
export interface Capabilities {
  tools?: boolean;
  resources?: boolean;
  messages?: boolean;
  openLink?: boolean;
}

/**
 * Initialize request parameters (Guest → Host)
 */
export interface InitializeParams {
  protocolVersion: string;
  appInfo: AppInfo;
  capabilities: Capabilities;
}

/**
 * Initialize response result (Host → Guest)
 */
export interface InitializeResult {
  protocolVersion: string;
  hostInfo: HostInfo;
  hostContext: HostContext;
  capabilities?: Capabilities;
}

/**
 * Tool input notification parameters
 */
export interface ToolInputParams {
  arguments: Record<string, unknown>;
}

/**
 * Size change notification parameters
 */
export interface SizeChangeParams {
  width?: number;
  height?: number;
}

/**
 * Message request parameters (Guest → Host)
 */
export interface MessageParams {
  role: string;
  content: ContentBlock[];
}

/**
 * Content block for messages
 */
export interface ContentBlock {
  type: 'text' | 'image' | 'resource';
  text?: string;
  source?: string;
  mimeType?: string;
  data?: string;
}

/**
 * Eval request/response for JavaScript execution
 */
export interface EvalParams {
  code: string;
}

export interface EvalResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Resource teardown parameters
 */
export interface ResourceTeardownParams {
  reason?: string;
}

/**
 * MCP UI Event types emitted by MCPUIComponent
 */
export type MCPUIEvent =
  | 'initialized'
  | 'message'
  | 'open-link'
  | 'size-change'
  | 'tool-call'
  | 'resource-read'
  | 'eval-result'
  | 'error'
  | 'teardown';

/**
 * Event handler function type
 */
export type MCPUIEventHandler<T = unknown> = (data: T) => void;

/**
 * Configuration for MCPUIComponent
 */
export interface MCPUIComponentConfig {
  /** The ui:// URI of the component */
  uri: string;
  /** HTML content for the component */
  html: string;
  /** Initial host context */
  hostContext?: HostContext;
  /** Sandbox permissions for iframe */
  sandboxPermissions?: string[];
  /** Custom styles for iframe */
  style?: Partial<CSSStyleDeclaration>;
}

/**
 * Options for showing a component
 */
export interface ShowOptions {
  /** Page/view identifier within the component */
  pageName?: string;
  /** Key-value params sent via ui/notifications/tool-input */
  params?: Record<string, unknown>;
  /** Container element or selector for the iframe */
  viewer?: HTMLElement | string;
}

/**
 * Options for loading a component
 */
export interface LoadOptions {
  /** Initial host context */
  hostContext?: HostContext;
  /** Custom sandbox permissions */
  sandboxPermissions?: string[];
  /** Custom iframe styles */
  style?: Partial<CSSStyleDeclaration>;
  /** Timeout for initialization handshake (ms) */
  initTimeout?: number;
}

/**
 * Component state
 */
export enum MCPUIComponentState {
  CREATED = 'created',
  LOADING = 'loading',
  INITIALIZED = 'initialized',
  SHOWN = 'shown',
  HIDDEN = 'hidden',
  CLOSED = 'closed',
  ERROR = 'error',
}

/**
 * Default sandbox permissions for iframe
 */
export const DEFAULT_SANDBOX_PERMISSIONS = ['allow-scripts'];

/**
 * Default initialization timeout (ms)
 */
export const DEFAULT_INIT_TIMEOUT = 10000;

/**
 * Configuration for MCPUIViewer
 */
export interface MCPUIViewerConfig {
  /** Container element or selector */
  container: HTMLElement | string;
  /** Default host context for all components */
  hostContext?: HostContext;
}

/**
 * Options for adding a component to viewer
 */
export interface ViewerAddOptions {
  /** Make this component active immediately */
  activate?: boolean;
  /** Custom ID (defaults to component.id) */
  id?: string;
}

/**
 * MCPUIViewer events
 */
export type MCPUIViewerEvent =
  | 'component-added'
  | 'component-removed'
  | 'component-activated'
  | 'component-deactivated'
  | 'error';

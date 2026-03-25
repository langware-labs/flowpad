/**
 * MCPUIComponent - Represents a single MCP UI component instance
 *
 * This class manages the lifecycle of an MCP UI component, including:
 * - iframe creation and management
 * - JSON-RPC 2.0 messaging over postMessage
 * - Initialization handshake
 * - Event handling
 * - JavaScript code evaluation in the iframe context
 */

import { EventEmitter } from 'events';
import {
  type AppInfo,
  type Capabilities,
  DEFAULT_INIT_TIMEOUT,
  DEFAULT_SANDBOX_PERMISSIONS,
  type EvalParams,
  type EvalResult,
  type HostContext,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type MCPUIComponentConfig,
  MCPUIComponentState,
  type MCPUIEvent,
  type MCPUIEventHandler,
  MCPUIMethods,
  MCP_UI_PROTOCOL_VERSION,
  type MessageParams,
  type ShowOptions,
  type SizeChangeParams,
  type ToolInputParams,
} from './types';

/**
 * Generates a unique message ID for JSON-RPC requests
 */
let messageIdCounter = 0;
function generateMessageId(): number {
  return ++messageIdCounter;
}

/**
 * MCPUIComponent class - manages a single MCP UI component
 */
export class MCPUIComponent extends EventEmitter {
  /** Unique component ID */
  public readonly id: string;

  /** The ui:// URI of this component */
  public readonly uri: string;

  /** Current state of the component */
  private _state: MCPUIComponentState = MCPUIComponentState.CREATED;

  /** The iframe element */
  private iframe: HTMLIFrameElement | null = null;

  /** The container element */
  private container: HTMLElement | null = null;

  /** HTML content for the component */
  private readonly html: string;

  /** Host context for the component */
  private hostContext: HostContext;

  /** Sandbox permissions for iframe */
  private readonly sandboxPermissions: string[];

  /** Custom styles for iframe */
  private readonly style: Partial<CSSStyleDeclaration>;

  /** Pending JSON-RPC requests awaiting response */
  private pendingRequests: Map<
    number | string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  > = new Map();

  /** Message listener bound to this instance */
  private messageListener: ((event: MessageEvent) => void) | null = null;

  /** App info received from guest during initialization */
  private guestAppInfo_: AppInfo | null = null;

  /** Guest capabilities */
  private guestCapabilities_: Capabilities = {};

  /** Request timeout (ms) */
  private requestTimeout = 30000;

  /** Expected guest origin (for security validation) */
  private expectedGuestOrigin: string | null = null;

  constructor(config: MCPUIComponentConfig) {
    super();
    this.id = `mcp-ui-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.uri = config.uri;
    this.html = config.html;
    this.hostContext = config.hostContext || { theme: 'light', displayMode: 'inline' };
    this.sandboxPermissions = config.sandboxPermissions || [...DEFAULT_SANDBOX_PERMISSIONS];
    this.style = config.style || {};
  }

  /**
   * Get the current component state
   */
  get state(): MCPUIComponentState {
    return this._state;
  }

  /**
   * Check if the component is initialized
   */
  get isInitialized(): boolean {
    return this._state === MCPUIComponentState.INITIALIZED || this._state === MCPUIComponentState.SHOWN;
  }

  /**
   * Check if the component is visible
   */
  get isVisible(): boolean {
    return this._state === MCPUIComponentState.SHOWN;
  }

  /**
   * Get the guest app info (set during initialization)
   */
  get guestAppInfo(): AppInfo | null {
    return this.guestAppInfo_;
  }

  /**
   * Get the guest capabilities (set during initialization)
   */
  get guestCapabilities(): Capabilities {
    return this.guestCapabilities_;
  }

  /**
   * Get the iframe element (for testing/debugging)
   */
  getIframe(): HTMLIFrameElement | null {
    return this.iframe;
  }

  /**
   * Initialize the component and perform handshake
   * This creates the iframe, sets up message listeners, and waits for initialization
   *
   * @param timeout - Timeout for initialization handshake (ms)
   */
  async initialize(timeout: number = DEFAULT_INIT_TIMEOUT): Promise<void> {
    if (this._state !== MCPUIComponentState.CREATED) {
      throw new Error(`Cannot initialize component in state: ${this._state}`);
    }

    this._state = MCPUIComponentState.LOADING;

    try {
      // Create iframe
      this.iframe = document.createElement('iframe');
      this.iframe.id = this.id;
      this.iframe.setAttribute('sandbox', this.sandboxPermissions.join(' '));

      // Apply default styles
      this.iframe.style.border = 'none';
      this.iframe.style.width = '100%';
      this.iframe.style.height = '100%';

      // Apply custom styles
      for (const [key, value] of Object.entries(this.style)) {
        if (typeof value === 'string') {
          this.iframe.style.setProperty(key, value);
        }
      }

      // Set up message listener
      this.messageListener = this.handleMessage.bind(this);
      window.addEventListener('message', this.messageListener);

      // For srcdoc, the origin will be 'null' in most browsers
      this.expectedGuestOrigin = 'null';

      // Add iframe to a hidden container so content loads
      // The iframe needs to be in the DOM for srcdoc to execute
      const hiddenContainer = document.createElement('div');
      hiddenContainer.style.position = 'absolute';
      hiddenContainer.style.width = '0';
      hiddenContainer.style.height = '0';
      hiddenContainer.style.overflow = 'hidden';
      hiddenContainer.style.visibility = 'hidden';
      hiddenContainer.appendChild(this.iframe);
      document.body.appendChild(hiddenContainer);

      try {
        // Wait for initialization handshake
        await this.waitForInitialization(timeout);
      } finally {
        // Remove the hidden container (iframe will be moved to viewer)
        if (hiddenContainer.parentNode) {
          hiddenContainer.removeChild(this.iframe);
          hiddenContainer.parentNode.removeChild(hiddenContainer);
        }
      }

      this._state = MCPUIComponentState.INITIALIZED;
    } catch (error) {
      this._state = MCPUIComponentState.ERROR;
      this.cleanup();
      throw error;
    }
  }

  /**
   * Wait for the guest to send ui/initialize request and respond
   */
  private waitForInitialization(timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Initialization timeout after ${timeout}ms`));
      }, timeout);

      // Set up one-time listener for initialized notification
      const onInitialized = () => {
        clearTimeout(timeoutId);
        this.off('initialized', onInitialized);
        resolve();
      };

      this.on('initialized', onInitialized);

      // Set content after listeners are ready
      if (this.iframe) {
        this.iframe.srcdoc = this.html;
      }
    });
  }

  /**
   * Handle incoming postMessage events
   */
  private handleMessage(event: MessageEvent): void {
    // Security: Validate origin
    // For srcdoc iframes, origin is 'null'
    if (this.expectedGuestOrigin && event.origin !== this.expectedGuestOrigin) {
      // Allow 'null' origin for srcdoc iframes
      if (event.origin !== 'null') {
        return;
      }
    }

    // Security: Validate source is our iframe
    if (this.iframe && event.source !== this.iframe.contentWindow) {
      return;
    }

    // Parse and handle message
    try {
      const message = event.data as JsonRpcMessage;
      if (!message || message.jsonrpc !== '2.0') {
        return;
      }

      if ('id' in message && 'method' in message) {
        // This is a request
        this.handleRequest(message);
      } else if ('id' in message && ('result' in message || 'error' in message)) {
        // This is a response
        this.handleResponse(message);
      } else if ('method' in message && !('id' in message)) {
        // This is a notification
        this.handleNotification(message);
      }
    } catch (error) {
      console.error('[MCPUIComponent] Error handling message:', error);
    }
  }

  /**
   * Handle JSON-RPC request from guest
   */
  private handleRequest(request: JsonRpcRequest): void {
    const { id, method, params } = request;

    switch (method) {
      case MCPUIMethods.INITIALIZE:
        this.handleInitializeRequest(id, params as unknown as InitializeParams);
        break;

      case MCPUIMethods.MESSAGE:
        this.emit('message', params as unknown as MessageParams);
        this.sendResponse(id, { success: true });
        break;

      case MCPUIMethods.OPEN_LINK:
        this.emit('open-link', params);
        this.sendResponse(id, { success: true });
        break;

      case MCPUIMethods.TOOLS_CALL:
        this.emit('tool-call', params);
        // Tool calls need async handling - emit event and let host respond
        break;

      case MCPUIMethods.RESOURCES_READ:
        this.emit('resource-read', params);
        break;

      default:
        this.sendError(id, -32601, `Method not found: ${method}`);
    }
  }

  /**
   * Handle ui/initialize request from guest
   */
  private handleInitializeRequest(id: number | string, params: InitializeParams): void {
    // Store guest info
    this.guestAppInfo_ = params.appInfo;
    this.guestCapabilities_ = params.capabilities || {};

    // Build response
    const result: InitializeResult = {
      protocolVersion: MCP_UI_PROTOCOL_VERSION,
      hostInfo: {
        name: 'FlowPad',
        version: '1.0.0',
      },
      hostContext: this.hostContext,
      capabilities: {
        tools: true,
        resources: true,
        messages: true,
        openLink: true,
      },
    };

    // Send response
    this.sendResponse(id, result);
  }

  /**
   * Handle JSON-RPC response from guest
   */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handle JSON-RPC notification from guest
   */
  private handleNotification(notification: JsonRpcNotification): void {
    const { method, params } = notification;

    switch (method) {
      case MCPUIMethods.INITIALIZED:
        this.emit('initialized', params);
        break;

      case MCPUIMethods.SIZE_CHANGE:
        this.handleSizeChange(params as SizeChangeParams);
        break;

      default:
        console.debug(`[MCPUIComponent] Unknown notification: ${method}`);
    }
  }

  /**
   * Handle size change notification from guest
   */
  private handleSizeChange(params: SizeChangeParams): void {
    if (this.iframe) {
      if (params.width !== undefined) {
        this.iframe.style.width = `${params.width}px`;
      }
      if (params.height !== undefined) {
        this.iframe.style.height = `${params.height}px`;
      }
    }
    this.emit('size-change', params);
  }

  /**
   * Send JSON-RPC response to guest
   */
  private sendResponse(id: number | string, result: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    this.postMessage(response);
  }

  /**
   * Send JSON-RPC error response to guest
   */
  private sendError(id: number | string, code: number, message: string, data?: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    };
    this.postMessage(response);
  }

  /**
   * Send JSON-RPC notification to guest
   */
  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.postMessage(notification);
  }

  /**
   * Send JSON-RPC request to guest and wait for response
   */
  private sendRequest<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = generateMessageId();

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for method: ${method}`));
      }, this.requestTimeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.postMessage(request);
    });
  }

  /**
   * Post a message to the iframe
   */
  private postMessage(message: JsonRpcMessage): void {
    if (!this.iframe?.contentWindow) {
      console.warn('[MCPUIComponent] Cannot post message - iframe not available');
      return;
    }

    // For srcdoc iframes, use '*' as target origin
    // In production with external URLs, use specific origin
    this.iframe.contentWindow.postMessage(message, '*');
  }

  /**
   * Show the component in a viewer
   *
   * @param pageName - Optional page/view identifier within the component
   * @param viewer - Container element or selector for the iframe
   * @param params - Key-value params sent via ui/notifications/tool-input
   */
  async show(pageName?: string, viewer?: HTMLElement | string, params?: Record<string, unknown>): Promise<void>;
  async show(options?: ShowOptions): Promise<void>;
  async show(
    pageNameOrOptions?: string | ShowOptions,
    viewer?: HTMLElement | string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    // Parse arguments
    let actualPageName: string | undefined;
    let actualViewer: HTMLElement | string | undefined;
    let actualParams: Record<string, unknown> | undefined;

    if (typeof pageNameOrOptions === 'object') {
      actualPageName = pageNameOrOptions.pageName;
      actualViewer = pageNameOrOptions.viewer;
      actualParams = pageNameOrOptions.params;
    } else {
      actualPageName = pageNameOrOptions;
      actualViewer = viewer;
      actualParams = params;
    }

    if (!this.isInitialized) {
      throw new Error('Component must be initialized before showing');
    }

    // Resolve container
    if (actualViewer) {
      if (typeof actualViewer === 'string') {
        const el = document.querySelector(actualViewer);
        if (!el) {
          throw new Error(`Container not found: ${actualViewer}`);
        }
        this.container = el as HTMLElement;
      } else {
        this.container = actualViewer;
      }
    }

    // Append iframe to container if we have one
    if (this.container && this.iframe) {
      this.container.appendChild(this.iframe);
    }

    // Send tool input with params
    const toolInputParams: ToolInputParams = {
      arguments: {
        ...actualParams,
        ...(actualPageName ? { _pageName: actualPageName } : {}),
      },
    };

    this.sendNotification(MCPUIMethods.TOOL_INPUT, { ...toolInputParams });

    this._state = MCPUIComponentState.SHOWN;
  }

  /**
   * Hide the component (preserves state)
   */
  hide(): void {
    if (!this.isVisible) {
      return;
    }

    if (this.iframe) {
      this.iframe.style.display = 'none';
    }

    this._state = MCPUIComponentState.HIDDEN;
  }

  /**
   * Unhide a hidden component
   */
  unhide(): void {
    if (this._state !== MCPUIComponentState.HIDDEN) {
      return;
    }

    if (this.iframe) {
      this.iframe.style.display = '';
    }

    this._state = MCPUIComponentState.SHOWN;
  }

  /**
   * Send parameters to the component
   *
   * @param params - Key-value params sent via ui/notifications/tool-input
   */
  sendParams(params: Record<string, unknown>): void {
    if (!this.isInitialized) {
      throw new Error('Component must be initialized before sending params');
    }

    this.sendNotification(MCPUIMethods.TOOL_INPUT, { arguments: params });
  }

  /**
   * Send a tool result to the component
   *
   * @param result - The result to send
   */
  sendResult(result: unknown): void {
    if (!this.isInitialized) {
      throw new Error('Component must be initialized before sending result');
    }

    this.sendNotification(MCPUIMethods.TOOL_RESULT, { result });
  }

  /**
   * Send a tool cancelled notification to the component
   *
   * @param reason - Optional reason for cancellation
   */
  sendCancelled(reason?: string): void {
    if (!this.isInitialized) {
      return;
    }

    this.sendNotification(MCPUIMethods.TOOL_CANCELLED, { reason });
  }

  /**
   * Update the host context and notify the component
   *
   * @param context - New host context values
   */
  updateHostContext(context: Partial<HostContext>): void {
    this.hostContext = { ...this.hostContext, ...context };

    if (this.isInitialized) {
      this.sendNotification(MCPUIMethods.HOST_CONTEXT_CHANGED, { hostContext: this.hostContext });
    }
  }

  /**
   * Execute JavaScript code in the iframe context
   *
   * This method sends a custom eval request to the iframe and waits for the result.
   * The iframe must have a handler for 'mcp-ui/eval' requests.
   *
   * @param code - JavaScript code to execute
   * @returns Promise with the evaluation result
   */
  async eval(code: string): Promise<EvalResult> {
    if (!this.isInitialized) {
      throw new Error('Component must be initialized before evaluating code');
    }

    const evalParams: EvalParams = { code };

    try {
      const result = await this.sendRequest<EvalResult>('mcp-ui/eval', { ...evalParams });
      this.emit('eval-result', result);
      return result;
    } catch (error) {
      const errorResult: EvalResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.emit('eval-result', errorResult);
      return errorResult;
    }
  }

  /**
   * Close and cleanup the component
   *
   * @param reason - Optional reason for closing
   */
  async close(reason?: string): Promise<void> {
    if (this._state === MCPUIComponentState.CLOSED) {
      return;
    }

    // Send teardown notification if initialized
    if (this.isInitialized) {
      try {
        await this.sendRequest(MCPUIMethods.RESOURCE_TEARDOWN, { reason });
      } catch {
        // Ignore teardown errors - we're closing anyway
      }
    }

    // Update state and emit event BEFORE cleanup (which removes listeners)
    this._state = MCPUIComponentState.CLOSED;
    this.emit('teardown', { reason });

    // Now cleanup resources
    this.cleanup();
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    // Remove message listener
    if (this.messageListener) {
      window.removeEventListener('message', this.messageListener);
      this.messageListener = null;
    }

    // Clear pending requests
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Component closed'));
    }
    this.pendingRequests.clear();

    // Remove iframe from DOM
    if (this.iframe?.parentNode) {
      this.iframe.parentNode.removeChild(this.iframe);
    }
    this.iframe = null;
    this.container = null;

    // Remove all event listeners
    this.removeAllListeners();
  }

  /**
   * Subscribe to an event
   *
   * @param event - Event name
   * @param handler - Event handler function
   */
  onEvent<T = unknown>(event: MCPUIEvent, handler: MCPUIEventHandler<T>): this {
    return this.on(event, handler);
  }

  /**
   * Unsubscribe from an event
   *
   * @param event - Event name
   * @param handler - Event handler function (optional - removes all if not provided)
   */
  offEvent<T = unknown>(event: MCPUIEvent, handler?: MCPUIEventHandler<T>): this {
    if (handler) {
      return this.off(event, handler);
    }
    return this.removeAllListeners(event);
  }
}

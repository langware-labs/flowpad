/**
 * MCPUIManager - Singleton manager for MCP UI components
 *
 * This class provides a high-level API for loading and managing MCP UI components.
 * It follows the official MCP Apps Extension (SEP-1865) specification.
 */

import { EventEmitter } from 'events';
import { MCPUIComponent } from './MCPUIComponent';
import {
  DEFAULT_INIT_TIMEOUT,
  DEFAULT_SANDBOX_PERMISSIONS,
  type HostContext,
  type LoadOptions,
  type MCPUIComponentConfig,
} from './types';

/**
 * MCPUIManager Events
 */
export enum MCPUIManagerEvent {
  COMPONENT_LOADED = 'component_loaded',
  COMPONENT_CLOSED = 'component_closed',
  COMPONENT_ERROR = 'component_error',
}

/**
 * Parsed ui:// URI
 */
interface ParsedURI {
  scheme: string;
  component: string;
  path: string;
}

/**
 * MCPUIManager class - singleton manager for MCP UI components
 */
export class MCPUIManager extends EventEmitter {
  private static instance: MCPUIManager | null = null;

  /** Registry of loaded components by URI */
  private components: Map<string, MCPUIComponent> = new Map();

  /** Registry of HTML content by URI (for caching) */
  private htmlCache: Map<string, string> = new Map();

  /** Default host context for new components */
  private defaultHostContext: HostContext = {
    theme: 'light',
    displayMode: 'inline',
  };

  private constructor() {
    super();
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): MCPUIManager {
    if (!MCPUIManager.instance) {
      MCPUIManager.instance = new MCPUIManager();
    }
    return MCPUIManager.instance;
  }

  /**
   * Reset the singleton instance (useful for testing)
   */
  public static resetInstance(): void {
    if (MCPUIManager.instance) {
      // Close all components
      for (const component of MCPUIManager.instance.components.values()) {
        void component.close('Manager reset');
      }
      MCPUIManager.instance.components.clear();
      MCPUIManager.instance.htmlCache.clear();
      MCPUIManager.instance.removeAllListeners();
    }
    MCPUIManager.instance = null;
  }

  /**
   * Parse a ui:// URI
   *
   * @param uri - The ui:// URI to parse
   * @returns Parsed URI components
   * @throws Error if URI is invalid
   */
  private parseURI(uri: string): ParsedURI {
    if (!uri.startsWith('ui://')) {
      throw new Error(`Invalid MCP UI URI: ${uri}. Must start with 'ui://'`);
    }

    const withoutScheme = uri.slice(5); // Remove 'ui://'
    const slashIndex = withoutScheme.indexOf('/');

    if (slashIndex === -1) {
      return {
        scheme: 'ui',
        component: withoutScheme,
        path: '',
      };
    }

    return {
      scheme: 'ui',
      component: withoutScheme.slice(0, slashIndex),
      path: withoutScheme.slice(slashIndex + 1),
    };
  }

  /**
   * Set the default host context for new components
   *
   * @param context - Default host context
   */
  setDefaultHostContext(context: Partial<HostContext>): void {
    this.defaultHostContext = { ...this.defaultHostContext, ...context };
  }

  /**
   * Get the default host context
   */
  getDefaultHostContext(): HostContext {
    return { ...this.defaultHostContext };
  }

  /**
   * Register HTML content for a ui:// URI
   *
   * This allows pre-registering HTML content that will be used when loading components.
   * Useful for bundled components or testing.
   *
   * @param uri - The ui:// URI to register
   * @param html - The HTML content
   */
  registerHTML(uri: string, html: string): void {
    this.parseURI(uri); // Validate URI format
    this.htmlCache.set(uri, html);
  }

  /**
   * Unregister HTML content for a ui:// URI
   *
   * @param uri - The ui:// URI to unregister
   */
  unregisterHTML(uri: string): void {
    this.htmlCache.delete(uri);
  }

  /**
   * Check if HTML is registered for a URI
   *
   * @param uri - The ui:// URI to check
   */
  hasHTML(uri: string): boolean {
    return this.htmlCache.has(uri);
  }

  /**
   * Get HTML content for a URI
   *
   * @param uri - The ui:// URI
   * @returns HTML content or undefined
   */
  getHTML(uri: string): string | undefined {
    return this.htmlCache.get(uri);
  }

  /**
   * Fetch HTML content from a URL
   *
   * @param url - The URL to fetch HTML from
   * @returns Promise with HTML content
   */
  async fetchHTML(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch HTML from ${url}: ${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  /**
   * Load a UI component from a ui:// URI
   *
   * This method:
   * 1. Parses the URI
   * 2. Retrieves HTML content (from cache or fetches)
   * 3. Creates MCPUIComponent instance
   * 4. Performs initialization handshake
   * 5. Returns the ready-to-use component
   *
   * @param uri - The ui:// URI of the component
   * @param options - Load options
   * @returns Promise with the initialized component
   */
  async load(uri: string, options: LoadOptions = {}): Promise<MCPUIComponent> {
    // Check if already loaded
    const existing = this.components.get(uri);
    if (existing && existing.isInitialized) {
      return existing;
    }

    // Parse URI to validate format (result not used, just validation)
    this.parseURI(uri);

    // Get HTML content
    const html = this.htmlCache.get(uri);
    if (!html) {
      throw new Error(`No HTML registered for URI: ${uri}. Use registerHTML() first or provide HTML content.`);
    }

    // Merge options with defaults
    const hostContext: HostContext = {
      ...this.defaultHostContext,
      ...options.hostContext,
    };

    const sandboxPermissions = options.sandboxPermissions || [...DEFAULT_SANDBOX_PERMISSIONS];
    const initTimeout = options.initTimeout ?? DEFAULT_INIT_TIMEOUT;

    // Create component config
    const config: MCPUIComponentConfig = {
      uri,
      html,
      hostContext,
      sandboxPermissions,
      style: options.style,
    };

    // Create component
    const component = new MCPUIComponent(config);

    // Set up event forwarding
    component.on('error', (error) => {
      this.emit(MCPUIManagerEvent.COMPONENT_ERROR, { uri, component, error });
    });

    component.on('teardown', () => {
      this.components.delete(uri);
      this.emit(MCPUIManagerEvent.COMPONENT_CLOSED, { uri, component });
    });

    try {
      // Initialize component
      await component.initialize(initTimeout);

      // Register component
      this.components.set(uri, component);
      this.emit(MCPUIManagerEvent.COMPONENT_LOADED, { uri, component });

      return component;
    } catch (error) {
      this.emit(MCPUIManagerEvent.COMPONENT_ERROR, { uri, component, error });
      throw error;
    }
  }

  /**
   * Load a UI component with inline HTML content
   *
   * Convenience method that registers HTML and loads in one step.
   *
   * @param uri - The ui:// URI for the component
   * @param html - The HTML content
   * @param options - Load options
   * @returns Promise with the initialized component
   */
  async loadWithHTML(uri: string, html: string, options: LoadOptions = {}): Promise<MCPUIComponent> {
    this.registerHTML(uri, html);
    return this.load(uri, options);
  }

  /**
   * Get a loaded component by URI
   *
   * @param uri - The ui:// URI
   * @returns The component or undefined
   */
  getComponent(uri: string): MCPUIComponent | undefined {
    return this.components.get(uri);
  }

  /**
   * Get all loaded components
   *
   * @returns Array of loaded components
   */
  getAllComponents(): MCPUIComponent[] {
    return Array.from(this.components.values());
  }

  /**
   * Check if a component is loaded
   *
   * @param uri - The ui:// URI
   */
  hasComponent(uri: string): boolean {
    return this.components.has(uri);
  }

  /**
   * Close a component by URI
   *
   * @param uri - The ui:// URI
   * @param reason - Optional reason for closing
   */
  async closeComponent(uri: string, reason?: string): Promise<void> {
    const component = this.components.get(uri);
    if (component) {
      await component.close(reason);
      // Note: component.close() will trigger 'teardown' event which removes it from the map
    }
  }

  /**
   * Close all loaded components
   *
   * @param reason - Optional reason for closing
   */
  async closeAll(reason?: string): Promise<void> {
    const closePromises = Array.from(this.components.values()).map((component) => component.close(reason));
    await Promise.all(closePromises);
  }

  /**
   * Get the number of loaded components
   */
  get componentCount(): number {
    return this.components.size;
  }
}

// Export singleton instance
export const mcpUIManager = MCPUIManager.getInstance();

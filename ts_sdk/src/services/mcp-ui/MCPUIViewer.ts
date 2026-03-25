/**
 * MCPUIViewer - ViewStack container for managing multiple MCPUIComponent instances
 *
 * This class implements the ViewStack pattern where only one component is visible at a time,
 * while hidden components maintain their state and can be quickly shown/hidden.
 *
 * Key principles:
 * 1. Single visible view at any time
 * 2. Hidden views preserve state (not destroyed)
 * 3. Container manages child lifecycle
 * 4. Event management for hidden vs active views
 */

import { EventEmitter } from 'events';
import { MCPUIComponent } from './MCPUIComponent';
import { mcpUIManager } from './MCPUIManager';
import {
  type HostContext,
  type LoadOptions,
  type MCPUIViewerConfig,
  type MCPUIViewerEvent,
  type ViewerAddOptions,
} from './types';

/**
 * MCPUIViewer class - ViewStack container for multiple MCP UI components
 */
export class MCPUIViewer extends EventEmitter {
  /** Unique viewer ID */
  public readonly id: string;

  /** The container element */
  private container: HTMLElement | null = null;

  /** Registry of components by ID */
  private components: Map<string, MCPUIComponent> = new Map();

  /** Ordered list of component IDs for navigation */
  private componentOrder: string[] = [];

  /** Currently active component ID */
  private _activeId: string | null = null;

  /** Default host context for components */
  private readonly hostContext: HostContext;

  /**
   * Create a new MCPUIViewer
   *
   * @param config - Viewer configuration
   */
  constructor(config: MCPUIViewerConfig) {
    super();
    this.id = `mcp-viewer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.hostContext = config.hostContext || { theme: 'light', displayMode: 'inline' };

    // Resolve container
    if (typeof config.container === 'string') {
      const el = document.querySelector(config.container);
      if (!el) {
        throw new Error(`Container not found: ${config.container}`);
      }
      this.container = el as HTMLElement;
    } else {
      this.container = config.container;
    }
  }

  // === Getters ===

  /**
   * Get the currently active component
   */
  get activeComponent(): MCPUIComponent | null {
    if (!this._activeId) {
      return null;
    }
    return this.components.get(this._activeId) || null;
  }

  /**
   * Get the ID of the currently active component
   */
  get activeId(): string | null {
    return this._activeId;
  }

  /**
   * Get the number of components in the viewer
   */
  get componentCount(): number {
    return this.components.size;
  }

  /**
   * Get all component IDs in order
   */
  get componentIds(): string[] {
    return [...this.componentOrder];
  }

  // === Component Management ===

  /**
   * Add a component to the viewer
   *
   * The component must be initialized before adding.
   * The iframe will be appended to the container with display:none.
   *
   * @param component - The MCPUIComponent to add
   * @param options - Options for adding the component
   * @returns The ID assigned to the component
   * @throws Error if component is not initialized or ID is duplicate
   */
  add(component: MCPUIComponent, options: ViewerAddOptions = {}): string {
    // Validate component is initialized
    if (!component.isInitialized) {
      throw new Error('Component must be initialized before adding to viewer');
    }

    // Determine component ID
    const id = options.id || component.id;

    // Check for duplicate ID
    if (this.components.has(id)) {
      throw new Error(`Component with ID "${id}" already exists in viewer`);
    }

    // Get the iframe
    const iframe = component.getIframe();
    if (!iframe) {
      throw new Error('Component iframe is not available');
    }

    // Set display:none and append to container
    iframe.style.display = 'none';
    if (this.container) {
      this.container.appendChild(iframe);
    }

    // Register component
    this.components.set(id, component);
    this.componentOrder.push(id);

    // Listen for component teardown
    const teardownHandler = () => {
      this.handleComponentTeardown(id);
    };
    component.on('teardown', teardownHandler);

    // Emit event
    this.emit('component-added', { id, component });

    // Auto-activate if first component or options.activate is true
    if (this.components.size === 1 || options.activate) {
      this.switchTo(id);
    }

    return id;
  }

  /**
   * Load a component from a URI and add it to the viewer
   *
   * @param uri - The ui:// URI of the component
   * @param options - Options for loading and adding
   * @returns The loaded and added component
   */
  async loadAndAdd(uri: string, options: ViewerAddOptions & LoadOptions = {}): Promise<MCPUIComponent> {
    // Extract load options
    const loadOptions: LoadOptions = {
      hostContext: options.hostContext || this.hostContext,
      sandboxPermissions: options.sandboxPermissions,
      style: options.style,
      initTimeout: options.initTimeout,
    };

    // Load component using manager
    const component = await mcpUIManager.load(uri, loadOptions);

    // Add to viewer
    this.add(component, {
      id: options.id,
      activate: options.activate,
    });

    return component;
  }

  /**
   * Remove a component from the viewer
   *
   * @param id - The ID of the component to remove
   * @param close - Whether to close the component (default: true)
   * @returns True if component was found and removed
   */
  remove(id: string, close: boolean = true): boolean {
    const component = this.components.get(id);
    if (!component) {
      return false;
    }

    // If this is the active component, deactivate it
    if (this._activeId === id) {
      this._activeId = null;
      this.emit('component-deactivated', { id, component });
    }

    // Remove from registry and order
    this.components.delete(id);
    const orderIndex = this.componentOrder.indexOf(id);
    if (orderIndex !== -1) {
      this.componentOrder.splice(orderIndex, 1);
    }

    // Emit removal event
    this.emit('component-removed', { id, component });

    // Close the component if requested
    if (close) {
      void component.close('Removed from viewer');
    }

    return true;
  }

  /**
   * Get a component by ID
   *
   * @param id - The component ID
   * @returns The component or undefined
   */
  get(id: string): MCPUIComponent | undefined {
    return this.components.get(id);
  }

  /**
   * Check if a component exists in the viewer
   *
   * @param id - The component ID
   */
  has(id: string): boolean {
    return this.components.has(id);
  }

  // === Navigation ===

  /**
   * Switch to a specific component
   *
   * @param id - The ID of the component to switch to
   * @param params - Optional params to send to the component
   * @returns True if switch was successful
   */
  switchTo(id: string, params?: Record<string, unknown>): boolean {
    const component = this.components.get(id);
    if (!component) {
      return false;
    }

    // Deactivate current component if different
    if (this._activeId && this._activeId !== id) {
      const currentComponent = this.components.get(this._activeId);
      if (currentComponent) {
        // Hide current component's iframe directly
        const currentIframe = currentComponent.getIframe();
        if (currentIframe) {
          currentIframe.style.display = 'none';
        }
        this.emit('component-deactivated', { id: this._activeId, component: currentComponent });
      }
    }

    // Activate new component - show iframe directly
    const iframe = component.getIframe();
    if (iframe) {
      iframe.style.display = '';
    }
    this._activeId = id;

    // Send params if provided
    if (params) {
      component.sendParams(params);
    }

    // Emit event
    this.emit('component-activated', { id, component, params });

    return true;
  }

  /**
   * Switch to the next component in order (wraps around)
   *
   * @param params - Optional params to send to the component
   * @returns True if switch was successful
   */
  next(params?: Record<string, unknown>): boolean {
    if (this.componentOrder.length === 0) {
      return false;
    }

    if (!this._activeId) {
      return this.switchTo(this.componentOrder[0], params);
    }

    const currentIndex = this.componentOrder.indexOf(this._activeId);
    const nextIndex = (currentIndex + 1) % this.componentOrder.length;
    return this.switchTo(this.componentOrder[nextIndex], params);
  }

  /**
   * Switch to the previous component in order (wraps around)
   *
   * @param params - Optional params to send to the component
   * @returns True if switch was successful
   */
  previous(params?: Record<string, unknown>): boolean {
    if (this.componentOrder.length === 0) {
      return false;
    }

    if (!this._activeId) {
      return this.switchTo(this.componentOrder[this.componentOrder.length - 1], params);
    }

    const currentIndex = this.componentOrder.indexOf(this._activeId);
    const prevIndex = (currentIndex - 1 + this.componentOrder.length) % this.componentOrder.length;
    return this.switchTo(this.componentOrder[prevIndex], params);
  }

  /**
   * Switch to the first component
   *
   * @param params - Optional params to send to the component
   * @returns True if switch was successful
   */
  first(params?: Record<string, unknown>): boolean {
    if (this.componentOrder.length === 0) {
      return false;
    }
    return this.switchTo(this.componentOrder[0], params);
  }

  /**
   * Switch to the last component
   *
   * @param params - Optional params to send to the component
   * @returns True if switch was successful
   */
  last(params?: Record<string, unknown>): boolean {
    if (this.componentOrder.length === 0) {
      return false;
    }
    return this.switchTo(this.componentOrder[this.componentOrder.length - 1], params);
  }

  // === Lifecycle ===

  /**
   * Destroy the viewer and close all components
   */
  async destroy(): Promise<void> {
    // Close all components in parallel
    const closePromises = Array.from(this.components.entries()).map(async ([id, component]) => {
      try {
        await component.close('Viewer destroyed');
      } catch (error) {
        this.emit('error', { id, error });
      }
    });

    await Promise.all(closePromises);

    // Clear all state
    this.components.clear();
    this.componentOrder = [];
    this._activeId = null;
    this.container = null;

    // Remove all listeners
    this.removeAllListeners();
  }

  // === Private Methods ===

  /**
   * Handle component teardown event
   */
  private handleComponentTeardown(id: string): void {
    // Only emit if component still exists (wasn't already removed)
    if (this.components.has(id)) {
      const component = this.components.get(id)!;

      // If this was the active component, clear active state
      if (this._activeId === id) {
        this._activeId = null;
        this.emit('component-deactivated', { id, component });
      }

      // Remove from registry
      this.components.delete(id);
      const orderIndex = this.componentOrder.indexOf(id);
      if (orderIndex !== -1) {
        this.componentOrder.splice(orderIndex, 1);
      }

      // Emit removal event
      this.emit('component-removed', { id, component, reason: 'teardown' });
    }
  }

  // === Event Type Overloads ===

  /**
   * Subscribe to a viewer event
   */
  onEvent(event: MCPUIViewerEvent, handler: (...args: unknown[]) => void): this {
    return this.on(event, handler);
  }

  /**
   * Unsubscribe from a viewer event
   */
  offEvent(event: MCPUIViewerEvent, handler?: (...args: unknown[]) => void): this {
    if (handler) {
      return this.off(event, handler);
    }
    return this.removeAllListeners(event);
  }
}

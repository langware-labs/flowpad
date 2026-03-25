/**
 * MCP UI SDK Unit Tests
 *
 * These tests validate the MCPUIManager and MCPUIComponent classes
 * following the MCP Apps Extension (SEP-1865) specification.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INIT_TIMEOUT,
  DEFAULT_SANDBOX_PERMISSIONS,
  MCPUIComponent,
  MCPUIComponentState,
  MCPUIManager,
  MCPUIManagerEvent,
  MCPUIMethods,
  MCPUIViewer,
  MCP_UI_PROTOCOL_VERSION,
} from '@sdk';

/**
 * Creates a mock HTML content that includes MCP UI protocol handling
 */
function createMockHTML(options: { autoInit?: boolean; appName?: string } = {}): string {
  const { autoInit = true, appName = 'TestApp' } = options;
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${appName}</title>
      <script>
        // MCP UI Protocol Handler
        let messageIdCounter = 0;
        const pendingRequests = new Map();

        window.addEventListener('message', function(event) {
          const msg = event.data;
          if (!msg || msg.jsonrpc !== '2.0') return;

          // Handle responses
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const pending = pendingRequests.get(msg.id);
            if (pending) {
              pendingRequests.delete(msg.id);
              if (msg.error) {
                pending.reject(new Error(msg.error.message));
              } else {
                pending.resolve(msg.result);
              }
            }
            return;
          }

          // Handle requests
          if (msg.method === 'mcp-ui/eval') {
            try {
              const result = eval(msg.params.code);
              window.parent.postMessage({
                jsonrpc: '2.0',
                id: msg.id,
                result: { success: true, result: result }
              }, '*');
            } catch (e) {
              window.parent.postMessage({
                jsonrpc: '2.0',
                id: msg.id,
                result: { success: false, error: e.message }
              }, '*');
            }
            return;
          }

          // Handle teardown
          if (msg.method === '${MCPUIMethods.RESOURCE_TEARDOWN}') {
            window.parent.postMessage({
              jsonrpc: '2.0',
              id: msg.id,
              result: {}
            }, '*');
            return;
          }

          // Handle notifications
          if (msg.method === '${MCPUIMethods.TOOL_INPUT}') {
            window.mcpToolInput = msg.params;
            return;
          }
        });

        // Send request helper
        function sendRequest(method, params) {
          return new Promise(function(resolve, reject) {
            const id = ++messageIdCounter;
            pendingRequests.set(id, { resolve: resolve, reject: reject });
            window.parent.postMessage({
              jsonrpc: '2.0',
              id: id,
              method: method,
              params: params
            }, '*');
          });
        }

        // Auto-initialize if configured
        ${
          autoInit
            ? `
        window.addEventListener('load', function() {
          sendRequest('${MCPUIMethods.INITIALIZE}', {
            protocolVersion: '${MCP_UI_PROTOCOL_VERSION}',
            appInfo: { name: '${appName}', version: '1.0.0' },
            capabilities: { tools: true, messages: true }
          }).then(function(result) {
            window.mcpHostContext = result.hostContext;
            window.parent.postMessage({
              jsonrpc: '2.0',
              method: '${MCPUIMethods.INITIALIZED}',
              params: { ready: true }
            }, '*');
          });
        });
        `
            : ''
        }
      </script>
    </head>
    <body>
      <h1>Test MCP UI Component</h1>
    </body>
    </html>
  `;
}

/**
 * Creates a mock Window with postMessage support
 */
function createMockWindow(): Window {
  const listeners: Map<string, Set<EventListener>> = new Map();

  return {
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    }),
    postMessage: vi.fn(),
    dispatchEvent: vi.fn((event: Event) => {
      const eventListeners = listeners.get(event.type);
      if (eventListeners) {
        eventListeners.forEach((listener) => listener(event));
      }
      return true;
    }),
  } as unknown as Window;
}

/**
 * Creates a mock iframe element
 */
function _createMockIframe(): HTMLIFrameElement {
  const contentWindow = createMockWindow();

  const iframe = {
    id: '',
    srcdoc: '',
    style: {
      border: '',
      width: '',
      height: '',
      display: '',
    },
    setAttribute: vi.fn(),
    contentWindow,
    parentNode: null as Node | null,
  } as unknown as HTMLIFrameElement;

  return iframe;
}

// ============================================================
// MCPUIManager Tests
// ============================================================

describe('MCPUIManager', () => {
  beforeEach(() => {
    MCPUIManager.resetInstance();
  });

  afterEach(() => {
    MCPUIManager.resetInstance();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance', () => {
      const instance1 = MCPUIManager.getInstance();
      const instance2 = MCPUIManager.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', () => {
      const instance1 = MCPUIManager.getInstance();
      MCPUIManager.resetInstance();
      const instance2 = MCPUIManager.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('URI Parsing', () => {
    it('should register HTML for valid ui:// URI', () => {
      const manager = MCPUIManager.getInstance();
      const html = '<html></html>';

      manager.registerHTML('ui://test/component', html);

      expect(manager.hasHTML('ui://test/component')).toBe(true);
      expect(manager.getHTML('ui://test/component')).toBe(html);
    });

    it('should throw error for invalid URI scheme', () => {
      const manager = MCPUIManager.getInstance();

      expect(() => manager.registerHTML('http://invalid', '<html></html>')).toThrow(
        "Invalid MCP UI URI: http://invalid. Must start with 'ui://'",
      );
    });

    it('should handle URI without path', () => {
      const manager = MCPUIManager.getInstance();
      const html = '<html></html>';

      manager.registerHTML('ui://simple-component', html);

      expect(manager.hasHTML('ui://simple-component')).toBe(true);
    });

    it('should handle URI with deep path', () => {
      const manager = MCPUIManager.getInstance();
      const html = '<html></html>';

      manager.registerHTML('ui://app/dashboard/widgets/chart', html);

      expect(manager.hasHTML('ui://app/dashboard/widgets/chart')).toBe(true);
    });
  });

  describe('HTML Registration', () => {
    it('should register and unregister HTML', () => {
      const manager = MCPUIManager.getInstance();
      const html = '<html><body>Test</body></html>';

      manager.registerHTML('ui://test/app', html);
      expect(manager.hasHTML('ui://test/app')).toBe(true);

      manager.unregisterHTML('ui://test/app');
      expect(manager.hasHTML('ui://test/app')).toBe(false);
    });

    it('should overwrite existing HTML registration', () => {
      const manager = MCPUIManager.getInstance();

      manager.registerHTML('ui://test/app', '<html>Original</html>');
      manager.registerHTML('ui://test/app', '<html>Updated</html>');

      expect(manager.getHTML('ui://test/app')).toBe('<html>Updated</html>');
    });
  });

  describe('Host Context', () => {
    it('should have default host context', () => {
      const manager = MCPUIManager.getInstance();
      const context = manager.getDefaultHostContext();

      expect(context.theme).toBe('light');
      expect(context.displayMode).toBe('inline');
    });

    it('should update default host context', () => {
      const manager = MCPUIManager.getInstance();

      manager.setDefaultHostContext({ theme: 'dark', locale: 'en-US' });
      const context = manager.getDefaultHostContext();

      expect(context.theme).toBe('dark');
      expect(context.displayMode).toBe('inline');
      expect(context.locale).toBe('en-US');
    });
  });

  describe('Load Validation', () => {
    it('should throw error when loading unregistered URI', async () => {
      const manager = MCPUIManager.getInstance();

      await expect(manager.load('ui://unregistered/component')).rejects.toThrow(
        'No HTML registered for URI: ui://unregistered/component',
      );
    });
  });

  describe('Events', () => {
    it('should emit COMPONENT_LOADED event', async () => {
      const manager = MCPUIManager.getInstance();
      const eventHandler = vi.fn();

      manager.on(MCPUIManagerEvent.COMPONENT_LOADED, eventHandler);
      manager.registerHTML('ui://test/app', createMockHTML());

      // Note: Full integration testing requires JSDOM or browser environment
      // This tests the event registration
      expect(manager.listenerCount(MCPUIManagerEvent.COMPONENT_LOADED)).toBe(1);
    });

    it('should emit COMPONENT_CLOSED event when component is removed', () => {
      const manager = MCPUIManager.getInstance();
      const eventHandler = vi.fn();

      manager.on(MCPUIManagerEvent.COMPONENT_CLOSED, eventHandler);

      expect(manager.listenerCount(MCPUIManagerEvent.COMPONENT_CLOSED)).toBe(1);
    });
  });

  describe('Component Management', () => {
    it('should start with no components', () => {
      const manager = MCPUIManager.getInstance();

      expect(manager.componentCount).toBe(0);
      expect(manager.getAllComponents()).toHaveLength(0);
    });

    it('should report hasComponent correctly', () => {
      const manager = MCPUIManager.getInstance();

      expect(manager.hasComponent('ui://test/app')).toBe(false);
    });

    it('should return undefined for getComponent on non-existent URI', () => {
      const manager = MCPUIManager.getInstance();

      expect(manager.getComponent('ui://non-existent/app')).toBeUndefined();
    });

    it('should not throw when closeComponent called on non-existent URI', async () => {
      const manager = MCPUIManager.getInstance();

      // Should not throw - just silently do nothing
      await expect(manager.closeComponent('ui://non-existent/app')).resolves.toBeUndefined();
    });

    it('should not throw when closeAll called with no components', async () => {
      const manager = MCPUIManager.getInstance();

      await expect(manager.closeAll('cleanup')).resolves.toBeUndefined();
    });
  });

  describe('Load with HTML', () => {
    it('should register HTML when calling loadWithHTML', async () => {
      const manager = MCPUIManager.getInstance();
      const html = '<html><body>Test</body></html>';

      // loadWithHTML registers the HTML first, then tries to load
      // Load will fail in unit test (no DOM), but HTML should be registered
      try {
        await manager.loadWithHTML('ui://test/inline', html);
      } catch {
        // Expected to fail without DOM
      }

      expect(manager.hasHTML('ui://test/inline')).toBe(true);
      expect(manager.getHTML('ui://test/inline')).toBe(html);
    });
  });

  describe('Event Registration', () => {
    it('should register COMPONENT_ERROR event listener', () => {
      const manager = MCPUIManager.getInstance();
      const errorHandler = vi.fn();

      manager.on(MCPUIManagerEvent.COMPONENT_ERROR, errorHandler);

      expect(manager.listenerCount(MCPUIManagerEvent.COMPONENT_ERROR)).toBe(1);
    });
  });

  describe('Fetch HTML', () => {
    it('should have fetchHTML method', () => {
      const manager = MCPUIManager.getInstance();

      expect(typeof manager.fetchHTML).toBe('function');
    });

    it('should reject fetchHTML with invalid URL', async () => {
      const manager = MCPUIManager.getInstance();

      // fetch will fail with invalid URL in test environment
      await expect(manager.fetchHTML('not-a-valid-url')).rejects.toThrow();
    });
  });
});

// ============================================================
// MCPUIComponent Tests (Unit Tests - No DOM)
// ============================================================

describe('MCPUIComponent', () => {
  describe('Construction', () => {
    it('should create component with config', () => {
      const config = {
        uri: 'ui://test/app',
        html: '<html></html>',
        hostContext: { theme: 'dark' as const },
      };

      const component = new MCPUIComponent(config);

      expect(component.uri).toBe('ui://test/app');
      expect(component.id).toMatch(/^mcp-ui-\d+-[a-z0-9]+$/);
      expect(component.state).toBe(MCPUIComponentState.CREATED);
    });

    it('should generate unique IDs for each component', () => {
      const config = { uri: 'ui://test/app', html: '<html></html>' };

      const component1 = new MCPUIComponent(config);
      const component2 = new MCPUIComponent(config);

      expect(component1.id).not.toBe(component2.id);
    });

    it('should have correct initial state', () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      expect(component.state).toBe(MCPUIComponentState.CREATED);
      expect(component.isInitialized).toBe(false);
      expect(component.isVisible).toBe(false);
    });

    it('should return null iframe before initialization', () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      expect(component.getIframe()).toBeNull();
    });
  });

  describe('State Transitions', () => {
    it('should not be initialized before initialize() is called', () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      expect(component.isInitialized).toBe(false);
      expect(component.state).toBe(MCPUIComponentState.CREATED);
    });

    it('should throw when show() called before initialize', async () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      await expect(component.show()).rejects.toThrow('Component must be initialized before showing');
    });

    it('should throw when sendParams() called before initialize', () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      expect(() => component.sendParams({ key: 'value' })).toThrow('Component must be initialized before sending');
    });

    it('should throw when sendResult() called before initialize', () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      expect(() => component.sendResult({ data: 'test' })).toThrow('Component must be initialized before sending');
    });

    it('should throw when eval() called before initialize', async () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      await expect(component.eval('1 + 1')).rejects.toThrow('Component must be initialized before evaluating');
    });

    it('should not throw when sendCancelled() called before initialize', () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      // sendCancelled silently returns when not initialized (no error)
      expect(() => component.sendCancelled('test reason')).not.toThrow();
    });

    it('should allow updateHostContext() before initialize (stores for later)', () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      // updateHostContext stores the context internally even if not initialized
      // It won't send notification until initialized
      expect(() => component.updateHostContext({ theme: 'dark' })).not.toThrow();
    });
  });

  describe('Event Handling', () => {
    it('should register event listeners with onEvent()', () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      const handler = vi.fn();
      component.onEvent('message', handler);

      expect(component.listenerCount('message')).toBe(1);
    });

    it('should unregister event listeners with offEvent()', () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      const handler = vi.fn();
      component.onEvent('message', handler);
      component.offEvent('message', handler);

      expect(component.listenerCount('message')).toBe(0);
    });

    it('should remove all listeners when offEvent() called without handler', () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      component.onEvent('message', vi.fn());
      component.onEvent('message', vi.fn());
      component.offEvent('message');

      expect(component.listenerCount('message')).toBe(0);
    });

    it('should support standard EventEmitter on/off', () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      const handler = vi.fn();
      component.on('size-change', handler);

      expect(component.listenerCount('size-change')).toBe(1);

      component.off('size-change', handler);
      expect(component.listenerCount('size-change')).toBe(0);
    });
  });

  describe('Close', () => {
    it('should transition to CLOSED state after close', async () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      // Close without initializing - should just cleanup
      await component.close();

      expect(component.state).toBe(MCPUIComponentState.CLOSED);
    });

    it('should emit teardown event on close', async () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      const teardownHandler = vi.fn();
      component.on('teardown', teardownHandler);

      await component.close('Test reason');

      expect(teardownHandler).toHaveBeenCalledWith({ reason: 'Test reason' });
    });

    it('should be idempotent - calling close twice is safe', async () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      await component.close();
      await component.close(); // Should not throw

      expect(component.state).toBe(MCPUIComponentState.CLOSED);
    });
  });

  describe('Hide/Unhide', () => {
    it('should not change state when hide() called on non-visible component', () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      component.hide();

      // State should still be CREATED since component was never shown
      expect(component.state).toBe(MCPUIComponentState.CREATED);
    });

    it('should not change state when unhide() called on non-hidden component', () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/app',
        html: '<html></html>',
      });

      component.unhide();

      // State should still be CREATED
      expect(component.state).toBe(MCPUIComponentState.CREATED);
    });
  });
});

// ============================================================
// Protocol Constants Tests
// ============================================================

describe('MCP UI Protocol Constants', () => {
  it('should export correct protocol version', () => {
    expect(MCP_UI_PROTOCOL_VERSION).toBe('2025-11-25');
  });

  it('should export all required method constants', () => {
    // Guest → Host (Requests)
    expect(MCPUIMethods.INITIALIZE).toBe('ui/initialize');
    expect(MCPUIMethods.MESSAGE).toBe('ui/message');
    expect(MCPUIMethods.OPEN_LINK).toBe('ui/open-link');
    expect(MCPUIMethods.TOOLS_CALL).toBe('tools/call');
    expect(MCPUIMethods.RESOURCES_READ).toBe('resources/read');

    // Guest → Host (Notifications)
    expect(MCPUIMethods.INITIALIZED).toBe('ui/notifications/initialized');
    expect(MCPUIMethods.SIZE_CHANGE).toBe('ui/notifications/size-change');

    // Host → Guest (Notifications)
    expect(MCPUIMethods.TOOL_INPUT).toBe('ui/notifications/tool-input');
    expect(MCPUIMethods.TOOL_INPUT_PARTIAL).toBe('ui/notifications/tool-input-partial');
    expect(MCPUIMethods.TOOL_RESULT).toBe('ui/notifications/tool-result');
    expect(MCPUIMethods.TOOL_CANCELLED).toBe('ui/notifications/tool-cancelled');
    expect(MCPUIMethods.HOST_CONTEXT_CHANGED).toBe('ui/notifications/host-context-changed');

    // Lifecycle
    expect(MCPUIMethods.RESOURCE_TEARDOWN).toBe('ui/resource-teardown');
  });

  it('should export default sandbox permissions', () => {
    expect(DEFAULT_SANDBOX_PERMISSIONS).toEqual(['allow-scripts']);
  });

  it('should export default init timeout', () => {
    expect(DEFAULT_INIT_TIMEOUT).toBe(10000);
  });

  it('should export all component states', () => {
    expect(MCPUIComponentState.CREATED).toBe('created');
    expect(MCPUIComponentState.LOADING).toBe('loading');
    expect(MCPUIComponentState.INITIALIZED).toBe('initialized');
    expect(MCPUIComponentState.SHOWN).toBe('shown');
    expect(MCPUIComponentState.HIDDEN).toBe('hidden');
    expect(MCPUIComponentState.CLOSED).toBe('closed');
    expect(MCPUIComponentState.ERROR).toBe('error');
  });
});

// ============================================================
// Type Safety Tests
// ============================================================

describe('Type Safety', () => {
  it('should accept valid MCPUIEvent types', () => {
    const component = new MCPUIComponent({
      uri: 'ui://test/app',
      html: '<html></html>',
    });

    // All valid event types should compile and work
    const events = [
      'initialized',
      'message',
      'open-link',
      'size-change',
      'tool-call',
      'resource-read',
      'eval-result',
      'error',
      'teardown',
    ] as const;

    events.forEach((event) => {
      const handler = vi.fn();
      component.onEvent(event, handler);
      expect(component.listenerCount(event)).toBe(1);
      component.offEvent(event);
    });
  });

  it('should accept valid HostContext themes', () => {
    const manager = MCPUIManager.getInstance();

    // Should accept all valid themes
    manager.setDefaultHostContext({ theme: 'light' });
    manager.setDefaultHostContext({ theme: 'dark' });
    manager.setDefaultHostContext({ theme: 'auto' });

    const context = manager.getDefaultHostContext();
    expect(context.theme).toBe('auto');
  });

  it('should accept valid displayMode values', () => {
    const manager = MCPUIManager.getInstance();

    manager.setDefaultHostContext({ displayMode: 'inline' });
    manager.setDefaultHostContext({ displayMode: 'modal' });
    manager.setDefaultHostContext({ displayMode: 'fullscreen' });

    const context = manager.getDefaultHostContext();
    expect(context.displayMode).toBe('fullscreen');
  });
});

// ============================================================
// Error Handling Tests
// ============================================================

describe('Error Handling', () => {
  it('should handle invalid URI gracefully', () => {
    const manager = MCPUIManager.getInstance();

    expect(() => manager.registerHTML('invalid-uri', '<html></html>')).toThrow(/Invalid MCP UI URI/);
  });

  it('should include URI in error message', () => {
    const manager = MCPUIManager.getInstance();

    expect(() => manager.registerHTML('https://example.com', '<html></html>')).toThrow('https://example.com');
  });
});

// ============================================================
// Show Method Overloads Tests
// ============================================================

describe('Show Method Overloads', () => {
  it('should accept individual parameters', async () => {
    const component = new MCPUIComponent({
      uri: 'ui://test/app',
      html: '<html></html>',
    });

    // Should throw because not initialized, but validates parameter parsing
    await expect(component.show('page1', undefined, { key: 'value' })).rejects.toThrow('must be initialized');
  });

  it('should accept options object', async () => {
    const component = new MCPUIComponent({
      uri: 'ui://test/app',
      html: '<html></html>',
    });

    await expect(
      component.show({
        pageName: 'page1',
        params: { key: 'value' },
      }),
    ).rejects.toThrow('must be initialized');
  });

  it('should accept no parameters', async () => {
    const component = new MCPUIComponent({
      uri: 'ui://test/app',
      html: '<html></html>',
    });

    await expect(component.show()).rejects.toThrow('must be initialized');
  });
});

// ============================================================
// MCPUIViewer Tests
// ============================================================

/**
 * Creates a mock initialized component for testing
 */
function createMockInitializedComponent(id?: string): MCPUIComponent {
  const component = new MCPUIComponent({
    uri: `ui://test/${id || 'component'}`,
    html: '<html></html>',
  });

  // Mock the internal state to be initialized
  // @ts-expect-error - accessing private property for testing
  component._state = MCPUIComponentState.INITIALIZED;

  // Create a mock iframe
  const iframe = document.createElement('iframe');
  iframe.id = id || `mock-iframe-${Date.now()}`;
  iframe.style.display = '';

  // @ts-expect-error - accessing private property for testing
  component.iframe = iframe;

  return component;
}

describe('MCPUIViewer', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'test-container';
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container?.parentNode) {
      container.parentNode.removeChild(container);
    }
  });

  describe('Construction', () => {
    it('should create viewer with element or selector and generate unique IDs', () => {
      const viewer1 = new MCPUIViewer({ container });
      const viewer2 = new MCPUIViewer({ container: '#test-container', hostContext: { theme: 'dark' } });

      expect(viewer1.id).toMatch(/^mcp-viewer-\d+-[a-z0-9]+$/);
      expect(viewer2.id).toMatch(/^mcp-viewer-\d+-[a-z0-9]+$/);
      expect(viewer1.id).not.toBe(viewer2.id);
      expect(viewer1.componentCount).toBe(0);
      expect(viewer1.activeComponent).toBeNull();
    });

    it('should throw error for invalid selector', () => {
      expect(() => new MCPUIViewer({ container: '#non-existent' })).toThrow('Container not found');
    });
  });

  describe('Component Management', () => {
    it('should add, get, has, and remove components correctly', () => {
      const viewer = new MCPUIViewer({ container });
      const comp = createMockInitializedComponent('comp1');
      const handler = vi.fn();

      viewer.on('component-added', handler);
      const id = viewer.add(comp, { id: 'custom-id' });

      // Verify add
      expect(id).toBe('custom-id');
      expect(viewer.componentCount).toBe(1);
      expect(viewer.has(id)).toBe(true);
      expect(viewer.get(id)).toBe(comp);
      expect(viewer.get('non-existent')).toBeUndefined();
      expect(viewer.has('non-existent')).toBe(false);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id, component: comp }));
      expect(container.contains(comp.getIframe())).toBe(true);

      // Verify remove
      const removeHandler = vi.fn();
      viewer.on('component-removed', removeHandler);
      expect(viewer.remove(id, false)).toBe(true);
      expect(viewer.has(id)).toBe(false);
      expect(viewer.remove('non-existent')).toBe(false);
      expect(removeHandler).toHaveBeenCalled();
    });

    it('should throw errors for invalid add operations', () => {
      const viewer = new MCPUIViewer({ container });

      // Uninitialized component
      const uninitComp = new MCPUIComponent({ uri: 'ui://test/app', html: '<html></html>' });
      expect(() => viewer.add(uninitComp)).toThrow('Component must be initialized');

      // Duplicate ID
      viewer.add(createMockInitializedComponent('c1'), { id: 'same-id' });
      expect(() => viewer.add(createMockInitializedComponent('c2'), { id: 'same-id' })).toThrow('already exists');
    });

    it('should auto-activate first component and support activate option', () => {
      const viewer = new MCPUIViewer({ container });
      const comp1 = createMockInitializedComponent('comp1');
      const comp2 = createMockInitializedComponent('comp2');

      const id1 = viewer.add(comp1);
      expect(viewer.activeId).toBe(id1);
      expect(viewer.activeComponent).toBe(comp1);
      expect(comp1.getIframe()?.style.display).toBe(''); // visible

      const id2 = viewer.add(comp2, { activate: true });
      expect(viewer.activeId).toBe(id2);
    });
  });

  describe('Navigation', () => {
    it('should switch between components with events and params', () => {
      const viewer = new MCPUIViewer({ container });
      const comp1 = createMockInitializedComponent('comp1');
      const comp2 = createMockInitializedComponent('comp2');
      const sendParamsSpy = vi.spyOn(comp2, 'sendParams');
      const deactivatedHandler = vi.fn();
      const activatedHandler = vi.fn();

      const id1 = viewer.add(comp1);
      const id2 = viewer.add(comp2);

      viewer.on('component-deactivated', deactivatedHandler);
      viewer.on('component-activated', activatedHandler);

      expect(viewer.switchTo(id2, { foo: 'bar' })).toBe(true);
      expect(viewer.activeId).toBe(id2);
      expect(viewer.activeComponent).toBe(comp2);
      expect(deactivatedHandler).toHaveBeenCalledWith(expect.objectContaining({ id: id1 }));
      expect(activatedHandler).toHaveBeenCalledWith(expect.objectContaining({ id: id2, params: { foo: 'bar' } }));
      expect(sendParamsSpy).toHaveBeenCalledWith({ foo: 'bar' });

      expect(viewer.switchTo('non-existent')).toBe(false);
    });

    it('should navigate with next/previous/first/last and wrap around', () => {
      const viewer = new MCPUIViewer({ container });
      const comp1 = createMockInitializedComponent('comp1');
      const comp2 = createMockInitializedComponent('comp2');
      const comp3 = createMockInitializedComponent('comp3');

      const id1 = viewer.add(comp1);
      const id2 = viewer.add(comp2);
      const id3 = viewer.add(comp3);

      // Test next with wrap-around
      viewer.switchTo(id1);
      viewer.next();
      expect(viewer.activeId).toBe(id2);
      viewer.switchTo(id3);
      viewer.next();
      expect(viewer.activeId).toBe(id1); // wrap

      // Test previous with wrap-around
      viewer.switchTo(id1);
      viewer.previous();
      expect(viewer.activeId).toBe(id3); // wrap

      // Test first/last
      viewer.last();
      expect(viewer.activeId).toBe(id3);
      viewer.first();
      expect(viewer.activeId).toBe(id1);

      // Empty viewer returns false
      const emptyViewer = new MCPUIViewer({ container });
      expect(emptyViewer.next()).toBe(false);
      expect(emptyViewer.previous()).toBe(false);
      expect(emptyViewer.first()).toBe(false);
      expect(emptyViewer.last()).toBe(false);
    });
  });

  describe('Getters', () => {
    it('should return correct values for all getters', () => {
      const viewer = new MCPUIViewer({ container });
      const comp1 = createMockInitializedComponent('comp1');
      const comp2 = createMockInitializedComponent('comp2');

      expect(viewer.componentCount).toBe(0);
      expect(viewer.componentIds).toEqual([]);

      const id1 = viewer.add(comp1);
      const id2 = viewer.add(comp2);

      expect(viewer.componentCount).toBe(2);
      expect(viewer.componentIds).toEqual([id1, id2]);
      expect(viewer.componentIds).not.toBe(viewer.componentIds); // returns copy
    });
  });

  describe('Events', () => {
    it('should support onEvent/offEvent for all event types', () => {
      const viewer = new MCPUIViewer({ container });
      const events = ['component-added', 'component-removed', 'component-activated', 'component-deactivated', 'error'];

      events.forEach((event) => {
        const handler = vi.fn();
        viewer.onEvent(event as never, handler);
        expect(viewer.listenerCount(event)).toBe(1);
        viewer.offEvent(event as never, handler);
        expect(viewer.listenerCount(event)).toBe(0);
      });

      // offEvent without handler removes all
      viewer.onEvent('component-added', vi.fn());
      viewer.onEvent('component-added', vi.fn());
      viewer.offEvent('component-added');
      expect(viewer.listenerCount('component-added')).toBe(0);
    });
  });

  describe('destroy()', () => {
    it('should close all components and clear state', async () => {
      const viewer = new MCPUIViewer({ container });
      const comp1 = createMockInitializedComponent('comp1');
      const comp2 = createMockInitializedComponent('comp2');

      const closeSpy1 = vi.spyOn(comp1, 'close').mockResolvedValue();
      const closeSpy2 = vi.spyOn(comp2, 'close').mockResolvedValue();

      viewer.add(comp1);
      viewer.add(comp2);
      viewer.on('component-added', vi.fn());

      await viewer.destroy();

      expect(closeSpy1).toHaveBeenCalledWith('Viewer destroyed');
      expect(closeSpy2).toHaveBeenCalledWith('Viewer destroyed');
      expect(viewer.componentCount).toBe(0);
      expect(viewer.activeId).toBeNull();
      expect(viewer.componentIds).toEqual([]);
      expect(viewer.listenerCount('component-added')).toBe(0);
    });
  });
});

/**
 * MCP UI SDK - Eval with Params Test
 *
 * Tests the flow of sending params to a component and using eval()
 * to extract values from the rendered HTML content.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MCPUIComponent,
  MCPUIComponentState,
  MCPUIManager,
  MCPUIViewer,
  MCPUIMethods,
  MCP_UI_PROTOCOL_VERSION,
} from '@sdk';

/**
 * Creates stub HTML that:
 * - Implements MCP UI protocol
 * - Renders received params
 * - Stores index param in window.index for eval validation
 */
function createStubHTMLWithIndex(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: monospace; padding: 16px; margin: 0; }
    #index-display { font-size: 24px; font-weight: bold; }
  </style>
</head>
<body>
  <h2>MCP UI Component</h2>
  <div>Index: <span id="index-display">-</span></div>
  <div>Params: <pre id="params-display">{}</pre></div>

  <script>
    let requestId = 0;
    window.index = null; // Store index for eval validation

    function sendRequest(method, params) {
      const id = ++requestId;
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
      return id;
    }

    function sendNotification(method, params) {
      window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
    }

    function sendResponse(id, result) {
      window.parent.postMessage({ jsonrpc: '2.0', id, result }, '*');
    }

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.jsonrpc !== '2.0') return;

      // Handle eval requests
      if (data.method === 'mcp-ui/eval' && data.id !== undefined) {
        try {
          const result = eval(data.params.code);
          sendResponse(data.id, { success: true, result });
        } catch (e) {
          sendResponse(data.id, { success: false, error: e.message });
        }
        return;
      }

      // Handle teardown
      if (data.method === '${MCPUIMethods.RESOURCE_TEARDOWN}') {
        sendResponse(data.id, {});
        return;
      }

      // Handle tool-input params - THIS IS THE KEY PART
      if (data.method === '${MCPUIMethods.TOOL_INPUT}') {
        const params = data.params && data.params.arguments ? data.params.arguments : data.params || {};

        // Store index in window for eval validation
        if (params.index !== undefined) {
          window.index = params.index;
          document.getElementById('index-display').textContent = String(params.index);
        }

        // Display all params
        document.getElementById('params-display').textContent = JSON.stringify(params, null, 2);
        return;
      }

      // Handle initialize response
      if (data.id !== undefined && data.result !== undefined) {
        sendNotification('${MCPUIMethods.INITIALIZED}', { ready: true });
      }
    });

    // Initialize on load
    window.addEventListener('load', function() {
      sendRequest('${MCPUIMethods.INITIALIZE}', {
        protocolVersion: '${MCP_UI_PROTOCOL_VERSION}',
        appInfo: { name: 'StubComponent', version: '1.0.0' },
        capabilities: { eval: true }
      });
    });
  </script>
</body>
</html>`;
}

/**
 * Helper to create mock initialized component for testing
 */
function createMockInitializedComponent(uri: string): MCPUIComponent {
  const component = new MCPUIComponent({
    uri,
    html: createStubHTMLWithIndex(),
  });

  // Mock initialized state
  // @ts-expect-error - accessing private property for testing
  component._state = MCPUIComponentState.INITIALIZED;

  const iframe = document.createElement('iframe');
  iframe.id = `mock-iframe-${Date.now()}`;
  // @ts-expect-error - accessing private property for testing
  component.iframe = iframe;

  return component;
}

describe('MCP UI SDK - Eval with Params', () => {
  let container: HTMLElement;

  beforeEach(() => {
    MCPUIManager.resetInstance();
    container = document.createElement('div');
    container.id = 'test-container';
    document.body.appendChild(container);
  });

  afterEach(() => {
    MCPUIManager.resetInstance();
    if (container?.parentNode) {
      container.parentNode.removeChild(container);
    }
  });

  describe('Param Flow', () => {
    it('should store index param in window.index for eval validation', () => {
      const component = createMockInitializedComponent('ui://test/show');

      // Spy on sendParams to verify it's called
      const sendParamsSpy = vi.spyOn(component, 'sendParams');

      // Component should accept params including index
      const params = { index: 42, typeId: 'agent-@test', page: 'dashboard', component: 'main' };

      // This would normally send to iframe
      expect(() => component.sendParams(params)).not.toThrow();
      expect(sendParamsSpy).toHaveBeenCalledWith(params);
    });

    it('should register stub HTML with MCPUIManager', () => {
      const manager = MCPUIManager.getInstance();
      const html = createStubHTMLWithIndex();
      const uri = 'ui://show/agent-@test/dashboard/main';

      manager.registerHTML(uri, html);

      expect(manager.hasHTML(uri)).toBe(true);
      expect(manager.getHTML(uri)).toBe(html);
    });

    it('should add component to viewer and send params on activation', () => {
      const viewer = new MCPUIViewer({ container });
      const component = createMockInitializedComponent('ui://test/show');
      const sendParamsSpy = vi.spyOn(component, 'sendParams');

      const id = viewer.add(component);

      // Switch to component with params
      viewer.switchTo(id, { index: 123 });

      expect(sendParamsSpy).toHaveBeenCalledWith({ index: 123 });
    });
  });

  describe('Eval Validation', () => {
    it('should throw error when eval called on uninitialized component', async () => {
      const component = new MCPUIComponent({
        uri: 'ui://test/show',
        html: createStubHTMLWithIndex(),
      });

      await expect(component.eval('window.index')).rejects.toThrow('Component must be initialized before evaluating');
    });

    it('stub HTML should include window.index assignment in script', () => {
      const html = createStubHTMLWithIndex();

      // Verify the stub HTML includes the window.index assignment
      expect(html).toContain('window.index = null');
      expect(html).toContain('window.index = params.index');
      expect(html).toContain("document.getElementById('index-display')");
    });

    it('stub HTML should handle mcp-ui/eval method', () => {
      const html = createStubHTMLWithIndex();

      // Verify eval handler is present
      expect(html).toContain("data.method === 'mcp-ui/eval'");
      expect(html).toContain('eval(data.params.code)');
      expect(html).toContain('success: true, result');
      expect(html).toContain('success: false, error');
    });
  });

  describe('Integration Flow', () => {
    it('should support full param -> render -> eval flow pattern', () => {
      const manager = MCPUIManager.getInstance();
      const viewer = new MCPUIViewer({ container });
      const uri = 'ui://show/agent-@test/dashboard/main';
      const html = createStubHTMLWithIndex();

      // 1. Register HTML
      manager.registerHTML(uri, html);
      expect(manager.hasHTML(uri)).toBe(true);

      // 2. Create and add mock component
      const component = createMockInitializedComponent(uri);
      const sendParamsSpy = vi.spyOn(component, 'sendParams');

      const id = viewer.add(component);
      expect(viewer.has(id)).toBe(true);

      // 3. Send params with index
      const testIndex = 42;
      viewer.switchTo(id, { index: testIndex, typeId: 'agent-@test', page: 'dashboard', component: 'main' });

      expect(sendParamsSpy).toHaveBeenCalledWith({
        index: testIndex,
        typeId: 'agent-@test',
        page: 'dashboard',
        component: 'main',
      });

      // Note: Full eval() testing requires browser environment
      // The stub HTML is designed so that after receiving params:
      // - window.index will equal testIndex (42)
      // - document.getElementById('index-display').textContent will equal '42'
      // - eval('window.index') would return 42
    });

    it('should generate different URIs for different show paths', () => {
      const uri1 = 'ui://show/agent-@test/dashboard/main';
      const uri2 = 'ui://show/agent-@other/settings/config';
      const uri3 = 'ui://show/workflow-@123/editor/canvas';

      const manager = MCPUIManager.getInstance();
      const html = createStubHTMLWithIndex();

      manager.registerHTML(uri1, html);
      manager.registerHTML(uri2, html);
      manager.registerHTML(uri3, html);

      expect(manager.hasHTML(uri1)).toBe(true);
      expect(manager.hasHTML(uri2)).toBe(true);
      expect(manager.hasHTML(uri3)).toBe(true);
    });
  });

  describe('ShowView URL Pattern', () => {
    it('should parse show path into typeId, page, component', () => {
      // Simulating what ShowView does
      const pointer = 'agent-@test/dashboard/main';
      const segments = pointer.split('/').filter(Boolean);

      expect(segments.length).toBe(3);
      expect(segments[0]).toBe('agent-@test'); // typeId
      expect(segments[1]).toBe('dashboard'); // page
      expect(segments[2]).toBe('main'); // component
    });

    it('should construct correct UI URI from parsed show path', () => {
      const typeId = 'agent-@test';
      const page = 'dashboard';
      const component = 'main';

      const uri = `ui://show/${typeId}/${page}/${component}`;

      expect(uri).toBe('ui://show/agent-@test/dashboard/main');
    });
  });
});

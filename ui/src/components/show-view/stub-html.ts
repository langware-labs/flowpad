/**
 * Stub HTML Generator for ShowView MCP UI Component
 *
 * Generates HTML that implements the MCP UI protocol handshake and displays
 * received params (typeId, page, component) within a sandboxed iframe.
 */

import { MCPUIMethods, MCP_UI_PROTOCOL_VERSION } from '@sdk';

/**
 * Generate stub HTML for ShowView component
 *
 * The generated HTML:
 * - Implements MCP UI protocol handshake
 * - Displays received params (typeId, page, component)
 * - Supports `mcp-ui/eval` for testing
 * - Stores index param in window.index for eval validation
 *
 * @param typeId - The type ID from the URL
 * @param page - The page name from the URL
 * @param component - The component name from the URL
 * @returns HTML string for the stub component
 */
export function generateStubHTML(typeId: string, page: string, component: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      padding: 16px;
      margin: 0;
      background: #f5f5f5;
      color: #333;
    }
    h2 {
      margin-top: 0;
      color: #1a1a1a;
      font-size: 1.25rem;
    }
    h3 {
      font-size: 1rem;
      color: #555;
      margin-top: 1.5rem;
      margin-bottom: 0.5rem;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      max-width: 400px;
    }
    td {
      padding: 8px 12px;
      border: 1px solid #ddd;
    }
    .label {
      background: #e8e8e8;
      font-weight: 600;
      width: 100px;
    }
    .value {
      background: white;
      font-family: monospace;
    }
    #params {
      margin-top: 8px;
      white-space: pre-wrap;
      background: #fff;
      padding: 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.875rem;
      max-height: 300px;
      overflow: auto;
    }
    .status {
      font-size: 0.75rem;
      color: #666;
      margin-top: 1rem;
    }
    .status.ready {
      color: #22c55e;
    }
    .status.waiting {
      color: #eab308;
    }
  </style>
</head>
<body>
  <h2>MCP UI Component</h2>
  <table>
    <tr><td class="label">TypeId</td><td class="value" id="typeId">${escapeHtml(typeId)}</td></tr>
    <tr><td class="label">Page</td><td class="value" id="page">${escapeHtml(page)}</td></tr>
    <tr><td class="label">Component</td><td class="value" id="component">${escapeHtml(component)}</td></tr>
  </table>
  <h3>Received Params</h3>
  <div id="params">Waiting for params...</div>
  <div id="status" class="status waiting">Initializing...</div>

  <script>
    (function() {
      let requestId = 0;
      window.index = null; // Store index for eval validation

      // Send JSON-RPC request to host
      function sendRequest(method, params) {
        const id = ++requestId;
        window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
        return id;
      }

      // Send JSON-RPC notification to host
      function sendNotification(method, params) {
        window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
      }

      // Send JSON-RPC response to host
      function sendResponse(id, result) {
        window.parent.postMessage({ jsonrpc: '2.0', id, result }, '*');
      }

      // Update status display
      function setStatus(text, ready) {
        const el = document.getElementById('status');
        el.textContent = text;
        el.className = 'status ' + (ready ? 'ready' : 'waiting');
      }

      // Handle messages from host
      window.addEventListener('message', function(event) {
        const data = event.data;
        if (!data || data.jsonrpc !== '2.0') return;

        // Handle requests from host
        if (data.method && data.id !== undefined) {
          if (data.method === 'mcp-ui/eval') {
            try {
              const result = eval(data.params.code);
              sendResponse(data.id, { success: true, result: result });
            } catch (e) {
              sendResponse(data.id, { success: false, error: e.message });
            }
            return;
          }

          if (data.method === '${MCPUIMethods.RESOURCE_TEARDOWN}') {
            sendResponse(data.id, {});
            return;
          }
        }

        // Handle notifications from host
        if (data.method && data.id === undefined) {
          if (data.method === '${MCPUIMethods.TOOL_INPUT}') {
            const params = data.params && data.params.arguments ? data.params.arguments : data.params || {};

            // Store index in window for eval validation
            if (params.index !== undefined) {
              window.index = params.index;
            }

            // Update display
            document.getElementById('params').textContent = JSON.stringify(params, null, 2);
            setStatus('Ready - params received', true);
            return;
          }

          if (data.method === '${MCPUIMethods.HOST_CONTEXT_CHANGED}') {
            // Handle host context changes (theme, etc)
            return;
          }
        }

        // Handle responses to our initialize request
        if (data.id !== undefined && data.result !== undefined) {
          // Initialize response received, send initialized notification
          sendNotification('${MCPUIMethods.INITIALIZED}', { ready: true });
          setStatus('Initialized - waiting for params...', false);
        }
      });

      // Initialize handshake on load
      window.addEventListener('load', function() {
        sendRequest('${MCPUIMethods.INITIALIZE}', {
          protocolVersion: '${MCP_UI_PROTOCOL_VERSION}',
          appInfo: { name: 'ShowView', version: '1.0.0' },
          capabilities: { eval: true }
        });
      });
    })();
  </script>
</body>
</html>`;
}

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

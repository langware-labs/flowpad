import { MCPUIMethods, MCP_UI_PROTOCOL_VERSION } from '@sdk';

export function generateMemoPanelHTML(apiUrl: string): string {
  // Derive WS URL from apiUrl
  const wsUrl = apiUrl.replace(/^http/, 'ws') + '/api/v1/connect/ws';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 0; background: #fafafa; color: #1a1a1a; }
    #root { padding: 16px; }
    h3 { margin: 0 0 12px; font-size: 1rem; font-weight: 600; }
    .create-row { display: flex; gap: 8px; margin-bottom: 12px; }
    .create-row input { flex: 1; padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem; outline: none; }
    .create-row input:focus { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.15); }
    .create-row button { padding: 6px 14px; background: #6366f1; color: white; border: none; border-radius: 6px; font-size: 0.875rem; cursor: pointer; }
    .create-row button:hover { background: #4f46e5; }
    .memo-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; margin-bottom: 4px; background: white; border: 1px solid #e5e7eb; border-radius: 6px; }
    .memo-title { flex: 1; font-size: 0.875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .delete-btn { padding: 2px 8px; background: transparent; border: 1px solid #e5e7eb; border-radius: 4px; cursor: pointer; color: #6b7280; font-size: 0.75rem; }
    .delete-btn:hover { background: #fee2e2; border-color: #fca5a5; color: #dc2626; }
    .empty { color: #9ca3af; font-size: 0.875rem; text-align: center; padding: 24px 0; }
    .status-bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 4px 12px; font-size: 0.7rem; color: #9ca3af; background: #fafafa; border-top: 1px solid #f3f4f6; }
  </style>
</head>
<body>
  <div id="root"></div>
  <div id="status-bar" class="status-bar">Initializing...</div>

  <script>
    (function() {
      var API_URL = "${apiUrl}";
      var WS_URL = "${wsUrl}";
      var MCPUIMethods = {
        INITIALIZE: '${MCPUIMethods.INITIALIZE}',
        INITIALIZED: '${MCPUIMethods.INITIALIZED}',
        RESOURCE_TEARDOWN: '${MCPUIMethods.RESOURCE_TEARDOWN}'
      };
      var MCP_UI_PROTOCOL_VERSION = '${MCP_UI_PROTOCOL_VERSION}';

      // --- DOM helpers ---
      function setStatus(text) {
        var el = document.getElementById("status-bar");
        if (el) el.textContent = text;
      }

      function renderMemos(memos) {
        var list = document.getElementById("memo-list");
        if (!list) return;
        if (memos.length === 0) {
          list.innerHTML = '<div class="empty" data-testid="iframe-empty">No memos yet</div>';
          return;
        }
        list.innerHTML = memos.map(function(m) {
          return '<div class="memo-item" data-testid="iframe-memo-item" data-id="' + m.id + '">' +
            '<span class="memo-title">' + (m.title || m.id).replace(/</g, "&lt;") + '</span>' +
            '<button class="delete-btn" data-testid="iframe-delete-btn" data-id="' + m.id + '">\u00d7</button>' +
            '</div>';
        }).join('');
        list.querySelectorAll('.delete-btn').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var id = btn.getAttribute('data-id');
            deleteMemo(id).then(function() { refresh(); });
          });
        });
      }

      // --- REST helpers ---
      function fetchMemos() {
        return fetch(API_URL + "/api/v1/graph/memo")
          .then(function(r) { return r.json(); })
          .then(function(json) { return Array.isArray(json.data) ? json.data : []; })
          .catch(function() { return []; });
      }

      function createMemo(title) {
        return fetch(API_URL + "/api/v1/graph/memo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title, memo_type: "note", status: "open" })
        }).then(function(r) { return r.json(); });
      }

      function deleteMemo(id) {
        return fetch(API_URL + "/api/v1/graph/memo/" + id, { method: "DELETE" });
      }

      function refresh() {
        fetchMemos().then(renderMemos);
      }

      // --- MCP protocol ---
      var requestId = 0;
      function postToHost(msg) { window.parent.postMessage(msg, "*"); }
      function sendRequest(method, params) {
        var id = ++requestId;
        postToHost({ jsonrpc: "2.0", id: id, method: method, params: params });
        return id;
      }
      function sendNotification(method, params) {
        postToHost({ jsonrpc: "2.0", method: method, params: params });
      }

      // --- WebSocket for reactivity ---
      var initialized = false;
      function initApp() {
        if (initialized) return;
        initialized = true;
        setStatus("Connecting...");

        try {
          var wsId = "memo-panel-" + Date.now();
          var ws = new WebSocket(WS_URL + "/" + wsId);
          ws.onopen = function() { setStatus("Connected"); };
          ws.onmessage = function(evt) {
            try {
              var msg = JSON.parse(evt.data);
              if (msg && msg.type === "data_op_msg") { refresh(); }
            } catch(e) {}
          };
          ws.onerror = function() { setStatus("WS error"); };
          ws.onclose = function() { setStatus("WS closed"); };
        } catch(e) {
          setStatus("WS error: " + e.message);
        }

        refresh();
      }

      // --- MCP handshake ---
      window.addEventListener("message", function(event) {
        var d = event.data;
        if (!d || d.jsonrpc !== "2.0") return;
        if (d.method === MCPUIMethods.RESOURCE_TEARDOWN) {
          postToHost({ jsonrpc: "2.0", id: d.id, result: {} });
          return;
        }
        if (d.result !== undefined && d.id !== undefined) {
          sendNotification(MCPUIMethods.INITIALIZED, { ready: true });
          initApp();
        }
      });

      window.addEventListener("load", function() {
        // Build the UI
        var root = document.getElementById("root");
        root.innerHTML =
          '<h3>Memos</h3>' +
          '<div class="create-row">' +
            '<input id="new-title" data-testid="iframe-memo-input" placeholder="New memo title..." />' +
            '<button id="add-btn" data-testid="iframe-create-btn">Add</button>' +
          '</div>' +
          '<div id="memo-list"></div>';

        document.getElementById("add-btn").addEventListener("click", function() {
          var input = document.getElementById("new-title");
          var title = input.value.trim();
          if (!title) return;
          input.disabled = true;
          document.getElementById("add-btn").textContent = "...";
          createMemo(title).then(function() {
            input.value = "";
            input.disabled = false;
            document.getElementById("add-btn").textContent = "Add";
            refresh();
          }).catch(function() {
            input.disabled = false;
            document.getElementById("add-btn").textContent = "Add";
          });
        });

        document.getElementById("new-title").addEventListener("keydown", function(e) {
          if (e.key === "Enter") document.getElementById("add-btn").click();
        });

        // Start MCP handshake
        sendRequest(MCPUIMethods.INITIALIZE, {
          protocolVersion: MCP_UI_PROTOCOL_VERSION,
          appInfo: { name: "MemoPanelApp", version: "1.0.0" },
          capabilities: { tools: false, resources: false, messages: false }
        });
      });
    })();
  </script>
</body>
</html>`;
}

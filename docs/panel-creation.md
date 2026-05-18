---
id: 683b136e-3d8a-51e4-917a-625c15e280eb
---

# Creating Standalone Panels with the FlowPad SDK

A **panel** is a self-contained HTML file that can live anywhere on your machine. It loads the FlowPad SDK via a single `<script>` tag from the local backend and gets real-time reactivity through WebSocket — no build step, no framework, no bundler required on the panel side.

---

## Architecture

```
examples/memo-panel.html                  Backend (localhost:9007)
  (anywhere on disk, file:// or http://)        │
                                                 │
  <script src=".../sdk/flowpad-sdk.js"> ───────► serves flowpad-sdk.js
                                                 │   (IIFE, ~2.4MB, window.FlowpadSdk)
  window.FlowpadSdk.connectionManager            │
    .connect()  ─────────────────────── WS ────► /api/v1/connect/ws/{clientId}
    .on('on_data_op', refresh)  ◄────── WS ───── broadcasts on any entity change
                                                 │
  fetch('http://localhost:9007/api/v1/graph/memo')► REST CRUD
  fetch('http://localhost:9007/api/v1/graph/annotation')
```

### Why this works across origins

- **Script tags bypass CORS.** Browsers load `<script src="cross-origin-url">` freely — no `Access-Control-Allow-Origin` needed to load the SDK.
- **REST and WS calls are cross-origin fetch/WebSocket**, which do go through CORS. The backend explicitly allows `http://localhost:*`, `127.0.0.1:*`, and `null` (for `file://` panels).
- **`file://` sends `Origin: null`.** When you open a panel directly from disk, the browser sends `Origin: null`. The backend's CORS config includes `"null"` in `allow_origins`.

### SDK bundle build chain

```
ts_sdk/src/index.ts
  └─ Vite (ui/vite.iife.config.ts)
       format: 'iife', name: 'FlowpadSdk'
       aliases: axios→browser, uuid→cjs-browser, events→browser polyfill
       custom Rollup plugin: resolves bare imports from ui/node_modules
                             (ts_sdk has no node_modules of its own)
  └─► flow_sdk/server/static/sdk/flowpad-sdk.js
         served at /sdk/flowpad-sdk.js via FastAPI StaticFiles
```

### Entity types and field mapping

The main app creates two distinct entity types:

| Action in main app | Entity type | Text field |
|--------------------|-------------|------------|
| Add memo (MemoColumn) | `memo` | `title` |
| Add comment (annotation button) | `annotation` | `content` |

Both types live at separate endpoints (`/api/v1/graph/memo`, `/api/v1/graph/annotation`). A panel that only queries one type will miss the other. The memo panel fetches both and renders `m.content \|\| m.title \|\| m.id`.

### WebSocket reactivity

- `on_data_op` fires on **any** entity create/update/delete across the entire backend — not filtered by type.
- **CREATE** broadcasts to **all** connected WS clients.
- **UPDATE/DELETE** only notifies entity watchers (clients that called `watchQuery` for that type).
- For a panel using raw REST (not `dataManager.watchQuery`), `on_data_op` is the right hook — just re-fetch everything on each event.

---

## Prerequisites

1. Backend running on port 9007:
   ```bash
   python -m flow_sdk.server.run
   ```

2. SDK built and deployed:
   ```bash
   cd ui && npm run build:sdk
   ```
   Writes `flow_sdk/server/static/sdk/flowpad-sdk.js`. The backend serves it immediately — no restart needed.

---

## Panel Anatomy

```html
<!DOCTYPE html>
<html>
<head>
  <style>/* your styles */</style>
</head>
<body>
  <!-- 1. Load the SDK via script tag (CORS-exempt) -->
  <script src="http://localhost:9007/sdk/flowpad-sdk.js"></script>

  <script>
    (function () {
      // 2. Guard: SDK only loads if backend is up
      if (typeof window.FlowpadSdk === 'undefined') {
        showError('SDK failed to load — is the backend running on :9007?');
        return;
      }

      var connectionManager = window.FlowpadSdk.connectionManager;

      // 3. Register WS listeners BEFORE calling connect()
      //    (events fire immediately on open; registering after may miss them)
      connectionManager.on('on_open', function () {
        setStatus('Connected', 'connected');
        refresh();
      });

      connectionManager.on('on_close', function () {
        setStatus('Disconnected — retrying…', 'error');
      });

      connectionManager.on('on_reconnect_failed', function () {
        setStatus('Connection error — polling', 'error');
        refresh(); // still show last-known data
      });

      connectionManager.on('on_data_op', function () {
        refresh(); // any entity changed anywhere — re-fetch
      });

      // 4. Connect or reuse existing singleton connection
      //    ConnectionManager is a singleton across all script contexts.
      //    If something else already connected it, on_open already fired.
      if (connectionManager.connected) {
        setStatus('Connected', 'connected');
        refresh();
      } else {
        connectionManager.connect();
      }

      function apiFetch(path, opts) {
        return fetch('http://localhost:9007' + path, opts)
          .then(function (r) { return r.json(); });
      }

      function refresh() {
        apiFetch('/api/v1/graph/memo')
          .then(function (j) { render(Array.isArray(j.data) ? j.data : []); });
      }
    })();
  </script>
</body>
</html>
```

---

## SDK Global Reference (`window.FlowpadSdk`)

| Property | Description |
|----------|-------------|
| `connectionManager` | Singleton WebSocket manager |
| `connectionManager.connected` | `true` if already connected |
| `dataManager` | Higher-level entity manager (watchQuery, create, delete) |

### ConnectionManager Events

| Event | Fires when |
|-------|-----------|
| `on_open` | WebSocket connected (or reconnected) |
| `on_close` | WebSocket disconnected |
| `on_reconnect_failed` | All reconnect attempts failed |
| `on_data_op` | Any entity created, updated, or deleted |

> **Common mistake:** using wrong event names. The events are `on_open`, `on_close`, `on_data_op` — **not** `connected`, `disconnected`, or `data_op_msg`. Those names come from the raw WS message format and are not emitted by `connectionManager`.

---

## REST API

All responses: `{ status: "OK"|"FAIL", data: ..., message: string }`.

| Method | Path | Body |
|--------|------|------|
| `GET` | `/api/v1/graph/{type}` | — |
| `POST` | `/api/v1/graph/{type}` | entity fields |
| `PUT` | `/api/v1/graph/{type}/{id}` | updated fields |
| `DELETE` | `/api/v1/graph/{type}/{id}` | — |

---

## Opening a Panel

```bash
# From disk (file:// origin — null-origin CORS allowed)
open examples/memo-panel.html

# Via local HTTP server (cleaner origin)
python3 -m http.server 8765 --directory examples
# → http://localhost:8765/memo-panel.html
```

---

## Rebuilding the SDK

The SDK bundle is not committed to git. Rebuild whenever `ts_sdk/` changes:

```bash
cd ui && npm run build:sdk
```

---

## Debugging Guide

### SDK fails to load (`window.FlowpadSdk` is undefined)

- Check backend is running: `curl http://localhost:9007/sdk/flowpad-sdk.js | head -3`
- Check the file exists: `ls flow_sdk/server/static/sdk/flowpad-sdk.js`
- If missing, run `cd ui && npm run build:sdk`

### Status stuck at "Connecting…" / `on_open` never fires

- `connectionManager` is a singleton. If something else connected it before your script ran, `on_open` already fired and will not fire again.
- Fix: check `connectionManager.connected` at startup and handle the already-connected case explicitly (see Panel Anatomy above).

### Panel shows data but doesn't react to changes in the main app

1. Open browser DevTools → Network → WS tab. Confirm the panel has an active WebSocket connection.
2. Check which entity type the main app is creating. "Add comment" creates `annotation`, not `memo`. If your panel only queries `/api/v1/graph/memo`, it will never see annotations.
3. Confirm `on_data_op` is firing: add `connectionManager.on('on_data_op', function() { console.log('data_op'); })` and watch the console while mutating data in the main app.
4. If `on_data_op` fires but the re-fetch returns stale data, it may be a race — add a short delay before fetching, or retry once.

### DELETE fails or hits the wrong endpoint

Each entity type has its own endpoint. Deleting a `memo` at `/api/v1/graph/annotation/{id}` returns 404. Store `data-type` on each rendered element and route accordingly:

```js
function deleteMemo(id, type) {
  var endpoint = type === 'annotation'
    ? '/api/v1/graph/annotation/'
    : '/api/v1/graph/memo/';
  return apiFetch(endpoint + id, { method: 'DELETE' });
}
```

### CORS errors on REST/WS calls

- `file://` panels send `Origin: null`. The backend must include `"null"` in `allow_origins` (see `flow_sdk/server/flow_server.py`).
- If the panel is served from `http://localhost:XXXX`, that origin must match the backend's `allow_origin_regex` (`^https?://(localhost|127\.0\.0\.1)(:\d+)?$`).
- Script tag loads (`<script src="...">`) are never blocked by CORS — only `fetch` and `WebSocket` calls are.

---

## MCP Apps (Embedded SPAs)

An **MCP app** is a pre-built SPA (React, Vue, vanilla) stored inside an entity's record folder and served directly via the graph action URL. Unlike standalone panels, MCP apps are scoped to a specific entity and receive its context automatically via a URL param.

### Folder structure

```
~/.flow/records/{type}/{type}-@{id}/
└── mcp_apps/
    └── {app_name}/
        └── dist/
            ├── index.html
            └── assets/
                ├── main.js
                └── main.css
```

Example for a `memo` entity with id `01JXXX`:
```
~/.flow/records/memo/memo-@01JXXX/mcp_apps/my-app/dist/index.html
```

### URL pattern

```
GET /api/v1/graph/{type}/{id}/mcp_app/{app_name}/{file_path?}
```

- **Static file**: if `file_path` is given and the file exists in `dist/`, it is served directly with the correct MIME type.
- **SPA fallback**: any other path (missing file, empty path) returns `dist/index.html` — so client-side routing works.
- **`?appContext`**: optional query param set by the caller. The MCP app reads it client-side:
  ```js
  const ctx = JSON.parse(new URLSearchParams(location.search).get('appContext') || '{}');
  // ctx = { entityId: "memo-01JXXX", entityType: "memo", appName: "my-app" }
  ```
  The backend does not inject or modify this param.

### Vite build requirement

MCP apps **must** be built with `base: './'` so asset paths are relative to the HTML file:

```ts
// vite.config.ts for your MCP app
export default {
  base: './',
  build: { outDir: 'dist' },
}
```

Without this, the browser will request `/assets/main.js` (absolute) instead of `./assets/main.js` (relative), and the asset will 404 because the serving path is deep inside the graph URL.

### `appContext` format

```json
{
  "entityId": "memo-01JXXX",
  "entityType": "memo",
  "appName": "my-app"
}
```

Pass it when constructing the URL:

```js
const ctx = JSON.stringify({ entityId: id, entityType: type, appName: 'my-app' });
const url = `/api/v1/graph/${type}/${id}/mcp_app/my-app/?appContext=${encodeURIComponent(ctx)}`;
```

### SDK usage

MCP apps can optionally use the FlowPad SDK exactly like standalone panels — reference it by absolute URL:

```html
<script src="http://localhost:9007/sdk/flowpad-sdk.js"></script>
```

Since MCP apps are served from the same origin as the API (`localhost:9007`), CORS is never an issue for REST or WebSocket calls.

### Quick test (manual)

```bash
# 1. Find or create a memo entity and note its id (e.g. memo-@01JXXX)
# 2. Create the dist folder
mkdir -p ~/.flow/records/memo/memo-@01JXXX/mcp_apps/demo/dist

# 3. Drop in a minimal index.html
echo '<h1>Hello from MCP app</h1>' > ~/.flow/records/memo/memo-@01JXXX/mcp_apps/demo/dist/index.html

# 4. Fetch via the graph action
curl http://localhost:9007/api/v1/graph/memo/memo-@01JXXX/mcp_app/demo/
# → <h1>Hello from MCP app</h1>
```

---

### SDK build fails

Common causes:

| Error | Cause | Fix |
|-------|-------|-----|
| `Cannot read properties of undefined (reading 'prototype')` from `follow-redirects` | Vite picked up Node build of axios | Alias `axios` → `node_modules/axios/dist/browser/axios.cjs` in `vite.iife.config.ts` |
| `randomFillSync` / `crypto` not defined | Node build of `uuid` bundled | Alias `uuid` → `node_modules/uuid/dist/cjs-browser/index.js` |
| Package not found during build | `ts_sdk` has no `node_modules`; Vite can't resolve bare imports | Custom `resolveId` Rollup plugin in `vite.iife.config.ts` resolves from `ui/node_modules` |

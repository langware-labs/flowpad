---
id: 302b626f-a2cf-597b-9e12-575ac5ea79a6
---

# Frontend Debug Cheatsheet

Open DevTools → Console tab. Everything below runs in the browser console against a live app at `localhost:4097`.

---

## 0 — First thing to run

```js
window.all   // lists every registered debug global
```

Current registered globals:
`store`, `context` / `ctx`, `connection_manager`, `connection`, `auth`,
`project`, `workspace`, `computeNode`, `flow`, `sniffer`, `shell`, `claudeSessionManager`

---

## 1 — Is the app healthy?

```js
// Bootstrap OK?
context.isBootstrapping    // should be false
context.bootstrapError     // should be null

// WebSocket live?
connection.readyState      // 1 = OPEN, 3 = CLOSED
connection_manager.reconnectAttempts
connection_manager.isReconnecting

// Entity cache loaded?
store.entities.map.size    // ~700 on a normal session
store.printStats()         // connection health + cache summary
```

If `bootstrapError` is set or `readyState !== 1`, all data and PTY bugs downstream are symptoms — fix the root first.

---

## 2 — Entity / data bugs

*"Entity not showing", "stale data", "wrong value in UI"*

```js
// Is the entity in the cache?
store.entities.map.has('task-<id>')
store.entities.map.get('memo-<id>')

// What entity types are cached right now?
new Set([...store.entities.map.keys()].map(k => k.split('-')[0]))

// Re-fetch from backend without page reload
await store.refreshByTypeId('task-<id>')

// What queries are being watched (React hooks subscriptions)?
store.watchQueryPrint()      // prints each watched query + its current results

// Run a one-off query in the console
await store.query({ type: 'memo' })
await store.query({ type: 'task', filter: { status: 'open' } })

// Force a full cache clear (nuclear option)
store.clearCache()
```

**Tip:** if a React hook seems to show stale data, check `store.watchQueryPrint()` — if the query result looks correct there but the UI is wrong, the bug is in how the component consumes the hook (likely a memo/selector issue), not in the data layer.

---

## 3 — PTY / terminal bugs

*"Terminal not connecting", "output not appearing", "replay broken", "seq mismatch"*

```js
// The active terminal's Shell entity (null when no terminal tab is active)
shell?.id; shell?.pty_pid       // shell id / backend PTY id
shell?.status                   // 'idle' | 'running' | 'closing' | 'closed' | 'error'
shell?.shellStatus              // 'Not connected' | 'Disconnected' | 'Restarting...' | ...
shell?.ptyStarted; shell?.attached; shell?.connected

// Its PtyConnection (one per Shell)
shell?.ptyConnection.lastSeq    // last PTY chunk seq number received (dedup)
shell?.ptyConnection.chunks.size  // number of buffered live chunks
shell?.printPty()               // dump the buffered output as text

// All shells on the compute node (frontend cache)
computeNode.getAllSessions()    // Shell[] sorted by created_at

// Send raw input to the PTY (for manual testing)
await shell?.sendInput('ls -la\n')
```

**Tip:** if `shell.ptyConnection.chunks.size` is growing but the terminal is blank, the PTY is receiving data but the xterm is not consuming it — the `InteractiveTerminal` connect handler runs on `shell.on('status', 'connected')` (check `terminalReady` state in React DevTools).

---

## 4 — Agentic process trace / prompt bugs

*"TraceGutter empty", "prompt index empty", "click-to-prompt does not scroll"*

```js
// Current process identity
context.agenticProcess?.id
context.agenticProcess?.session_id

// Left gutter source: per-process FlowData stream
context.agenticProcess?.flowDataStream?.items
await context.agenticProcess?.loadHistory({ force: true })

// Prompt index source: transcript/prompts action
await context.agenticProcess?.getPrompts()
```

**Tip:** TraceGutter reads `AgenticProcess.flowDataStream`; prompt index reads the special `transcript/prompts` action. Prompt annotations only provide row anchors for click-to-scroll.

---

## 5 — Hook / sniffer bugs

*"Sniffer not capturing", "hook events missing", "global sniffer panel empty"*

```js
// Is context aware of the sniffer? (there is no `sniffer` global)
context.snifferHook            // SnifferHook instance, or null
context.snifferHook?.entity.id // its AgentHook entity
await context.snifferHook?.entity.getTriggers()   // registered hook triggers

// Check what session the sniffer is listening to
context.activeShellId          // worker session id
```

**Tip:** the global sniffer panel and a terminal's TraceGutter are separate consumers. Hook events are broadcast to the global `@sniffer` hook and also routed to the matching `AgenticProcess.flowDataStream` when execution scope/session metadata identifies the process.

---

## 6 — WebSocket / streaming bugs

*"Data not updating in real time", "WS disconnect loop", "stream messages lost"*

```js
// Inspect the raw socket
connection.readyState          // 1 = OPEN
connection.url                 // should be ws://localhost:9007/api/v1/connect/ws/...

// Reconnect state
connection_manager.isReconnecting
connection_manager.reconnectAttempts
connection_manager.baseReconnectDelay

// Streaming action responses
store.streamingRequestsCount   // should drop to 0 after actions complete

// Subscriptions and watches
store.subscriptions            // { map, originalKeys }
store.watches                  // active entity watches
```

**Tip:** if `connection_manager.reconnectAttempts` keeps climbing, the socket never reaches `open` (it resets to 0 on a successful open) — check the backend is up and `connection.url` is right, then do a full page refresh.

---

## 7 — Context / navigation bugs

*"Wrong project loaded", "workspace not set", "entity not in context"*

```js
context.bootstrapInfo          // { user, project, workspace, compute_node, agent }
project.id; project.name
workspace.id; workspace.name
computeNode.id; computeNode.uname    // should be '@local'
context.activeShellId          // currently active terminal session
context.activeLabels           // active label filters

// Re-run bootstrap without refresh
await store.bootstrap()

// Check context entity slots
context.getContextEntityTypeId('workspace')
context.getContextEntity('workspace')
```

---

## 8 — Auth bugs

*"Token expired", "logout loop", "401s on API calls"*

```js
auth                           // AuthManager instance
// AuthManager exposes: init, login, logout, visit, refreshToken
// No token fields are exposed — check Network tab for Authorization headers
```

---

## 9 — Quick full-state snapshot

Paste this to get a one-shot health dump:

```js
console.table({
  bootstrapOK:        !context.bootstrapError && !context.isBootstrapping,
  wsState:            ['CONNECTING','OPEN','CLOSING','CLOSED'][connection?.readyState ?? 3],
  reconnectAttempts:  connection_manager.reconnectAttempts,
  entitiesCached:     store.entities.map.size,
  streamingRequests:  store.streamingRequestsCount,
  shellConnected:     shell?.connected ?? false,
  shellSessions:      computeNode?.getAllSessions().length,
  activeShellId:      context.activeShellId || '(none)',
  snifferActive:      !!context.snifferHook,
  project:            project?.name,
  workspace:          workspace?.name,
  computeNode:        computeNode?.uname,
})
```

---

## 10 — How to trace a bug end-to-end

Given a symptom, work **inward** from the UI:

```
Symptom (wrong UI)
  └─ Is the data correct in store.entities.map?
       ├─ YES → React hook/selector bug (check React DevTools)
       └─ NO → Is the watched query correct? (store.watchQueryPrint())
                  ├─ Query wrong → filter/expand bug in useEntitiesQuery call
                  └─ Query correct but result stale
                       ├─ WS disconnected? (connection.readyState)
                       └─ Entity not refreshed? (store.refreshByTypeId)
```

For PTY/terminal issues:

```
Terminal blank or frozen
  └─ shell (active Shell) not null and shell.connected?
       ├─ NO  → no active shell / attach never completed (check shell?.shellStatus,
       │         computeNode.getAllSessions())
       └─ YES → shell.ptyConnection.chunks.size growing?
                  ├─ NO  → PTY process dead (check shell.status, the backend log)
                  └─ YES → xterm not consuming (connect handler not run)
                              → check terminalReady in React DevTools
```

---

## File references

| Global | Defined at |
|--------|-----------|
| `store` | `ts_sdk/src/APIEntity.ts:1931` |
| `context` / `ctx` / `dataContext` | `ts_sdk/src/FlowSync/context.ts:1214-1216` |
| `connection_manager` | `ts_sdk/src/websocket.ts:858` |
| `connection` | `ts_sdk/src/FlowSync/context.ts:646` |
| `auth` | `ts_sdk/src/FlowSync/auth.ts:339` |
| `workspace`, `computeNode`, `project` | `ts_sdk/src/FlowSync/context.ts:822`, `:1132`, `:1142` |
| `shell` | `ts_sdk/src/FlowSync/context.ts:392` |
| `defineGlobal` implementation | `ts_sdk/src/utils/globals.ts:31` |

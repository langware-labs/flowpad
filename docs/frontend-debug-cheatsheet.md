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
// All live shell sessions (ShellManager level)
shell.getAllSessions()          // Map<id, ShellSession>
shell.initialSyncCompleted      // false = backend sync still running
shell.syncInProgress

// Inspect a specific session
const sess = shell.getSession('<sessionId>')
sess.lastSeqReceived            // last PTY chunk seq number received
sess.chunks.size                // number of buffered chunks
sess.pid                        // OS process ID
sess.cols; sess.rows            // terminal dimensions
sess.status                     // 'active' | 'closed' | ...

// Active node (compute node driving PTY)
shell.activeNode                // { id, uname: 'local' }

// ComputeNode-level sessions (agentic processes)
computeNode.getAllSessions()

// Send raw input to a PTY (for manual testing)
shell.sendPtyInput('<sessionId>', 'ls -la\n')
```

**Tip:** if `sess.chunks.size` is growing but terminal is blank, the PTY is receiving data but the xterm adapter is not attached — `PtySyncSession.initialize()` may not have been called yet (check `terminalReady` state in React DevTools).

---

## 4 — Claude session bugs

*"Session not starting", "fork not working", "kill not firing"*

```js
claudeSessionManager.startSession(agentId, processId, workerSessionId)
claudeSessionManager.resumeSession(sessionId)
claudeSessionManager.forkSession(sessionId)
claudeSessionManager.restartSession(sessionId)
claudeSessionManager.killSession(sessionId)
```

**Tip:** the `workerSessionId` is what the TraceGutter and sniffer filter on. If trace events aren't appearing, verify the `workerSessionId` passed to `useTraceGutter` matches an active session in `claudeSessionManager`.

---

## 5 — Hook / sniffer bugs

*"Sniffer not capturing", "hook events missing", "TraceGutter empty"*

```js
// Is the sniffer entity registered?
sniffer                        // null = not active (no terminal open with sniffer enabled)
sniffer?.id
sniffer?.getTriggers()         // registered hook triggers

// Is context aware of the sniffer?
context.snifferHook            // SnifferHook instance, or null

// Check what session the sniffer is listening to
context.activeShellId          // worker session id
```

**Tip:** `sniffer` is only set when `useHooksSniffer` mounts (i.e. a terminal panel is active). On the home page it will be `null`. Navigate to a terminal dock route before investigating sniffer bugs.

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
connection_manager.maxReconnectAttempts
connection_manager.baseReconnectDelay

// Active streams (streaming action responses)
store.streams                  // Map of open streams
store.streamingRequestsCount   // should drop to 0 after actions complete

// Subscriptions and watches
store.subscriptions            // { map, originalKeys }
store.watches                  // active entity watches
```

**Tip:** if `connection_manager.reconnectAttempts` keeps climbing, check `connection_manager.maxReconnectAttempts` — once exceeded the app stops retrying silently. Do a full page refresh to reset.

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
  shellSyncDone:      shell.initialSyncCompleted,
  shellSessions:      shell.getAllSessions().size,
  activeShellId:      context.activeShellId || '(none)',
  snifferActive:      !!sniffer,
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
  └─ shell.getAllSessions().size > 0?
       ├─ NO  → ShellManager didn't create session (check shell.syncInProgress)
       └─ YES → sess.chunks.size growing?
                  ├─ NO  → PTY process dead (check sess.pid via computeNode)
                  └─ YES → xterm not consuming (PtySyncSession.initialize not called)
                              → check terminalReady in React DevTools
```

---

## File references

| Global | Defined at |
|--------|-----------|
| `store` / `dataManager` | `ts_sdk/src/APIEntity.ts:834` |
| `context` / `ctx` | `ts_sdk/src/FlowSync/context.ts:918` |
| `connection_manager` | `ts_sdk/src/websocket.ts:479` |
| `connection` | `ts_sdk/src/FlowSync/context.ts:368` |
| `auth` | `ts_sdk/src/FlowSync/auth.ts:280` |
| `project`, `workspace`, `computeNode`, `flow` | `ts_sdk/src/FlowSync/context.ts:705-750` |
| `sniffer` | `ui/src/hooks/use-hooks-sniffer.ts:271` |
| `defineGlobal` implementation | `ts_sdk/src/utils/globals.ts:31` |

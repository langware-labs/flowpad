# flow-js — calls by use case

All names are `sdk.*` after `import * as sdk from '/sdk/flowpad-sdk.js'` and `await sdk.initSdk()`.

## Records (entities)

```js
const task = await new sdk.Task({ title: 'Ship it' }).save(projectTypeId);   // ALWAYS with the project scope
task.status = 'done'; await task.save();
const p = await sdk.dataManager.getByTypeId(new sdk.TypeId('agentic_process', id));
```

- `save()` with no scope lands outside every project — the user's lists never show it.
- Read a type's real fields with `flow schema info <type>` before inventing any.
- Common: `Task` (`title`, `status` to_do|in_progress|done, `description`, `due_at`, `assignee`), `Project`,
  `Markdown`, `Agent`, `AgenticProcess`, `ComputeOp`, `Trigger`.
- Query: `X.query(new sdk.QueryRequest({type, query: new sdk.QueryFilter({match: {...}, limit})}))` — paging goes
  inside `query`, and `limit`/`order_by` need a `match`.

## Live updates — never poll

```js
const unwatch = await sdk.dataManager.watchQuery(new sdk.QueryRequest({
  type: 'task', scope: [], name: 'my-app-tasks', callback: (rows) => render(rows) }));   // first page, then every change
const off = ds.onRowsChanged(({ op, keys }) => reload());                                 // dataset rows
```

`watchQuery` resolves to the unsubscribe function, not the rows. Render from the callback; never patch a local
copy after a write.

## Dataset rows

`const ds = (await sdk.Dataset.forKind(kind, projectId))[0]` → `ds.query({match, q, order_by, limit, expand})`
(`{rows, problems}`; paths carry the slot: `input.stage`), `ds.count`, `ds.row(key)`,
`ds.put(key, {input}, {expected: row.version})` (409 = changed meanwhile), `ds.append`, `ds.putMany`,
`ds.deleteRow`, `ds.onRowsChanged`. Find a dataset by kind, never by id. The full table, links, counts and
rules: the **data-management** skill, `modes/app.md`.

## Files

`sdk.fsManager.readIfExists(owner, path)`, `.listDirectory(owner, path)`, `.writeFile(owner, path, text)` — `owner`
is the TypeId of the project (or asset) whose files they are; `new sdk.FSRef(path, node).open()`
shows a file in Flowpad. Upload a file the person picked: `sdk.fsStore.getState().uploadFiles(nodeTypeId, absDir, [file])`. Never build `/api/v1/graph/project/<id>/fs/serve/…` and `fetch` it; if you must frame a
served file, its URL goes through `framed()` (SKILL.md §4).

## Processes and agents

| need | call |
|---|---|
| the agent process this page belongs to | MCP-UI: `(await sdk.htmlPage()).process` (a TypeId); page-aware: `__FLOWPAD_PROCESS_ID__` |
| tell the agent what the page shows | `await proc.setDisplayContext(state)` (replaces it; under 64 KB) |
| send the agent a message | `await proc.enqueue(text, 'page')` |
| open an agent's chat | `await agent.openChat(projectId)` → `AgenticProcess`, then `navigateHost({typeid})` |
| fork / open / close a session | `sdk.apiClient.post('/graph/agentic_process/<id>/fork', {visible})` → `{id}`; `…/<id>/open` `{instruction}`; `…/<id>/close` |
| show its terminal | `<iframe src="${framed('/win/shell/agentic_process-' + id)}">` |
| chat with a deployed agent | `sdk.AgentChat.forDeployment(...)`, `for await (const ev of chat.send(text))` |

A process relayed from another machine (`hub_route`) refuses fork/open from this one.

## Raw actions

`sdk.apiClient.get|post(path, body)` — path relative to `/api/v1`; resolves to the unwrapped `data`; a refusal
throws (read `e.response?.data?.message`, or `sdk.errorText(e)`). It sends the page-state key; `fetch` does not.

## Host and navigation

| need | call |
|---|---|
| this app / its project / the asset that contains it | `await sdk.resolveAppHost()` → `{app, subject}` |
| move the Flowpad tab | `sdk.navigateHost({typeid})` / `({address: '/dock/…'})` |
| an outside URL | `sdk.openExternal(url)` (http/https; opens in the person's browser) |
| talk to the parent | `sdk.postToHost({type, …})`, `sdk.onHostMessage(type, fn)` — no secrets in a host message |
| query options the dock passed | `sdk.appOption(name)` |

## Dev server

A Vite dev server proxies `/api` and `/sdk` to the backend, so the same imports work. Never replace the proxy with
a hard-coded backend URL. On a local Flowpad the dev page still needs `?state=` (open it from Flowpad).

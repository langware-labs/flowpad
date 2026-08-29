# Flowpad app template

An app that works with **Flowpad's own data**. It reads and writes the same
entities Flowpad does, so a task created here is *the* task — it appears in the
user's task view, on disk, and in every other window, with no syncing code.

Copy this folder, then edit `index.html` / `styles.css` / `app.js`. Do not
introduce a framework or a build step unless the user asks: the folder is
already its own build output, which is what lets Flowpad serve it as-is.

## Bootstrap

```bash
cp -R "<this skill's directory>/template-flowpad/." "<project root>/assets/apps/<app name>/"
cd "<project root>/assets/apps/<app name>"
# edit the three files, then:
flow app serve "<App Name>"
```

`flow app serve` registers the app (Artifact + MicroApp) and shows it in the
display. Re-run it after renaming; plain edits need only a refresh.

## The three rules

**1. Get the SDK from `/sdk/flowpad-sdk.js`.** Never bundle a copy, never write
a URL to the backend. The page is served by Flowpad from its own origin, so a
root-relative import is correct on a laptop and in a cloud sandbox alike.

```js
import * as sdk from '/sdk/flowpad-sdk.js';
```

**2. `await sdk.initSdk()` once, before anything else.** It loads the type
registry and the current project/compute node. Entity calls before it will fail.

**3. Use entities, not fetch.** `new sdk.Task({...}).save(projectTypeId)` writes
a real Task. Hand-rolled `fetch('/api/...')` bypasses the entity model and its
live updates.

## Always save WITH the project scope

`save()` with no argument places the entity outside any project
(`~/agentic-assets/…`), and the user's project task list will never show it —
the app looks like it works while its data is invisible where it matters.

The app resolves its own project from its own URL: it is served at
`/api/v1/graph/micro_app/<id>/view`, and that MicroApp row carries `project_id`
(see `resolveProjectTypeId()` in `app.js`). Do not assume
`dataContext.projectTypeId` — that is the backend's *default* project, not
necessarily the one this app belongs to.

```js
await new sdk.Task({ title }).save(projectTypeId);
```

## Ship it as an asset editor

The same folder can live INSIDE an asset, at `<asset folder>/editors/<name>/`
(a data-source definition, a skill, a task — any folder asset). Flowpad then
lists `<name>` on the asset's `editors` and serves the page at
`/api/v1/graph/<type>/<id>/editor/<name>/`; the UI opens it from the asset's
menus at `/dock/assets/editor/app/typeid/<type>-<id>?app=<name>`. Nothing to
register — re-index the asset and it is there. The rules above still hold; the
one addition is that the host entity is in the page's own path:

```js
const host = hostEntityTypeId();            // TypeId('data_source_spec', '…') or null
const spec = host && (await sdk.dataManager.getByTypeId(host));
```

Anything else the dock passes arrives as the query string (the Data Sources
menu passes `?source=<data_source id>`). To move the host somewhere, post a
dock URL to it — never navigate the frame itself:

```js
window.parent.postMessage({ kind: 'open-link', url: '/dock/assets/editor/task/typeid/task-…' }, location.origin);
```

## Live updates come free — do not poll

Flowpad pushes entity changes over a WebSocket. Subscribe with a watched query
and the callback fires when *anything* changes that data — this app, the Flowpad
UI, another browser window, or an agent:

```js
const request = new sdk.QueryRequest({
  type: 'task',
  scope: [],                       // unscoped: every task the user can see
  name: 'my-app-tasks',
  callback: (rows) => render(rows), // fires with the FIRST page too, then on every change
});
const unwatch = await sdk.dataManager.watchQuery(request);
```

`watchQuery` resolves to an **unsubscribe function**, not the rows — the rows
arrive through the callback. Render from what the callback hands you; never
patch a local array after a write, or the app will disagree with Flowpad.

A `setInterval` refetch is the wrong answer and will look broken next to the
rest of the app: it lags, and it fights the cache.

## Entities you will most likely want

| Entity | Notes |
|---|---|
| `sdk.Task` | `title`, `status` (`to_do` \| `in_progress` \| `done`), `description`, `due_at`, `start_date`, `assignee` |
| `sdk.Project` | the user's projects |
| `sdk.Markdown` | documents |

Read a type's real shape before inventing fields — `flow schema info task`.

```js
const task = await new sdk.Task({ title: 'Ship it' }).save();
task.status = 'done';
await task.save();
```

## Optional dev server

The app needs no build. If the user wants hot reload, `package.json` +
`vite.config.js` are included: `npm install && npm run dev` serves it with
`/api` and `/sdk` proxied to the backend, so the SDK works there too. Never
replace the proxy with a hardcoded backend URL — that breaks on every other
instance. Production stays `flow app serve` (Flowpad serves the folder).

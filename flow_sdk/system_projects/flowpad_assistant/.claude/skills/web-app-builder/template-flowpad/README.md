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

**4. Style with Flowpad's tokens, not your own palette.** `index.html` links
`/sdk/flowpad.css`, which carries the product's real colours, radii, font stack
and dark theme; `styles.css` then owns layout only. Call `sdk.applyHostTheme()`
before anything paints — a served page is cross-origin and cannot read the theme
class Flowpad sets on its own `<html>`, so it arrives via `?theme=` instead.

For anything beyond layout tweaks, load the **html-builder** skill (modern CSS
with no build step) and **frontend-design** (the aesthetic direction). An app
that lives inside Flowpad should look like it belongs there.

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

## Ship it inside an asset

The same folder can live INSIDE another asset, at
`<asset folder>/agentic-assets/webapp/<name>/` (a data-source definition, a
skill, a task — any folder asset). Nothing to register: a nested asset is a
child of the asset it sits in, so re-indexing makes it that asset's app, served
at `/api/v1/graph/micro_app/<id>/view/` and opened at `/dock/app/micro_app-<id>`
like any other webapp — with `Project / <parent> / <name>` in the address bar.

Mark what it is to its parent with `kind` in `webapp.json`:
`application.web.editor` is what makes the parent offer it as its editor. The
rules above still hold; the one addition is that the app can ask who contains
it, which is how an editor knows what it edits:

```js
const { subject } = await sdk.resolveAppHost();   // the PARENT asset
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

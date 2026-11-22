# Flowpad app template

An app that works with **Flowpad's own data**. It reads and writes the same
entities Flowpad does, so a task created here is *the* task — it appears in the
user's task view, on disk, and in every other window, with no syncing code.

Copy this folder, then edit `index.html` / `styles.css` / `app.js`. Do not
introduce a framework or a build step unless the user asks: the folder is
already its own build output, which is what lets Flowpad serve it as-is.

## Bootstrap

```bash
cp -R "<this skill's directory>/template-flowpad/." "<project root>/agentic-assets/webapp/<app name>/"
cd "<project root>/agentic-assets/webapp/<app name>"
# edit the three files, then:
flow app serve "<App Name>"
```

`flow app serve` registers the app (Artifact + WebApp) and shows it in the
display. Re-run it after renaming; plain edits need only a refresh.


## FlowCall integration

When integrating Flowpad processing, load the shipped FlowCall guide through the docs-browse skill. A FlowCall block is a ComputeOp with declared input/output and, for Python work, call.py:call. Use the entity SDK call, preserve ReturnedValue outcomes and explicit output presence, and correlate each invocation independently. Standalone app endpoints retain their own contracts.

## The SDK

Every SDK rule — the import, `initSdk()` once, `applyHostTheme()` + `/sdk/flowpad.css`, entities not `fetch`,
saving WITH the project scope (`resolveAppHost()`), the page-state key for frames and child windows, and how to
test — is in the **flow-js** skill. Load it before the first SDK call.

For anything beyond layout tweaks, load the **html-builder** skill (modern CSS
with no build step) and **frontend-design** (the aesthetic direction).

## Ship it inside an asset

The same folder can live INSIDE another asset, at
`<asset folder>/agentic-assets/webapp/<name>/` (a data-source definition, a
skill, a task — any folder asset). Nothing to register: a nested asset is a
child of the asset it sits in, so re-indexing makes it that asset's app — served
by the `static` endpoint indexing gives it (`service_endpoint/<id>/service/`)
and opened at `/dock/app/micro_app-<id>` like any other webapp — with `Project / <parent> / <name>` in the address bar.

The folder's `webapp.json` is what makes it an app (`name` = the folder name, `build: "."`
= serve these files as they are; a dev server would be a `proxy` entry under `endpoints` —
see the web-app-builder skill, *Register the app*). Mark what it is to its parent with `kind` in `webapp.json`:
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

Live updates (`watchQuery`, `onRowsChanged`) and the common entities: **flow-js** `reference/api.md`.

## Optional dev server

The app needs no build. If the user wants hot reload, `package.json` +
`vite.config.js` are included: `npm install && npm run dev` serves it with
`/api` and `/sdk` proxied to the backend, so the SDK works there too. Never
replace the proxy with a hardcoded backend URL — that breaks on every other
instance. Production stays `flow app serve` (Flowpad serves the folder).

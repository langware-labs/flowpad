---
id: aed4cf9a-1999-4c41-9fc1-93190e2300cf
name: flow-js
description: How a page talks to Flowpad through the browser JS SDK (`/sdk/flowpad-sdk.js`)
  — loading it, init order, theme, project scope, the page-state key (frames, child
  windows, new tabs), datasets, entities, files, processes and agents, realtime, navigation,
  and how to test such a page. Use whenever you write or fix JS/HTML that imports
  the SDK or calls `/api/v1` — a served web app, an html page in a project, an MCP-UI
  or page-aware agent page, a mock's script — or when a page shows "This page was
  opened without permission to use Flowpad". NOT for Python (`flow_sdk`), choosing
  what to build (building-deliverables), or data schemas (data-management).
---

# flow-js — the browser SDK, the one way

Every Flowpad page reaches Flowpad through the SDK, same-origin, with the key Flowpad gave it. Calls and patterns
by use case: `reference/api.md`.

## 0. The shape — one HTML file, data in tables

A page is ONE `.html` file (styles and script inline), shown with `flow show file`. No build, no web app to register.
Data that must persist is rows of a kind, read and written through `sdk.Dataset` — a dataset is the page's table.
A skill Flowpad ships declares its kinds once, in `flowpad_assistant/agentic-assets/data_schema/<skill>.<kind>/`: the
name is plain (`forkit.issue`), one for the whole system, nothing to copy or apply per project. A page of your own
project uses that project's kinds (`--<ns>--.<kind>`, the data-management skill). The forkit skill is the example.

A page meant to be embedded (in a message, a section) or passed along is a **nano-app**: the same one file, with a
manifest and `header` / `block` / `page` slots, started with `sdk.nano.start()` and handed one thing — its state key, which names what it was opened on — `reference/api.md` "Nano-app".

## 1. Load it — pick by where the page runs

| page | load |
|---|---|
| served by Flowpad (a webapp via `flow app serve`, a project file via fs/serve, a mock) | `import * as sdk from '/sdk/flowpad-sdk.js'` — static, relative; never a host or port |
| MCP-UI / sandboxed agent page (`__FLOWPAD_API_URL__` is injected) | `const sdk = await import(globalThis.__FLOWPAD_API_URL__ + '/sdk/flowpad-sdk.js')` |
| the SDK is optional (the page must still work without Flowpad) | the dynamic `import('/sdk/flowpad-sdk.js')` in `try/catch` |

Styles: `<link rel="stylesheet" href="/sdk/flowpad.css">` (the app's tokens, `hsl(var(--background))` …).

## 2. Start it — in this order, once

```js
sdk.applyHostTheme();          // before first paint: ?theme / host theme → .dark
await sdk.initSdk();           // once, before any other call; never throws (failures are logged)
```

No call before `initSdk()`, and never call it twice.

## 3. Scope — which project

```js
const host = await sdk.resolveAppHost();                 // the served app and its project
const projectId = host?.app?.project_id || sdk.dataManager.dataContext?.projectTypeId?.id;
```

`Dataset.forKind('crm.lead', projectId)` resolves a bare kind only with `projectId`; without it pass the full kind
`--<ns>--.crm.lead`. Save records with the project scope.

## 4. The page-state key — and the one place it is not inherited

On a local Flowpad every `/api` call must present the key Flowpad minted for the page. The SDK sends it for you
(header `X-Flowpad-State`) — from `__FLOWPAD_STATE_KEY__` (injected into served pages) or `?state=` in the URL.

| what the page opens | key |
|---|---|
| a served page — an app, a project file under `…/fs/serve/…`, a relative link — in a same-origin frame or link | inherited: the server reads the opener's `?state=` from the Referer and injects it |
| **Flowpad's own app shell** — `/win/…`, `/dock/…` (a process terminal, an editor, a chat) in a frame or new tab | **never inherited** (no page may take the app's reach): the URL must carry `?state=<key>` |
| a link with `rel=noreferrer`, or a URL you hand outside the page | no Referer: carry `?state=<key>` |
| a **nano-app file opened in a browser** (`file:///…/app.html`) | not served, so nothing is injected: its opener's URL carries `?state=<key>&api=<backend origin>` — a known key is what the backend answers it for |

Without it the frame shows *"This page was opened without permission to use Flowpad. Open it again from Flowpad."*

```js
const pageKey = () => globalThis.__FLOWPAD_STATE_KEY__ || new URLSearchParams(location.search).get('state');
const framed = (url) => { const k = pageKey(); if (!k || /[?&]state=/.test(url)) return url;
  const [u, h] = url.split('#'); return `${u}${u.includes('?') ? '&' : '?'}state=${encodeURIComponent(k)}${h ? '#' + h : ''}`; };
iframe.src = framed(`/win/shell/agentic_process-${pid}`);   // also window.open(framed(url)), <a target=_blank href=framed(url)>
```

Only same-origin Flowpad URLs get the key — never a third-party URL. On the hub the key is not enforced
(`htmlPage().enforced === false`); the helper is still right there.

## 5. Call Flowpad — the SDK, not `fetch`

- Data rows: `Dataset` (`forKind`, `query`, `put`/`putMany` with `expected` versions, `onRowsChanged`).
- Records: the entity classes (`Task`, `Project`, `AgenticProcess`, `Agent` …) and `dataManager`.
- Files: `fsManager` / `FSRef`, not a hand-built `/fs/serve/…` URL.
- An action with no entity method (e.g. `agentic_process/<id>/fork`): `sdk.apiClient.post('/graph/…', body)` —
  relative to `/api/v1`, returns the unwrapped `data`. Never `fetch('/api/v1/…')`: it sends no key.
- Navigate the host: `navigateHost({typeid})` / `navigateHost({address})`; external links `openExternal(url)`.
  Talking to the host: `postToHost` / `onHostMessage` (`openAgentChat(agent)` where the page cannot reach the API) —
  the host's origin is unknown to the page, so these never carry a secret.

## 6. Test it the way Flowpad opens it

Open the page with its real key — the URL `flow show` / the app gives (`?state=…`), or a key minted by
`POST /api/v1/page-state`. **Never** add `X-Cookie-Gate` (or any header) to the browser context: that secret
skips the key check, so frames without a key pass the test and fail for the user. Check every frame and child
window for the refusal banner (`[data-testid="flowpad-page-error"]`).

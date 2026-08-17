---
id: 7cc7701f-f1f7-4956-85b9-6ec51416ad18
---

# cookie-gate

An optional pre-shared secret that locks an instance to callers who can prove they were sent to it.

**Unset — the default, and every desktop install — nothing changes.** The gate costs one cached
dict lookup per request and passes.

**Set, the instance answers nothing without it.** Not the UI, not static assets, not the API, not a
WebSocket. Just a blank Forbidden page.

## Why

When the app runs inside an E2B sandbox it is reachable at a public, unauthenticated URL
(`https://9007-<sandbox-id>.e2b.dev`) and is auto-signed-in as a real user. Anyone who obtains that
URL — from browser history, a pasted link, a screenshot — gets that session. The sandbox id is the
only thing protecting it.

E2B does not help: `secure=True` guards only the envd control-plane port, not exposed app ports, and
`get_host()` returns a bare unsigned hostname. This makes the sandbox id stop being the password.

It composes with E2B's `allow_public_traffic: false` rather than replacing it — that rejects at the
edge, this rejects in the app.

## How it arms

The hub already curls `/auth/login_callback` over sandbox loopback to deliver the api-key
(`compute_node.py:_workspace_login`). That request never touches the public URL, which is what makes
it a usable channel for a secret. cookie-gate rides along:

```
GET http://127.0.0.1:9007/auth/login_callback?flowpad-api-key=<key>&cookie-gate=<secret>
```

The route validates the api-key, finalizes the login, and only then persists the secret. Arming
strictly after validation means an anonymous caller cannot lock the instance with a secret only they
hold.

The secret lives in the per-instance sod (`<instance_dir>/sodot` — 0600, Fernet, atomic locked
writes), next to the api-key it arrived with. It is read on every request, so it is memoized per
`instance_dir` in `flow_sdk/instance_settings/cookie_gate.py`; an uncached read is a full file
decrypt.

Arming also touches `<instance_dir>/.cookie_gate_armed`, and that marker is load-bearing rather than
a convenience. Decrypting the sod fetches its Fernet key, which on a normal install means an OS
keychain prompt (`file_sod._cipher` — "the single point that actually fetches the key"). `sod.read`
short-circuits only when the sodot file is *absent*, and a logged-in instance always has one. So
asking the sod whether we are gated would prompt the keychain on the first HTTP request after every
restart, on desktop installs that are never gated at all. The marker answers that from a `stat()` —
the same trick `hub_login.is_logged_in` uses to stay "safe to call at startup without triggering a
keychain access prompt", and the same shape as the `.secrets_enabled` consent marker. It holds no
secret: that an instance is gated is something the Forbidden page reveals anyway.

> Env vars do not work here, which is worth recording because it is the obvious first idea.
> `set_env` writes `~/.bashrc` and never reaches the running process; the app is already serving in
> the template snapshot before any sandbox-create env exists; `ServiceConfig` freezes env at import;
> and the only restart path is gated on `workspace_hub_url`, which defaults to empty. The gate would
> silently stay off — the wrong direction for this to fail in.

## What refuses to arm

**A desktop-managed instance cannot be gated.** `set_cookie_gate` raises `DesktopGateRefused` when
`<instance_dir>/.desktop_managed` exists, and both writers — the CLI command and
`/auth/login_callback` — go through it. The callback logs and drops the secret rather than failing
the login, the same posture it already takes for an unassignable `runtime`.

This is not defensive dressing; it closes a real incident. `flow auth set-cookie-gate` is hub-driven
and, as its help says, not meant to be typed by a human — but nothing enforced that, and a sandbox
provisioning command aimed at `FLOW_INSTANCE=prod` armed the gate on a desktop install. Because the
gate exempts no path, the Electron shell's own `/health/status` poll got the 403 like every other
caller: 222 refusals across its 120-second startup budget, after which it concluded the backend it
had just spawned was dead and killed it. The backend was healthy the whole time. Nothing in the
desktop logs said "gate" — only "Backend failed to start within 120s timeout".

Arming a desktop install is never correct: the gate exists to protect a sandbox's public
`https://9007-<sandbox-id>.e2b.dev` URL, and a desktop app has no public URL to protect.

The marker is written by the backend at startup (`server/startup.py::mark_desktop_managed`) when it
sees `FLOWPAD_DESKTOP=1`, which `electron/uv-manager.js` sets on the process it spawns. It has to be
persisted because that env var is visible only inside that one process — every `flow` CLI call is a
separate process, which is exactly why the CLI could not tell a desktop install from a sandbox.

Keyed on positive desktop evidence rather than on the absence of a hub `runtime` assignment: a real
sandbox has no assignment either until `/auth/login_callback` lands, so refusing "unassigned"
instances would block legitimate arming on a box that has not finished starting.

## How a caller gets in

One credential, three transports — not three special cases:

| Transport | Who uses it |
|---|---|
| `__Host-cookie-gate` cookie | the browser, on every request after its first |
| `X-Cookie-Gate` header | machine callers — workers |
| `?cookie-gate=` query param | the hub's loopback curl, and the browser's first contact |

Each is checked independently rather than collapsed into `a or b or c`. `or` yields the first
*present* value, so a stale cookie would short-circuit and a valid `?cookie-gate=` could never
override it — rotating the secret would permanently lock out every browser holding an old cookie,
with the one link that should rescue them being the thing that gets ignored.

**No path is exempt** — not `/health/status`, not `/auth/login_callback`, not `/auth/gate`. The rule
is not "block everything except these URLs", it is "block anything that cannot present the secret",
and every legitimate caller can. A path exemption would be a permanent hole; this has none.

### The exchange: `GET /auth/gate?cookie-gate=S&next=/`

The callback that armed the instance was made by **curl, inside the sandbox** — `-o /dev/null`, no
cookie jar. Its `Set-Cookie` went to curl and died there. The browser made zero requests during any
of this; it may not even have been open. So its first request is cold and has to carry the secret in
the URL, then trade it for a cookie.

`/auth/gate` is a route, not a branch in the middleware, and that is load-bearing. The hub knows
which caller is which — it builds the browser's link *and* curl's link. Doing the exchange inside
path-agnostic middleware would throw that knowledge away and force it to be re-derived by sniffing
request headers, and guessing wrong for the hub's re-login curl would swallow the login while
returning the 302 that `_workspace_login` reads as success. As a route, each caller states its
intent by choosing a URL: curl asks for `login_callback` and gets it, the browser asks for `gate`
and gets a cookie.

The route is gated like everything else. It is reachable because the caller presents the secret, not
because it is on a list.

On an unarmed instance it is inert: it redirects to `next` without setting anything, so a stale gate
link still lands in the app.

## Cookie attributes

| Attribute | Value | Why |
|---|---|---|
| Name prefix | `__Host-` | Forces host-only scope. `e2b.dev` is a suffix shared across every tenant; a `Domain=`-scoped cookie would be visible to every other sandbox. |
| HttpOnly | yes | Out of reach of any XSS in the app. |
| Secure | yes | Required by the prefix. The browser reaches the app through E2B's TLS edge even though the app serves plain http. Browsers treat `http://localhost` as trustworthy, so this still works for a local instance. |
| SameSite | Lax | The user arrives by cross-site top-level navigation. Strict would drop the cookie on later click-throughs and produce intermittent, baffling Forbiddens. |
| Path | `/` | Required by the prefix. |
| Lifetime | session | Closing the browser ends access; re-open from the hub to return. |

## The WebSocket half

Enforced explicitly, in the same middleware, because nothing else would. Cookies ride the
same-origin WS handshake, but `RequestTransactionMiddleware` bails on non-HTTP scopes — which is why
no WS handshake in this app is authenticated today. `CookieGateMiddleware` is therefore pure ASGI
rather than `BaseHTTPMiddleware`, which cannot see WebSocket scopes at all. A rejected handshake is
closed with 1008 before accept.

## Hub contract

The oss side is inert without this (FLOWPAD-1942):

1. `_workspace_login` mints `S = secrets.token_urlsafe(32)`, stashes it at
   `node_config["cookie_gate"]`, and appends `&cookie-gate={S}` to its curl URL.
2. `get_host_action` reads it back and points the browser at the exchange rather than the bare host
   — `{host}/auth/gate?cookie-gate={S}&next=/` — in **both** the `redirect=false` JSON branch (what
   the frontend actually uses) and the `RedirectResponse` branch. The frontend assigns the returned
   url to a tab and needs no change.
3. Ordering already holds: `workspace-ready` arms, then `get-host` links.

Health needs no special handling on the launch path: `_workspace_ready_op` probes health *before* it
logs in, so the gate is not armed yet. It runs once, on cold create — E2B's edge auto-resumes a
paused sandbox without the hub in the path.

## Known limitations

- **The link is the password.** The secret in the link *is* the gate secret — there is no separate
  burn-on-use token. A leaked `get-host` URL grants access until the instance dies. This is still an
  improvement (the link carries real entropy instead of being guessable off an e2b hostname) but it
  is the same shape as the problem it replaces. A one-shot token in the link is the upgrade path and
  needs no change to the gate itself: it already accepts a param and trades it for the cookie.
- **No revocation, no audit.** Once a browser holds the cookie it is good until the secret rotates or
  the instance dies. Hub logout does not reach it.
- **Fail-open on an unreadable secret.** A corrupt sod, or a keychain handoff that has not happened
  yet under `FLOWPAD_DESKTOP=1`, resolves to "not gated". Fail-closed would brick a desktop install
  over a keychain race. Worth revisiting if the gate ever protects something other than a public
  sandbox URL.
- **Rotation is in-process only.** The cache assumes a single writer. If the sod is rewritten out of
  band the running process serves the old secret until restart or `reset_cache()`.
- **Docker compute workers break on a gated instance.** `flow compute worker` dials
  `ws://host.docker.internal:{port}/api/v1/compute/ws` with no cookie-gate. No overlap today —
  Docker compute and E2B workspaces are different flavors — but if they ever meet, thread the secret
  into `/etc/flowpad/machine.env` and send it as `X-Cookie-Gate`.
- **Traffic still reaches the app.** It serves Forbidden rather than rejecting at the edge.

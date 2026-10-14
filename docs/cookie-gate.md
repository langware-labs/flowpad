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

Two credentials, three transports — not three special cases:

| Transport | Who uses it |
|---|---|
| `X-Cookie-Gate` header | machine callers — the hub's relay, the workers inside this box. The gate **secret** itself; never a browser's. |
| `__Host-grant` cookie | the browser, on every request after its first: a **grant** the hub issued for the `system` door, minted by `/auth/gate` from a ticket |
| `?ticket=` query param | the browser's first contact, which is necessarily cookie-less: the hub's signed **ticket**, good for a minute |

A grant (`flow_sdk/server/service_proxy.py`, `Grant`) names WHO may enter WHICH door of WHICH
endpoint: `caller|audience|endpoint`. The hub decides (`service_endpoint/<id>/open`) and signs
that subject with this box's gate secret — the ticket. The box verifies it with the secret it already
holds and keeps the same subject as a cookie signed with a key of its own (`server/grants.py`:
the secret × a boot nonce). **The secret never rides a URL or a cookie.** A grant for one door opens
no other: the `system` door (the box's own UI on 9007) refuses an `app` grant, and an audience door
(`server/audience_listener.py`, ports `AUDIENCE_PORTS`) refuses a `system` one.

Each transport is checked independently rather than collapsed into `a or b or c`. `or` yields the
first *present* value, so a stale cookie would short-circuit and a valid ticket could never override
it — a browser holding a grant from before a restart would be locked out, with the one link that
should rescue them being the thing that gets ignored.

**No path is exempt** — not `/health/status`, not `/auth/login_callback`, not `/auth/gate`. The rule
is not "block everything except these URLs", it is "block anything that cannot present a credential",
and every legitimate caller can. A path exemption would be a permanent hole; this has none.

### The exchange: `GET /auth/gate?ticket=T&next=/`

The callback that armed the instance was made by **curl, inside the sandbox** — `-o /dev/null`, no
cookie jar. The browser made zero requests during any of this; it may not even have been open. So its
first request is cold and carries the ticket in the URL, once, then trades it for the grant cookie.

`/auth/gate` is a route, not a branch in the middleware, and that is load-bearing. The hub knows
which caller is which — it builds the browser's link *and* curl's link (which presents the secret as
the header). As a route, each caller states its intent by choosing a URL: curl asks for
`login_callback` and gets it, the browser asks for `gate` and gets a cookie.

The route is gated like everything else. It is reachable because the caller presents the ticket, not
because it is on a list. On an unarmed instance it is inert: it redirects to `next` without setting
anything, so a stale link still lands in the app.

The same exchange exists on each audience door (`/auth/gate` on 9017 and 9027) for that door's
tickets; a door that is handed a ticket for another door answers 403.

### Revocation: `POST /auth/revoke`

`{"caller": "<typeid>" | null, "endpoints": ["<id>", …]}`, presented with the gate secret as the
machine header — a grant holder cannot revoke anybody. The hub posts it the moment someone's standing
narrows (a member removed, a role lowered, a public stamp withdrawn, a placement deleted); the named
caller's grants on those endpoints (everyone's, when `null`) are refused from then on. The denylist
lives in the process: it only has to outlive the grants it refuses, and those die with the boot nonce.

## Cookie attributes

| Attribute | Value | Why |
|---|---|---|
| Name prefix | `__Host-` | Forces host-only scope. `e2b.dev` is a suffix shared across every tenant; a `Domain=`-scoped cookie would be visible to every other sandbox. |
| HttpOnly | yes | Out of reach of any XSS in the app. |
| Secure | yes | Required by the prefix. The browser reaches the app through E2B's TLS edge even though the app serves plain http. Browsers treat `http://localhost` as trustworthy, so this still works for a local instance. |
| SameSite | None + Partitioned | The app display embeds an audience door in an iframe on the box UI's origin, a different port host. A partitioned (CHIPS) cookie is the one a browser still keeps there; browsers without CHIPS ignore the attribute. |
| Path | `/` | Required by the prefix. |
| Lifetime | session | Closing the browser ends access; the signature carries its own 12h expiry, and a restart of the box ends every grant. |

## The WebSocket half

Enforced explicitly, in the same middleware, because nothing else would. Cookies ride the
same-origin WS handshake, but `RequestTransactionMiddleware` bails on non-HTTP scopes — which is why
no WS handshake in this app is authenticated today. `CookieGateMiddleware` is therefore pure ASGI
rather than `BaseHTTPMiddleware`, which cannot see WebSocket scopes at all. A rejected handshake is
closed with 1008 before accept. The audience doors check the grant cookie on their handshakes too.

## Hub contract

1. The hub mints `S = secrets.token_urlsafe(32)` once per machine, stores it on the node row, and
   arms the box with `flow auth set-cookie-gate` at launch; its loopback curls present it as the
   `X-Cookie-Gate` header.
2. `service_endpoint/<id>/open` (reached directly, or through `compute_node/<id>/open/<door>`)
   asks the policy whether THIS caller may enter THIS row (`open-system` / `open-admin` /
   `open-app`), then redirects the browser to the door with a ticket: the box's own `/auth/gate`
   when the box publishes its ports, the hub's audience host otherwise. `S` is in neither URL.
3. The hub's relay keeps presenting `S` as the header and names the caller it vouches for as
   `X-Flowpad-Caller`, signed with `S`. The box's `X-Flowpad-User` to a service is only ever one
   of those, or the caller a grant names.
4. On an `access_changed` signal the hub posts `/auth/revoke` to every running box that publishes
   its ports; one it cannot reach is re-armed with a fresh secret instead, which ends every grant.

## Known limitations

- **Per-user revocation reaches a direct box only while it is running and reachable.** A paused box
  has no sessions; a running one the hub cannot reach is rotated wholesale.
- **Fail-open on an unreadable secret.** A corrupt sod, or a keychain handoff that has not happened
  yet under `FLOWPAD_DESKTOP=1`, resolves to "not gated". Fail-closed would brick a desktop install
  over a keychain race. Worth revisiting if the gate ever protects something other than a public
  sandbox URL.
- **Rotation is in-process only.** The cache assumes a single writer. If the sod is rewritten out of
  band the running process serves the old secret until restart or `reset_cache()`.
- **Enrolled machines (`flow connect`, incl. `flow connect --docker`) talk to the hub, not to a
  gated desktop instance**, so the gate never sits between the hub and a machine's worker.
- **Traffic still reaches the app.** It serves Forbidden rather than rejecting at the edge.
- **A dev server that binds every interface on an e2b box is public.** Flowpad launches servers with
  `HOST=127.0.0.1` and the templates bind loopback, so the audience door is the only way in; an app
  author who binds `0.0.0.0` themselves opens their own port.

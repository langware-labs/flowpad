---
id: 7cc7701f-f1f7-4956-85b9-6ec51416ad18
---

# cookie-gate

One token per instance, and the backend answers nothing without it: not the UI, not static assets,
not the API, not a WebSocket. Just a blank Forbidden page.

Without it the backend answered every request unauthenticated, so any web page could drive it: the
FLOWPAD-2233 proof of concept created a shell (`POST /api/v1/graph/shell`) from a sandboxed iframe and
ran a command through `run-detached`. Inside an E2B sandbox the same app is reachable at a public URL
(`https://9007-<sandbox-id>.e2b.app`), auto-signed-in as a real user, so the sandbox id was the only
password.

## The token

**Where it lives.** `<flow_home>/instances/<instance>/.cookie_gate`, a plain file. Every read goes to the file, so
nothing is cached. The CLI and Electron read the same file.

**On a hub box** the hub overwrites it with its own secret at launch (`flow auth set-cookie-gate`,
`compute_node.arm_gate`) and again on login (`/auth/login_callback?cookie-gate=`), so the hub, the
box's browser and its CLI all present one value. A desktop-managed instance (`.desktop_managed`, set
at startup under `FLOWPAD_DESKTOP=1`) refuses that write with `DesktopGateRefused`: its token is its
own, never the hub's.

**All of it is in `flow_sdk/instance_settings/cookie_gate.py`**: the file, the wire format, and the
cookie names and attributes. Callers use its functions and never see those details:

| Function | For |
|---|---|
| `verify_cookie(conn \| str)` | does a request (or a presented string) carry the token |
| `get_header()` | the `GateHeader(name, value)` a machine caller sends |
| `add_query_param(url)` | a URL that carries the token once |
| `set_cookie_header(conn)` | the `Set-Cookie` value that hands a browser its cookie |
| `set_cookie(value)` / `clear_cookie_gate()` | write / delete the token |
| `install_gate_opener()` | every `urllib` request in this process presents it |
| `CookieGateAuthHttpx()` | every request an httpx client sends presents it (`httpx.AsyncClient(auth=...)`) |
| `get_cookie_gate()` | the raw token, for the hub-signed caller check (`service_endpoint`) only |

Keeping the token on this machine is the caller's job: `flow_sdk.utils.networking.is_loopback` tells
it whether a host is this machine.

## Two gates, one token

`CookieGateMiddleware` (pure ASGI, so it sees WebSocket handshakes too; a refused one is closed with
1008 before accept) picks per request by the `Host` the client addressed:

- **Local** (`local_cookiegate_middleware.py`): a loopback `Host` (`localhost`, `127.0.0.1`, `::1`).
  The machine's own browser, the CLI, workers, Electron.
- **Sandbox** (`sandbox_cookiegate_middleware.py`): anything else, i.e. a hub box's public URL.

**The local gate** checks the token, by any of three transports, each checked on its own so a stale
cookie cannot veto a valid header or query:

| Transport | Who uses it |
|---|---|
| cookie | the browser, after its first contact |
| `X-Cookie-Gate` header | machine callers |
| `?cookie-gate=` query | a browser's first, cookie-less contact |

**No path is exempt**, in either gate, `/health/status` included. Every legitimate caller can present
a credential.

**The local gate also passes, without the token:**

- A **direct open**: `Sec-Fetch-Site: none`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` and
  a loopback Host. Browsers set these headers and pages cannot, and `none` is what a user-started
  load sends (typed URL, bookmark, OS launch), never another site's page or link. The response sets
  the cookie. The Host check stops a DNS-rebound name from being handed it.
- A **CORS preflight** (`OPTIONS` with `Origin` and `Access-Control-Request-Method`): browsers never
  attach cookies to one and no route runs; the request it clears is gated.

**The sandbox gate** takes two credentials, by three transports:

| Transport | Who uses it |
|---|---|
| `X-Cookie-Gate` header | machine callers — the hub's relay, the workers inside this box. The gate **secret** itself; never a browser's. |
| `__Host-grant` cookie | the browser, on every request after its first: a **grant** the hub issued for the `system` door, minted by `/auth/gate` from a ticket |
| `?ticket=` query param | the browser's first contact, which is necessarily cookie-less: the hub's signed **ticket**, good for a minute |

A grant (`flow_sdk/server/service_proxy.py`, `Grant`) names WHO may enter WHICH door of WHICH
endpoint: `caller|audience|endpoint`. The hub decides (`service_endpoint/<id>/open`) and signs
that subject with this box's gate secret — the ticket. The box verifies it with the secret it already
holds and keeps the same subject as a cookie signed with a key of its own (`server/grants.py`:
the secret × a boot nonce). **The secret never rides a URL or a cookie** through the public URL. A
grant for one door opens no other: the `system` door (the box's own UI on 9007) refuses an `app`
grant, and an audience door (`server/audience_listener.py`, ports `AUDIENCE_PORTS`) refuses a
`system` one. With no secret to check against, the sandbox gate refuses.

**The off switch.** `FLOWPAD_COOKIE_GATE=off`, read on every request, turns both gates off. The test
suite, instance_ctl dev instances, docker-compose and CI e2e set it. Hub-launched boxes must not.
With the switch unset, a token that can be neither read nor created refuses every request.

## Who presents it

| Caller | How |
|---|---|
| `flow` CLI, function runner, server monitor (`python -m flow_sdk.server.launch`), the backend itself (in-app diagnose) | `install_gate_opener()` at startup: every `urllib` request to a loopback host carries the cookie |
| httpx clients (connections, tag relay, webhook relay) | `CookieGateAuthHttpx` on the client: loopback URLs only |
| Other callers (CLI `local_request`, workers, notify) | `get_header()`, sent to loopback URLs only |
| Electron | `electron/cookie-gate.js`: the header on its health check, the cookie set once in the shared session, when `waitForBackend` sees the backend up |
| A browser the user opened themselves | the direct-open rule sets the cookie |
| A browser sent to log in or connect an account | `/auth/gate` sets the cookie first (below) |
| The browser coming back from a loopback OAuth provider | the callback listener forwards it to `/auth/oauth/callback` with `?cookie-gate=` |
| The hub, over a box's loopback | `X-Cookie-Gate` (`ComputeNode.http`, `_curl_status`) |
| Scripts | `-H "X-Cookie-Gate: $(flow auth get-cookie-gate)"`, or the `flow` CLI |

## `/auth/gate`

The route that hands a cold browser its cookie, on either gate's terms.

### On this machine: `/auth/gate?cookie-gate=<token>&next=<url>`

For a loopback `Host`. It is gated like everything else. It sets the cookie for the host the
browser addressed when the request carries the token, and redirects to `next`: a path on this
instance, or an absolute `http(s)` URL **only when the token is in the URL itself**. A crafted link
reaches the route without its sender holding the token -- a click from a desktop app passes the
direct-open rule, a click from a web page carries the browser's `Lax` cookie -- so without the token
in the URL an absolute `next` falls back to `/`, and the route is no open redirect.

The absolute form is what makes login and OAuth work in a browser that never opened Flowpad. The
hub, Auth0 and the OAuth providers return the browser to `127.0.0.1:<port>/auth/login_callback` or
`/auth/oauth/*`, and those returns would be refused without the cookie. So the CLI's login URL, the
hub code-flow OAuth URL and the LLM chooser are all built through `cloud_urls.wrap_url_auth_gate(url)`, which
enters through `/auth/gate` first; the provider's return is a top-level GET, so the `Lax` cookie rides
it.

### Through a box's public URL: `/auth/gate?ticket=T&next=/`

The callback that armed the box was made by **curl, inside the sandbox**, so the browser's first
request is cold: it carries the hub's ticket in the URL, once, and trades it for the grant cookie. The
hub knows which caller is which — it builds the browser's link *and* curl's — so each states its
intent by choosing a URL: curl asks for `login_callback`, the browser asks for `gate`. The same
exchange exists on each audience door (`/auth/gate` on 9017 and 9027) for that door's tickets; a door
handed a ticket for another door answers 403.

### Revocation: `POST /auth/revoke`

`{"caller": "<typeid>" | null, "endpoints": ["<id>", …]}`, presented with the gate secret as the
machine header — a grant holder cannot revoke anybody. The hub posts it the moment someone's standing
narrows (a member removed, a role lowered, a public stamp withdrawn, a placement deleted); the named
caller's grants on those endpoints (everyone's, when `null`) are refused from then on. The denylist
lives in the process: it only has to outlive the grants it refuses, and those die with the boot nonce.

## Cookie attributes

| | This machine (`cookie-gate-<port>`) | A hub box's public URL (`__Host-grant`) |
|---|---|---|
| Scope | per port: cookies ignore the port, so one name would let two local instances overwrite each other | host-only: `e2b.app` is shared across tenants |
| HttpOnly | yes | yes |
| Secure | no: it protects nothing on loopback, and Safari drops `Secure` cookies on `http://localhost` | yes (required by the prefix; the browser reaches the box through E2B's TLS edge) |
| SameSite | `Lax` | `None` + `Partitioned`: the app display embeds an audience door in an iframe on another origin, and a partitioned (CHIPS) cookie is the one a browser still keeps there |
| Path | `/` | `/` |
| Lifetime | one year | session; the signature carries its own 12h expiry, and a restart of the box ends every grant |

Locally `Lax`, not `Strict`: another site's fetch, form POST, iframe or subresource does not carry it, but a
top-level GET navigation does, and the hub/provider redirects back into the app are exactly that.
`Strict` refused them.

## Hub contract

1. `arm_gate` writes the hub's secret into the box at every launch; `_configure_box` does again on
   login. A local-machine node is not armed at launch.
2. Every hub call into a box goes over the box's loopback with `X-Cookie-Gate`.
3. `service_endpoint/<id>/open` (reached directly, or through `compute_node/<id>/open/<door>`)
   asks the policy whether THIS caller may enter THIS row, then redirects the browser to the door
   with a ticket. The secret is in neither URL.
4. The hub's relay names the caller it vouches for as `X-Flowpad-Caller`, signed with the secret.
5. On an `access_changed` signal the hub posts `/auth/revoke` to every running box that publishes
   its ports; one it cannot reach is re-armed with a fresh secret instead, which ends every grant.
6. A 403 from the box counts as alive: only the app's own gate answers it. The e2b template's
   `ready_cmd` accepts 200 or 403 for the same reason, since the box locks itself with its own token
   on its first request, before the hub arms it.

## Known limitations

- **Locally, the link is the password.** The token in a local `/auth/gate` link is the gate token,
  and it lands in browser history. A leaked link grants access until the token changes.
- **No local revocation, no audit.** A browser holding the local cookie keeps access until the token
  changes. Hub logout does not reach it.
- **Per-user revocation reaches a box only while it is running and reachable.** A paused box has no
  sessions; a running one the hub cannot reach is rotated wholesale.
- **Same site, other port.** Pages on another `localhost` port are the same site to the browser and
  ride the `Lax` cookie.
- **CORS still allows the `null` origin.**
- **Traffic still reaches the app.** It serves Forbidden rather than rejecting at the edge.
- **A dev server that binds every interface on an e2b box is public.** Flowpad launches servers with
  `HOST=127.0.0.1` and the templates bind loopback, so the audience door is the only way in; an app
  author who binds `0.0.0.0` themselves opens their own port.

---
id: fdde9a09-3dae-48a7-9e7b-7fec22d99c16
---

# Service endpoints — snippets

A `Deployment` says what runs where; the machine it runs on is a `ComputeNode` (a box —
this computer hosts many deployments, a cloud box one). Its `ServiceEndpoint` children say
what that placement ANSWERS on — one row per exposed service, each with a `subkind` (what
it is FOR) and a protocol (what it SPEAKS):

    Deployment (parent: a project, provider local | e2b | …)
      ├── ServiceEndpoint  "app"        app     web.app           routed  → one mount per app:
      │                                                                     shop        static → <app>/dist
      │                                                                     shop-<id8>  proxy  → 127.0.0.1:5173
      │                                                                     port-8080   proxy  → 127.0.0.1:8080  (`flow show webapp --port`)
      ├── ServiceEndpoint  "admin"      admin   web.app           routed  → backoffice  static → <app>/dist
      └── ServiceEndpoint  "shop-api"   service api.rest          proxy   → 127.0.0.1:8123

    Deployment (parent: an agent)
      └── ServiceEndpoint  "chat"       agent   api.chat.openai   channel → a message on the deployment's
                                                                           chat channel; its loop answers

    Deployment (parent: the ComputeNode — the machine's own placement)
      └── ServiceEndpoint  "workspace"  system  flowpad.workspace proxy   → the box's own app (with
                                                                           "shell-mcp" / "fs-mcp", system)

`subkind` is a closed set — `system` (the machine itself: its FlowPad app and the hub's MCP
servers), `admin` (the project's operator-facing web app), `app` (its end-user web app), `agent`
(talks to an agent: chat, MCP-UI), `service` (anything else: a REST API, a database port). The
endpoint's kind, `service_endpoint.<subkind>`, is derived; the protocol's kind is open — MCP is a
protocol (`api.mcp`), never a subkind.

**A placement answers a browser on at most three endpoints**: the machine's `workspace`, and the
project's `admin` and `app` — each ONE row. `admin` and `app` are **audience proxies**: their
backend is `routed`, a mount per app (`routes: {"<mount>": {backend, webapp_id, artifact_id}}`;
`""` is the audience's root app). Every web app served on the placement is a ROUTE of one of
them — never a row of its own — and is addressed as the pair *(endpoint, mount)*. An audience
nothing is served to has no endpoint. `agent` and `service` endpoints stay rows of their own, as
many as the deployment has.

A deployment DECLARES what it exposes (`Deployment.exposes`: name, subkind, protocol, check, and
the backend when it is known); its endpoint rows serve the declaration (`sync_endpoints()`, rows
found by name). An agent's deployment declares its `chat`. A declared service no row serves is
failing in the node's health report (§7) — "it should be running" is what the declaration promises.

Hub → box commands (clone, index, place secrets, run a check) are the **control plane**:
`ComputeNode.run_command` / `http` and the hub's `compute_node_tools`, hub-internal — never an
endpoint and never a REST verb.

Everything a machine serves is one of these — there is no other serving path: no
per-process port lookup, no `micro_app` view route, no hub services table.

Pinned by `tests/unit/test_service_endpoint_model.py` (the model and its wire form),
`tests/api/test_service_endpoint_proxy.py` (one round trip per protocol) and
`tests/api/test_webapp_endpoints.py` (web apps as routes of the audience proxies).

## 1. What an endpoint is

```python
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.service_endpoint import ServiceEndpoint

deployment = await (await Agent.by_name(AGENT)).deploy("local")   # the placement it serves from

endpoint = ServiceEndpoint(
    parent_type_id=str(deployment.typeid),          # the placement
    name="chat",                                     # unique within it
    protocol={"spec_kind": "api.chat.openai", "base_path": "/v1"},
    backend={"type": "proxy", "port": 8123},         # or {"type": "static", "root": "/…/dist"}
    supports_direct_access=True,                     # a hint to clients, never a grant
)
await endpoint.save()

endpoint.protocol.kind      # "api.chat.openai" — restores its own DataSpec (ChatOpenAIProtocol)
endpoint.subkind            # "agent" — what it is for; defaulted from the protocol when a writer does not say
endpoint.surface            # "api" — `web.*` is a browser app, everything else a machine caller
```

A shipped protocol restores its own shape; anyone else's must be namespaced
(`--acme--.api.grpc_web`) and is carried verbatim. An unmarked unshipped kind is refused on
both tiers.

## 2. Reaching it

```
GET|POST|… /api/v1/graph/service_endpoint/<id>/service/<path>           # a pure proxy, WebSockets too
GET|POST|… /api/v1/graph/service_endpoint/<id>/service/<mount>/<path>   # an audience proxy: the app at <mount>
GET        /api/v1/graph/service_endpoint/<id>/direct-url[?route=<mount>]   # {url}, resolved now (?redirect=1)
```

On an audience proxy the first path segment picks the app: a mount it routes is served with the
mount stripped, and any other path is the ROOT app's (`""`) own deep link. `direct-url` and
`probe` take `route=<mount>` — the proxy itself has no process, a route may.

`service` never parses the body — SSE, MCP sessions, ranges, gRPC-Web frames and
WebSocket subprotocols pass through as they are. The service never sees FlowPad's
credentials or cookies, and cannot set cookies on FlowPad's origin. On a cloud box the hub
signs who is calling (`X-Flowpad-Caller`, keyed by the box's gate secret); the box verifies
it and tells the service as `X-Flowpad-User`.

```ts
const endpoint = await ServiceEndpoint.getById(id);
fetch(endpoint.serviceUrl('v1/chat/completions'), { method: 'POST', body });
const url = await endpoint.directUrl();       // only when supports_direct_access
for (const app of endpoint.served()) {        // an audience proxy: one ServedApp per mount
  app.serviceUrl();                           // …/service/<mount>/
  await app.directUrl();                      // its dev server's own address
}
```

## 3. A web app's routes

`flow app open` / `flow app serve` register an app; its project's local placement's `app` proxy
gets a `proxy` route for the dev server and a `static` one for built output. `flow show webapp
--port N` registers the bare server as a route (`port-N`) and shows it; `--admin` puts it on the
`admin` proxy instead. A project-less run's routes go to this MACHINE's placement (parented to
the local compute node). A webapp asset gets its `static` route when it is indexed.

A route keeps its mount: re-registering an app lands on the mount it already holds, and a mount
another app holds is never taken (a second app of the same name mounts at `<name>-<id8>`).
Routes are written one writer at a time per placement (`webapp_placement.set_route` /
`drop_routes`); a proxy left with no route is deleted with its last one.

A display addresses the proxy and the mount, never a port:

```
flow show webapp --port 5173   →  {kind: app, typeid: service_endpoint-<id>, endpoint_id, route: "port-5173", runtime: dev}
POST /api/v1/graph/service_endpoint/<id>/probe?route=port-5173   # what is wrong with it, asked where it runs
```

A dev server (`proxy`) loads at its `direct-url` (its own origin — HMR, absolute
`/src/...`); built output (`static`) loads through `service`. Inside a cloud box
`direct-url` is the box's **audience door** (`server/audience_listener.py`, a listener per
audience on `AUDIENCE_PORTS`: admin 9017, app 9027), never the process's own port: the door
admits a browser by the grant it carries (`docs/cookie-gate.md`) and reaches the process over
loopback. Launched servers are told `HOST=127.0.0.1` for the same reason.

How a webapp asset is served wherever it is placed is declared in its `webapp.json`:

```json
{
  "name": "shop",
  "build": "dist",
  "mounts": [
    { "audience": "app", "path": "" },
    { "audience": "admin", "path": "console",
      "serving": { "type": "proxy", "start_cmd": "npm run admin -- --port {port}" } }
  ],
  "services": [
    { "name": "api", "protocol": { "spec_kind": "api.rest" },
      "serving": { "type": "proxy", "start_cmd": "uv run api.py --port {port}" } }
  ]
}
```

`audience` is `app` (end users, the default) or `admin` (operators); `path` is the mount (`""`:
that audience's root; unsaid: the app's own name). No `mounts` means one: the `build` folder, to
the `app` audience. A `services` entry is not a page of the app: it is a `service` endpoint of
its own, named `<app>-<name>`.

**Ports.** Which port a process runs on is decided in one place, `flow_sdk/core/app_ports.py`, from
two facts and nothing saved:

* **declared** — on the serving: `"ports": { "local": { "port": 3300, "required": true } }`.
  `required: true`: the process runs on that port or not at all — when another program holds it,
  starting fails and names who holds it. `required: false`: a preference; a free port is picked when
  it is taken. Nothing declared: a free port each start. `local` (the machine the process runs on) is
  the only environment. Two apps of one project may not require the same port. `"port": 3300` is the older spelling
  of a required port.
* **live** — the process table. A listening process is this app's when its working folder is inside
  the app's folder, so a server started by hand, or one that outlived a backend restart, is the app
  on the port it listens on; a program anywhere else on the port is never taken for the app.

A service starts before the page, and the page is told its port in `FLOWPAD_APP_PORT_<NAME>`.
`flow app ports` lists declared and live ports; `flow app stop <app>` acts on whatever runs.
`flow app open|restart <app>` bring the app up the one way every caller does — validate → load →
setup → fix (`bring_up`, `flow_sdk/core/setup/load.py`): a busy non-required port moves. Fix is a step
of the setup run, not a separate launch: each web-app step's `attempts` end in the setup-fixer agent,
then the step again, and the step's own check is the proof (`core/setup/derive.py`). A plain load
never runs it (`LoadTree` strips `attempts`); only the setup run keeps it.
A dead `http://localhost:<port>` whose port an app of the agent's project declares starts that app
when the agent's `auto_open` navigates to it.

## 4. On a cloud box

`POST /project/<id>/deploy` on the hub places the project in a box, then asks the box to
`expose-endpoints`: the box re-keys its project placement to the HUB's id, every webapp
comes up there as a route of the placement's `app` or `admin` proxy, and the box reports every
endpoint of that placement; the hub adopts each row at the box's id. The deploy answers with the
app's URL and every endpoint with its URL. Each audience proxy has an origin of its own, named
for the PLACEMENT and the audience — never a row id:

```
https://app--<deployment-id>.<app_domain>/<mount>/…     # end users — the visitor gate (the role stamped on the endpoint)
https://admin--<deployment-id>.<app_domain>/<mount>/…   # operators — hub identity (below)
```

The hub's session does not reach those origins, so each has a door of its own — and every door is
the SAME door. ONE question, `admit(principal, endpoint)` on the hub, asks the policy for
`open-<subkind>` on the row (`open-system` admin+, `open-admin` editor+, `open-app` members and
whatever visitor role is stamped on the row); ONE answer, a **grant** `caller|audience|endpoint`,
carried once as a signed ticket and kept as a cookie. A browser with no grant at an audience host
is sent to the hub (`service_endpoint/<id>/open?next=`), which decides and redirects back to
`/__flowpad/session` on that host with the ticket, traded for a host-only `fp_<audience>` cookie
(`fp_admin`, `fp_app`). An `app` row stamped public admits a visitor with no grant at all. The
cookie only says who and where; whether that caller may still enter is asked of `admit` on every
request, and the box is told who as `X-Flowpad-Caller`. `/__flowpad/*` is reserved on both hosts
and never reaches the app. A bare `<id>.<app_domain>` host names no service endpoint, and the hub's
own path route (`…/service_endpoint/<id>/service/…`) serves no machine's browser app either — only
machine protocols and the hub's own bundles. The box's own FlowPad app is its `workspace` endpoint
(`system`), opened through `compute_node/<id>/open/system` — the same `open`.

On a box that publishes its ports (e2b, a local instance) the hub does not relay at all: `open`
sends the browser straight to the box's door with the ticket — `https://9007-<box>/auth/gate` for
`system`, the audience listener's `/auth/gate` for `admin` and `app` — and the box keeps the grant as
its own `__Host-grant` cookie. When someone's standing narrows, the hub posts `/auth/revoke` to the
box (`access_changed` signal → `grant_revocation`), so a removed member is out at once there too.

Whether a service may also be reached without the hub (`supports_direct_access`) is the
PROVIDER's to say, never a row's: a box's process has an address of its own on an e2b box or
this machine, and none behind a GCP VM's firewall or on an enrolled laptop.

Afterwards the box registers routes like any machine (a dev server shown by port, an
app it built) — on the hub's placement, because its local one now IS that placement —
and asks the hub to `POST deployment/<id>/refresh-endpoints`. The hub PULLS (asks the box
to expose again) and adopts; a row the box no longer serves goes. A desktop watching the
box's process then shows the hub row, which the desktop's `service` route forwards to
the hub, and the hub to the box.

## 5. What the hub serves itself

A machine nothing deployed (a sandbox opened by hand) is its own placement — one
parented to the ComputeNode itself — serving `workspace`, `shell-mcp`, `fs-mcp` (all
`system`). `compute_node/<id>/open/<system|admin|app>`
resolves the placement's door for that audience and opens it. The hub's builtin apps (the chatbot, …)
are placed like anything else: each `hub`-provider placement has ONE `app` proxy whose routes
are bundles read off the hub's disk (`""` the app, `graph`, `dev`); a custom domain
(`WebDomain`) names an endpoint (`service_endpoint_id`).

## 6. An agent's `chat`

Every running agent deployment has one standard endpoint, `chat` (`api.chat.openai`, backend
`{type: channel, data_source_id}`), made when the deployment is launched and reported by a box for
its own. It is a **message channel**: a request is pushed into the deployment's `http_chat`
source as a message from the caller, the deployment's loop answers it like any other channel —
the turn an email or a WhatsApp message gets — and the reply the channel records is the response
(`flow_sdk/server/routes/service_channel.py`). Whoever may use the endpoint may chat: the hub
authorizes `service` by the endpoint's roles and vouches for the caller; on a desktop the caller
is the person at it.

```
POST v1/chat/completions   {messages, stream?, metadata: {conversation_id?}}   # SSE when stream
GET  v1/models                                                                  # the one model: the endpoint
GET  v1/conversations/<id>                                                      # {messages}
```

A conversation is the caller's own — the same id from someone else is a different thread.
`metadata.conversation_id` continues one; omitted, one is started and every answer names it
(`flowpad.conversation_id`, and the `X-Flowpad-Conversation` header). No reply within the
request's deadline is a 504 `no_reply_yet` naming the conversation; the message stays in the
channel for the loop. `direct-url` is refused: there is no port behind it. From the SDK:

```ts
const chat = await AgentChat.forDeployment(deployment);        // its `chat` endpoint, here or on the hub
for await (const e of chat.send('hello', { conversationId })) { /* text | tool | error | done */ }
const past = await chat.history(conversationId);
```

Pinned by `tests/api/test_http_chat_channel.py` (over the real app, the loop on a mock worker) and
`tests/long_tests/test_local_deployment_process.py` (a real deployment process answering it).

## 7. Health — every service says whether it is alive

Every endpoint has a `health_check()`; a `ComputeNode`'s `health_check()` is the list of all of its
services'. The check is declared (`check`) or defaulted from the backend:

| backend | default check | alive when |
| --- | --- | --- |
| `proxy` | `http` on its `health` path | anything answers below 500 on the loopback port (a gated 403 is up) |
| `static` | `builtin` | its root folder exists |
| `channel` | `builtin` | the deployment's answering loop holds its lock |
| `routed` | each route's own | every route is alive — a static root exists, a process answers; the detail names the mount that fails |
| any | `command` (declared) | the command exits 0 on the machine — e.g. `pg_isready` |

```python
from flow_sdk.builtin.service_endpoint import ServiceEndpoint

db = ServiceEndpoint(
    name="db",
    parent_type_id=str(deployment.typeid),
    subkind="service",
    protocol={"spec_kind": "api.rest"},
    backend={"type": "proxy", "port": 5432},
    check={"type": "command", "cmd": "true"},     # e.g. "pg_isready"
)
result = await db.health_check(record=False)      # EndpointHealth — never raises
assert result.state == "alive"
```

```
GET service_endpoint/<id>/health     # check it now → EndpointHealth {state, detail, latency_ms, observed_at}
GET compute_node/<id>/health         # every service on the machine → NodeHealth {node_id, endpoints: [...]}
```

The result is recorded on the endpoint (`health`) only when its state changed. On the hub, the same
checks run over the control plane (`probe` on the box's loopback, a command on the box, the box's own
app for a channel), and a sweep checks every RUNNING box once a minute — a paused box is never woken
by a health check. Pinned by `tests/unit/test_endpoint_health_check.py` and `tests/api/test_health_api.py`
(here) and `test_node_health_check.py` / `test_health_monitor.py` (hub).

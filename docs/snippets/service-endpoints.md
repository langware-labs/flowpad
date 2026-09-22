---
id: fdde9a09-3dae-48a7-9e7b-7fec22d99c16
---

# Service endpoints — snippets

A `Deployment` says what runs where. Its `ServiceEndpoint` children say what that
placement ANSWERS on — one row per exposed service:

    Deployment (runtime.web, provider local | e2b | …)
      ├── ServiceEndpoint  "shop"       web.app          static  → <app>/dist
      ├── ServiceEndpoint  "shop-dev"   web.app          proxy   → 127.0.0.1:5173
      ├── ServiceEndpoint  "port-8080"  web.app          proxy   → 127.0.0.1:8080  (`flow show webapp --port`)
      └── ServiceEndpoint  "workspace"  flowpad.workspace proxy  → the box's own app (cloud only;
                                                                     with "shell-mcp" / "fs-mcp")

    Deployment (runtime.agent — an agent's placement)
      └── ServiceEndpoint  "chat"       api.chat.openai  agent   → the agent's turns, answered
                                                                     by the app holding the placement

Everything a machine serves is one of these — there is no other serving path: no
per-process port lookup, no `micro_app` view route, no hub services table.

Pinned by `tests/unit/test_service_endpoint_model.py` (the model and its wire form),
`tests/api/test_service_endpoint_proxy.py` (one round trip per protocol) and
`tests/api/test_webapp_endpoints.py` (webapps as endpoints).

## 1. What an endpoint is

```python
from flow_sdk.builtin.service_endpoint import ServiceEndpoint

endpoint = ServiceEndpoint(
    parent_type_id=str(deployment.typeid),          # the placement
    name="chat",                                     # unique within it
    protocol={"spec_kind": "api.chat.openai", "base_path": "/v1"},
    backend={"type": "proxy", "port": 8123},         # or {"type": "static", "root": "/…/dist"}
    supports_direct_access=True,                     # a hint to clients, never a grant
)
await endpoint.save()

endpoint.protocol.kind      # "api.chat.openai" — restores its own DataSpec (ChatOpenAIProtocol)
endpoint.surface            # "api" — `web.*` is a browser app, everything else a machine caller
```

A shipped protocol restores its own shape; anyone else's must be namespaced
(`--acme--.api.grpc_web`) and is carried verbatim. An unmarked unshipped kind is refused on
both tiers.

## 2. Reaching it

```
GET|POST|… /api/v1/graph/service_endpoint/<id>/service/<path>   # a pure proxy, WebSockets too
GET        /api/v1/graph/service_endpoint/<id>/direct-url        # {url}, resolved now (?redirect=1)
```

`service` never parses the body — SSE, MCP sessions, ranges, gRPC-Web frames and
WebSocket subprotocols pass through as they are. The service never sees FlowPad's
credentials or cookies, and cannot set cookies on FlowPad's origin. On a cloud box the hub
signs who is calling (`X-Flowpad-Caller`, keyed by the box's gate secret); the box verifies
it and tells the service as `X-Flowpad-User`.

```ts
const endpoint = await ServiceEndpoint.getById(id);
fetch(endpoint.serviceUrl('v1/chat/completions'), { method: 'POST', body });
const url = await endpoint.directUrl();       // only when supports_direct_access
```

## 3. A web app's endpoints

`flow app open` / `flow app serve` register an app; its project's local placement gets a
`proxy` endpoint for the dev server and a `static` one for built output. `flow show webapp
--port N` registers the bare server as a `proxy` endpoint (`port-N`) and shows it. A
project-less run's endpoints go to this MACHINE's placement (parented to the local
compute node). A webapp asset gets its `static` endpoint when it is indexed.

A display addresses the endpoint, never a port:

```
flow show webapp --port 5173   →  {kind: app, typeid: service_endpoint-<id>, endpoint_id, runtime: dev}
POST /api/v1/graph/service_endpoint/<id>/probe   # what is wrong with it, asked where it runs
```

A dev server (`proxy`) loads at its `direct-url` (its own origin — HMR, absolute
`/src/...`); built output (`static`) loads through `service`.

What a webapp asset exposes when it is placed elsewhere is declared in its `webapp.json`:

```json
{
  "name": "shop",
  "build": "dist",
  "endpoints": [
    { "name": "site" },
    { "name": "api", "protocol": { "spec_kind": "api.rest" },
      "serving": { "type": "proxy", "start_cmd": "uv run api.py --port {port}" } }
  ]
}
```

No `endpoints` means one: the `build` folder as a `web.app`.

## 4. On a cloud box

`POST /project/<id>/deploy` on the hub places the project in a box, then asks the box to
`expose-endpoints`: the box re-keys its project placement to the HUB's id, every webapp
comes up there, and the box reports every endpoint of that placement; the hub adopts
each row at the box's id. The deploy answers with the app's URL — a `web.*` endpoint on
an origin of its own, `https://<endpoint-id>.<app_domain>/` — and every endpoint with its
URL. The box's own FlowPad app is its `workspace` endpoint.

Afterwards the box registers endpoints like any machine (a dev server shown by port, an
app it built) — on the hub's placement, because its local one now IS that placement —
and asks the hub to `POST deployment/<id>/refresh-endpoints`. The hub PULLS (asks the box
to expose again) and adopts; a row the box no longer serves goes. A desktop watching the
box's process then shows the hub row, which the desktop's `service` route forwards to
the hub, and the hub to the box.

## 5. What the hub serves itself

A machine nothing deployed (a sandbox opened by hand) is its own `compute.node`
placement: `workspace`, `shell-mcp`, `fs-mcp`. `compute_node/<id>/open-service/<name>`
resolves names through those endpoints only. The hub's builtin apps (the chatbot, …)
are endpoints of `hub`-provider placements, read off the hub's disk; a custom domain
(`WebDomain`) names an endpoint (`service_endpoint_id`).

## 6. An agent's `chat`

Every agent placement has one standard endpoint, `chat` (`api.chat.openai`, backend
`{type: agent, agent_id}`), made by the app's agent server for every local placement and
reported by a box for its own. It is answered in-process by the FlowPad app holding the
placement, through the same turn engine that answers the agent's channels — so a chat turn is
the turn an email or a WhatsApp message gets. Whoever may use the endpoint may chat: the hub
authorizes `service` by the endpoint's roles and vouches for the caller; on a desktop the
caller is the person at it.

```
POST v1/chat/completions   {messages, stream?, metadata: {conversation_id?}}   # SSE when stream
GET  v1/models                                                                  # the one model: the agent
GET  v1/conversations/<id>                                                      # {messages}
```

A conversation is the caller's own — the same id from someone else is a different
conversation. `metadata.conversation_id` continues one; omitted, one is started and every
answer names it (`flowpad.conversation_id` on each chunk). `direct-url` is refused: there is
no port behind it. From the SDK:

```ts
const chat = await AgentChat.forDeployment(deployment);        // its `chat` endpoint, here or on the hub
for await (const e of chat.send('hello', { conversationId })) { /* text | tool | error | done */ }
const past = await chat.history(conversationId);
```

Pinned by `tests/api/test_agent_chat_endpoint.py`.

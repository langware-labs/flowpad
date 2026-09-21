---
id: fdde9a09-3dae-48a7-9e7b-7fec22d99c16
---

# Service endpoints — snippets

A `Deployment` says what runs where. Its `ServiceEndpoint` children say what that
placement ANSWERS on — one row per exposed service:

    Deployment (runtime.web, provider local | e2b | …)
      ├── ServiceEndpoint  "shop"       web.app          static  → <app>/dist
      ├── ServiceEndpoint  "shop-dev"   web.app          proxy   → 127.0.0.1:5173
      └── ServiceEndpoint  "workspace"  flowpad.workspace proxy  → the box's own app (cloud only)

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
`proxy` endpoint for the dev server and a `static` one for built output. What a webapp
asset exposes when it is placed elsewhere is declared in its `webapp.json`:

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
`expose-endpoints`: every webapp comes up there, keyed by the hub's placement, and the hub
adopts each row at the box's id. The deploy answers with the app's URL — a `web.*`
endpoint on an origin of its own, `https://<endpoint-id>.<app_domain>/` — and every
endpoint with its URL. The box's own FlowPad app is its `workspace` endpoint.

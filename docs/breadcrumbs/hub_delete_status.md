---
id: 4186df45-faac-4594-b2f0-6fe8e598c904
title: Hub-first delete status rules
tags:
- breadcrumb.test.hub_delete_status.rules
description: A failed hub-first delete answers HubError.http_status (403/401 kept,
  offline or hub 5xx 502, no hub 503) with HubError.user_message(), and keeps the local
  row for a retry.
---
# Hub-first delete status rules

> Ground truth. Proven by RCA on 2026-11-03 (FLOWPAD-2328). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.hub_delete_status.rules
sites:
  - rel_path: "tests/unit/test_deployment_delete_action_hub_failures.py"
    line: 121
    note: "FAILING? read this tag's rules before editing — the status comes from HubError.http_status, never a hard-coded one"
```

## Expected behavior

`DELETE /api/v1/graph/<type>/<id>` for an `owns_hub_delete` type (Agent, Deployment,
DiagnosisRequest, Organization) asks the hub first. When the hub delete fails:

| What happened | Status | `detail` (`HubError.user_message()`) |
|---|---|---|
| The hub refused it (any 4xx, e.g. 403 `target_not_found`: the hub no longer has it) | the hub's own 4xx | the refusal's reason, set by `unshare()` |
| The hub rejected the credential (`unauthenticated`), or there are no local credentials (the hub is never asked) | 401 | You're signed out — sign in to send this. |
| The hub broke (5xx) | 502 | the reason, set by `unshare()` |
| Nothing came back: timeout, refused, DNS, TLS | 502 | Can't reach the hub right now. |
| No hub configured | 503 | This app is not connected to a hub. |

A hub 404 means it's already gone, so it counts as a successful delete. In every failure the local row is kept, so the
delete can be retried.

## Internals

- `handle_delete_by_id`, `flow_sdk/app/actions/graph_crud_actions.py:211`. Its `except HubError`
  (`:268`) raises `HTTPException(status_code=e.http_status, ...)`.
- `HubError.http_status`, `flow_sdk/cloud_client/shared/errors.py:81`, maps the failure kind
  (`classify_hub_failure`, `:35`) to the local status: `REJECTED` keeps the hub's 4xx, `SIGNED_OUT` gives 401,
  `NOT_CONFIGURED` gives 503, and anything else (offline, server error) gives 502.
- `HubError.user_message`, `errors.py:111`, is the sentence for each failure kind.
- `Entity.delete`, `flow_sdk/core/entity/entity_model.py:3212`, calls `unshare()` (`:2448`) before any local side
  effect. `unshare()` raises a `HubError` carrying the hub's `data.error_code`. With no credentials it raises a
  `signed_out` `HubError` (`:2473`), not a `RuntimeError`.

## Invariants

- The status comes from `HubError.http_status`. It's never hard-coded and never the hub's raw 5xx, so the UI can tell
  a hub failure (502) from a local crash (500).
- `detail` is `HubError.user_message()`. It's never built by hand from `e.reason`, status numbers or hub codes
  (`target_not_found`).
- A failed hub delete never removes the local row.

## Failure modes

- A hard-coded 502 sends every hub refusal (403, 401) back as a gateway error.
- Passing on `e.status_code` sends a hub 500 back as a local 500.
- Building `detail` by hand (`f"{e.reason} ({e.status_code}); ..."`) shows internals and raw exception text.

# Cross-repo — does this change need the other repo?

`flowpad` (desktop app: `flow_sdk`, `ts_sdk`, `ui`) and `flowpad-hub` (the hub
server) talk to each other. A change on one side can break the other while every
gate on this side stays green: hub CI installs `flowpad` from PyPI, and flowpad CI
skips `tests/hub_tests/`. This lens catches that.

## Find the other repo

```bash
OTHER=flowpad-hub   # or flowpad, when reviewing the hub
OTHER_DIR=$(ls -d "../$OTHER" "$HOME/Developer/$OTHER" 2>/dev/null | head -1)
```

Also check the `--add-dir` directories of this session (a deployed agent mounts
the other repo there via `flow.json`). Not found → say "cross-repo: skipped, other
repo not on this machine" and move on. Found → `git -C "$OTHER_DIR" fetch -q` and
read it at its release branch, or at the same `FLOWPAD-XXXX` branch if one exists
there (a paired change). **Read only — never edit or switch branches in the other
repo**; report what it needs.

## When to read it

Run this only when the diff hits a row below. No hit → one line: "Cross-repo: no
contact points touched". FP = flowpad, HUB = flowpad-hub.

| # | Contact point | Signal in the diff | Check on the other side |
|---|---|---|---|
| 1 | **FP calls the hub API** — `flow_sdk/cloud_client/transport/hub_http.py`; HUB serves it through the catch-all `hub/routers/graph.py` → `@action` methods in `hub/builtin/*.py` | FP: `hub_(get\|post\|put\|delete\|request)\(`, `hub_graph_url`, `hub_public_url`, `/api/v1/` · HUB: `@action\.`, `action_name=`, `include_router`, a renamed/removed action | The entity type, action name and HTTP method exist (`@action.get` ≠ `hub_post`); payload keys match what the handler reads; the response shape matches what the caller reads. A renamed hub action → grep FP `flow_sdk` + `ts_sdk/src` for the old name |
| 2 | **The UI in hub mode** — the hub serves FP's built `ui` from the released wheel and the TS SDK calls hub routes directly | FP: `ts_sdk/src/**` endpoint strings, `apiClient`, `isHubOnly`, `hubModeReady`, `supported_pages` | The endpoint exists on the hub, or the call is gated by `isHubOnly()` |
| 3 | **The hub calls the box** (a desktop app on a sandbox/VM) — `hub/app/services/{node_relay,compute_node_tools,sandbox_deploy,deployed_agent,service_proxy,webhook_chain}.py` | HUB: `send_to_node\(`, `call_box_action\(`, `box_service_path`, `f"/api/v1/` · FP: `flow_sdk/server/routes/{data_source_webhook,service_endpoint,cloud,bootstrap}.py`, `@action` on `builtin/{agent,project,compute_node,agentic_process}.py` (e.g. `adopt_placement`, `use`, `run_schedule`) | The box route still exists with the same method, payload and `ApiResponse` shape. Boxes run the flowpad version pinned in the e2b template, not FP HEAD — a new box route needs a release + template roll (#9) and old boxes must still work |
| 4 | **HUB imports `flow_sdk`** — 32 hub files, e.g. `models.FSEntry` (on the hub's boot path via `gcs_driver`), `builtin.flow_message.DeliveryStatus`, `builtin.git_origin`, `assets.*`, `fs_store.schema_registry`, `utils.git`, `config.API_PREFIX` | FP: a rename/removal/signature change in a module HUB imports (`grep -rn "flow_sdk" $OTHER_DIR/flowpad --include=*.py`) · HUB: a new `from flow_sdk …` or a change to the `flowpad>=` floor / `uv.lock` | A symbol HUB uses still exists — it breaks on the hub's next lock bump. A new HUB import must exist in the **locked** flowpad version (`uv.lock`), not only in FP HEAD |
| 5 | **Mirrored classes** — the hub copies models by hand instead of importing them; fields must agree | `class (Agent\|Deployment\|ServiceEndpoint\|Project\|Conversation\|Invitation\|FlowMessage)\(`, a new/renamed/retyped `APIField`/`Field`, comments saying `mirror` / `parity` | The counterpart (`FP flow_sdk/builtin/<x>.py` ↔ `HUB hub/builtin/<x>.py`; FlowMessage ↔ `HUB hub/core/network/flow_message.py`; Docs/Whiteboard/Folder ↔ `HUB hub/builtin/reflected_types.py`) has the same name, type and default. A field the hub lacks is dropped silently; one it doesn't know → 422 |
| 6 | **Mirrored enums and ids** — values must be byte-identical | `identifier.py` / `is_valid_entity_id` (FP `api/api_types/identifier.py` ↔ HUB `hub/api/identifier.py` ↔ FP `ts_sdk/src/models/TypeId.ts`); `ComputeNodeSize`, `ExecutionEnvironmentStatus` (FP `flowpad_types/runtime_environment.py` ↔ HUB `hub/types/runtime_environment.py` ↔ `ts_sdk/src/entities/compute-node/`); `ComputeProviderType` ↔ HUB `ComputeProvider` (`config.py`); `RuntimeKind`; `AuthRole`/`HubRole` ↔ HUB `enums/auth_enums.py`; `AUDIENCE_PORTS` | Every copy changed the same way |
| 7 | **Same-path files** — FP `flow_sdk/<p>` ↔ HUB `flowpad/hub/<p>` started as copies (e.g. `core/policy/`, `api/messages.py`, `core/urls/service_urls.py`, `core/flow/mcp_server.py`, `core/flow/mcp_servers/copy_to_sandbox/`) | A diff touching a path that exists under both roots: `test -e "$OTHER_DIR/<mapped path>"` | Whether the same fix belongs in the twin. Report as "should fix", not blocker, unless it is a wire contract |
| 8 | **Policies and roles** — `HUB hub/app/policies.json` decides who may call each action | FP: a call to a new action, a new role string · HUB: `policies.json`, `role_hierarchy.py` | Every new action FP calls is granted for the roles that call it (else 403); role strings FP sends exist in the hub |
| 9 | **Versions and the e2b template** — HUB pins `flowpad` twice, independently: `pyproject.toml`/`uv.lock` (what the hub imports) and `ops/e2b/flowpad-exec-env/templates/*.toml` (what boxes run) | FP: `_version.py`, any box-side change from #3 · HUB: `ops/e2b/`, `DEFAULT_E2B_VERSION`, `e2b_ledger` | A hub change that relies on new FP behaviour names the release that ships it; say which pin must move (`deploy-pypi-e2b-hub` skill) |
| 10 | **Bootstrap payload** — FP `models/bootstrap_models.py` ↔ HUB `hub/app/actions/bootstrap_actions.py` ↔ `ts_sdk/src/models/BootstrapInfo.ts` | `BootstrapInfo`, `RuntimeInfo`, `supported_pages`, `runtime.kind`, `types` | All three agree; an older hub (missing field) still works |
| 11 | **Webhook / channel claim chain** — FP `sources/flow_channel.py`, `cloud_client/webhook_relay.py`, `server/routes/data_source_webhook.py` ↔ HUB `hub/builtin/webhook.py`, `hub/app/services/{webhook_chain,webhooks,node_relay}.py` | `CLAIM_ENTITY`, `chain`, `reply`, `ack`, `catch_up`, `delivery_id`, `event_id`, `/webhook` | Body keys, reply-window semantics, and the box path `webhook_chain.py` builds |
| 12 | **Env vars the hub injects into boxes** — HUB `hub/builtin/faas/compute_node.py` (`FlowEnv(name=…)`), gcp_vm `provider`/`enrollment`/`start-workspace.py` | `(FLOWPAD\|FLOW\|DEPLOY\|E2B)_[A-Z_]+` added/renamed next to `getenv`/`environ`/`FlowEnv` | Every injector and reader uses the new name; old boxes still read the old one |
| 13 | **Shared skills** — HUB `.claude/skills/{pr,rca,e2b-builder,deploy-pypi-e2b-hub,tagit}` are symlinks into FP; `flowpad-api-urls` lives only in HUB | `.claude/skills/<one of those>/` | Paths and commands in the skill still hold when run from the other repo |

## Parity tests — run the other side's too

A hit on #5/#6/#10 means the other repo's parity test is the real gate. Run it
there (read-only, in the background) and report the result as a gate:

* HUB `flowpad/hub/tests/unit/`: `test_deployment_field_parity.py`,
  `test_audience_ports_parity.py`, `test_entity_name_title_contract.py`,
  `test_fs_action_parity.py`, `test_agent_git_deploy_contract.py`,
  `test_open_service_route_contract.py`, `test_helpdesk_mirror_contract.py`
  — run with `env -u DEPLOY_ENV`.
* FP: `tests/unit/agent/test_agent_deployment_contract.py`,
  `tests/unit/test_agent_contract_fields.py`, `test_audience_ports_parity.py`,
  `test_entity_name_title_contract.py`; for live hub contracts `tests/hub_tests/`
  (needs a local hub at `FLOWPAD_HUB_URL`, skipped in CI).

A hub parity test runs against the **installed** `flowpad` wheel, so it cannot see
an unreleased FP change — say so instead of reporting a pass.

## Severity

* **Blocker** — a wire contract breaks: a route/action/field/enum value the other
  side sends or reads is gone or different, a HUB import of a removed symbol, an
  action called without a policy grant.
* **Should fix** — the twin of a same-path file or a mirrored class did not get the
  same change, but nothing on the wire breaks yet; a missing release/pin step.
* Each finding names both sides: `<this file>:<line>` ↔ `<other repo>/<file>:<line>`.

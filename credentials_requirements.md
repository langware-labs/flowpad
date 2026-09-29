---
id: e42c4585-3e51-4cb2-924e-1bbf807b83c0
---
<!-- TEMPORARY working doc (untracked). The mega plan, approved 2026-09-27. Deleted when Part D closes, after its
     still-true takeaways move into the architecture docs. Each part's step 4 updates §Status. -->

# Mega plan — deployments that work "as is" on e2b (Parts A–D)

**Before this plan (DONE 2026-09-26/27):** Part 1 credential gaps (delete forgets every store, the leftover sweep),
Part 2 model and naming (`Credential`; a Deployment says where values live; permissions, requirements, readiness),
Part 3 deployment secrets (the hub store, "use mine", the readiness gate, the hub placing values on the machine,
per-deployment OAuth authorization, CLI and UI) — proven on a real local node. Commits: oss d3c481e99..172986348,
hub ac5515f3b..45a2f66d0. Their open items are in §Remaining issues.

## Context

Goal: a project developed locally — an agent with real channels (agentmail, Telegram, WAHA, WhatsApp Cloud API,
Slack, phone) — deploys **as is** to e2b through the hub, keeps working there (secrets placed, webhooks reachable at a
URL that never changes, model calls paid by the hub), and when removed leaves nothing behind. Parts 1–3 built the
credential cycle (hub store, use mine, readiness gate, placement on the machine, per-deployment OAuth) and proved it
on a local node only. Three things block "as is": place-specific settings live in `data_source.json` (they travel in
the repo), a box has no stable public webhook URL (the sandbox URL changes and the cookie gate blocks it), and the
paid LLMEndpoint path on a deployment is unproven (its spend test fails today).

## Working rules (every part)

Each part runs five steps, strictly in order; the next part starts only after the gate closes:
1. **Read** — the part's listed docs and code areas (below), all of them; restate the requirements (functional +
   architectural) at the level of interfaces and services; small details are left to the part's plan.
2. **Plan** — plan mode, bottom-up, the whole migration; list every test location it touches.
3. **Execute** — touched tests while working (`-x`, one failure at a time, units < 1 s, no raised timeouts/waits).
4. **Gate + docs + status** — the part's test gate green (below); `/docit` over the part's commits; this doc's
   §Status updated: done items, commits, and the **remaining issues list**.
5. **/simplify, then commit** — fixes applied, touched tests re-run, commit on the current branches
   (`git branch --show-current`; never a new branch; oss and hub separately; hub changes shown before they land).

**Gate, common to every part** (plus the part's own):
- the part's unit + api tests; per-driver tests it touches (`agentic-assets/data_driver/*/tests`);
- full OSS fast tier + `--long` ONCE, never beside another pytest (`uv run pytest tests/unit
  flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver -q --long`, then `tests/api`);
- snippet tests with the ledger (`FLOW_SNIPPET_LEDGER=…`, every file calling `run_fence`/`run_page`) and the SDK site
  build (refuses an unrun card) when a documented API changed;
- OSS hub tier in a clean worktree, `-p no:randomly`, against the local hub restarted on current code
  (`env -u DEPLOY_ENV -u SOD_ENC_KEY`), when hub-facing code changed;
- hub unit + api tests for touched hub areas (`cd flowpad/hub/tests && uv run pytest …`);
- UI: `npx tsc --noEmit -p tsconfig.app.json` + vitest for touched components;
- the part's **live scenario** (real processes, not doubles), recorded in §Status.

**Invariants:** a secret value is never on a command line, in a log, a transcript, a shipped file or a response;
no new or raised timeout/wait/retry anywhere without the user's approval; no provider name in generic code
(self-contained assets); every traveling shape is a `DataSpec`; entity ids via the minter, lookups not derived ids;
hub restarts use the env scrub; leave peer-session files alone.

---

## Part A — Per-place settings are credential variables

**Why:** a value that differs by where a source runs (WAHA `base_url` / `webhook_url`, a callback host) is config in
`data_source.json`, which travels in the repo — on a box it still points at the laptop. It belongs in the credential
system (a variable per deployment), which already moves values by consent and places them per machine.

**Read first** — docs: `docs/data-management/data-source-asset.md`, `docs/data-management/data-sources.md`,
`docs/snippets/data-sources.md`, `docs/snippets/secret-stores.md` (§5 has a stale `secrets` bullet — fix),
`docs/secret_share.md`, `docs/glossary.md`, CLAUDE.md "Data sources are self-contained", "Data shapes — DataSpec".
Code: `flow_sdk/sources/config.py` (`SourceConfig`), `builtin/data_driver.py` (`create_config`, `config_of`),
`builtin/data_source.py` (`_type_config`, `migrate_list_configs`), `ingest/driver_registry.py` (`check_config`),
`ingest/credentials.py` (`resolve_credentials`, `_declared`), `ingest/driver_runtime.py` (`binding_of`, `open`, the
webhook path), `builtin/readiness.py` (`requirements_of_source`, `_VAR_REF`), `builtin/credential_service.py`
(`use_mine`, `place_values`), `flow_sdk/migrations/` (runner, `migration_2026_09_credential_stores`), drivers waha /
whatsapp / voice_phone, `server/routes/data_source_webhook.py`.

**Functional requirements**
- A-F1 A per-place setting is a credential variable the driver maps in `auth.vars` (a non-secret one declares
  `secret: false`), never `data_source.json` config; the source reads it from its resolved credentials, which are
  resolved per placement (`placement_for_source`). (Revised in Part A's plan: the existing `auth.vars` mechanism,
  not a new `${VAR}` syntax — which fought `best_match`, create-time validation and raw-config classmethods.)
- A-F2 A referenced variable is a requirement of the owning agent (derived like an MCP `${VAR}`): readiness gates the
  deploy on it; "use mine" copies it; the hub places it — no hub change needed (placement is name-driven).
- A-F3 The typed config validates the **resolved** value when the source opens; saving accepts a reference for a field
  the driver declares variable-capable (a `pattern` like rss `feed_url` must not reject `${…}`).
- A-F4 Every reader of a source's config sees resolved values — including classmethod paths that read raw row config
  today (whatsapp `webhook_challenge` via the webhook route).
- A-F5 A missing variable fails the source with a named, fixable error (the variable's name and "set it with …"), never
  a call to a literal `${…}` URL.
- A-F6 WAHA moves `base_url` and `webhook_url` to variables (`WAHA_BASE_URL`, `WAHA_WEBHOOK_URL`) declared by its
  credential; a migration rewrites existing sources: the literal value into this computer's store, a reference in
  the file.

**Architectural requirements**
- A-A1 One resolver: nothing new in generic code — `ingest/credentials.py` already resolves `auth.vars` per
  placement; `check_config` already refuses a config field named like an auth var.
- A-A2 Generic: the driver manifest declares which config fields may be variables; no provider name in generic code
  (`test_data_sources_are_self_contained.py` stays green, no new `EXCEPTIONS`).
- A-A3 Config stays value-free and a `DataSpec`; a reference is a name, never a value; wizard args keep forbidding
  templates (`wizard_spec.py`).

**Tests** — unit: `tests/unit/test_data_source_*.py`, `tests/unit/test_data_source_asset/`, `tests/unit/test_ingest_*.py`,
`tests/unit/test_secrets/test_data_source_bindings.py`, `tests/unit/test_credential_asset/` (readiness derives config
refs; use mine / place move them), a new migration test beside `test_migration_credential_noun.py`; per-driver:
`agentic-assets/data_driver/waha/tests/`, whatsapp, voice_phone; gate: `tests/unit/test_data_sources_are_self_contained.py`;
api: `tests/api/_source_matrix.py` (handshake + signed push with a reference); snippets:
`tests/unit/test_data_sources_snippets.py`, `tests/unit/test_secrets/test_secret_stores_snippets.py`.
**Live scenario:** a real WAHA (local container) source whose URLs are variables: `verify()` registers the resolved
webhook URL; the hub local-node long test (`test_local_node_deployment_secrets.py` pattern) deploys the same repo and
the box resolves its own value.

---

## Part B — Webhooks to compute nodes (B1: a hub feature; B2: deployments define them)

**Why:** providers (Meta, Twilio/OpenAI SIP, WAHA) are configured once with a callback URL. A box's own URL changes
with every sandbox and sits behind its cookie gate. A hub webhook gives a stable public URL relayed to a compute node.

**Decisions (2026-09-27):**
- **No second webhook front door.** The hub's existing public webhook router (`routers/webhook.py`, mounted at
  `/webhook`, public via `PublicApiPaths.WEBHOOK`, CSRF-exempt, dispatching by path; today only `plugin/<name>`) gains a
  compute-node target. What it lacks today is a row: plugin webhooks have none. B1 adds the webhook row, and the
  router dispatches it.
- **Created on the node:** `compute_node/<id>/create_webhook`, requiring the **owner** role on the node (the box's own
  node-bound key is refused).
- **Owned by the user, targeting a node:** it survives node deletion and can be retargeted, keeping its URL.
- **The webhook carries its filters:** match rules (method, sub-path, required headers; a non-match never reaches
  the node) AND routing rules (from the request/payload to the target path on the node, like the plugin's key
  mapping).
- **Paused node:** wake it (as open-service does), then relay.
- **Relay mode is a webhook config item:** synchronous by default (the node's status and body go back to the provider:
  Meta's challenge, Twilio's TwiML); accept-and-queue as the other mode.
- **ServiceEndpoint:** a separate entity. The relay mechanism (streaming to the node's host, the gate header,
  wake/resume, the raw-body path list) is extracted once and used by both, each with its own header policy.
- **B1 and B2 are separate phases.**

### B1 — the hub webhook with a compute-node target (pure hub feature, tested low level)

**Read first** — hub: `routers/webhook.py`, `builtin/plugin_model.py` (webhook + key mapping), `api/webhook_api.py`,
`app/actions/webhook.py` (legacy), `routers/service_endpoint.py` (`relay_http`), `app/services/service_proxy.py`
(header policy), `core/request_context/request_info.py` (`_RAW_BODY_PATH`), `core/auth/authorizer.py` + `config.py`
public paths, `middleware/csrf_origin.py`, `builtin/service_endpoint.py` (`reach`, `wake`),
`builtin/faas/compute_node.py` (`resume`, `_open_service_op`, the gate, `http`), `app/policies.json` (compute_node
roles), hub docs `e2b-sandboxes.md`, `pentesting/attack-surface.md` §14 + T19, `CLAUDE.md`; the peer hub commit
eca7aeeda ("flow-cloud removed"). OSS: `docs/cookie-gate.md`, `docs/snippets/service-endpoints.md`, glossary.

**Functional requirements**
- B1-F1 `POST compute_node/<id>/create_webhook {name, filters, routing, mode}` (owner role on the node) creates a
  user-owned webhook row targeting that node and returns its stable public URL under the existing `/webhook`
  router; `list` / `update` / `delete` / `retarget(node)` (owner only; retarget keeps the URL).
- B1-F2 A request to the URL is matched against the webhook's filters (method, sub-path, required headers); a
  non-match → 404, never relayed. Its routing rules pick the target path on the node.
- B1-F3 Synchronous mode (default): relay method, query, raw body and provider headers unchanged; return the node's
  status, content type and body unchanged. Queue mode: answer 2xx at once, deliver later with retries.
- B1-F4 Node resolution per request: running → relay; paused → wake, then relay; no node → 503 with `Retry-After`;
  unknown webhook → 404.
- B1-F5 The row records delivery counts and the last status (no bodies, no headers) for the owner's list.

**Architectural requirements**
- B1-A1 One public webhook router (the existing one); one relay mechanism shared with the ServiceEndpoint proxy, each
  with its own header policy — the webhook's keeps provider/signature headers and never forwards hub auth or cookies,
  nor lets a node set cookies on the hub origin.
- B1-A2 The hub carries the node's cookie gate; no path is exempted on the box. The webhook path joins
  `_RAW_BODY_PATH` so form bodies arrive intact.
- B1-A3 The hub never parses a body except where a routing rule reads it; logs ids and status only.
- B1-A4 No new or raised timeout (the proxy has none on reads).

**Tests** — hub api (the real-upstream pattern of `tests/api/test_service_endpoint_api.py`, a local-provider node and
a small echo upstream): create/list/retarget/delete; filters match and refuse; routing picks the path; verbatim
sync relay incl. a form post; queue mode; paused → woken; no node → 503; unknown → 404. Hub unit: filter and routing
evaluation, the extracted relay, the raw-body path. Policy/pentest (`tests/api/test_pentest_0923_service_endpoints.py`
pattern): a non-owner and a node-bound key are refused; a cross-owner retarget is refused. The ServiceEndpoint proxy
tests stay green on the shared relay. **Live scenario:** a hub local-node test — a webhook to a real box's data-source
webhook route, a signed WAHA-shaped push through the hub URL, then the webhook retargeted to a new node and the same
URL delivering there.

### B2 — deployments define their webhooks (after B1)

- B2-F1 A deployment declares named webhooks (per data source that takes pushes); the hub creates them (B1) at deploy
  and retargets them to the deployment's current node on redeploy, a new sandbox and resume.
- B2-F2 The URL is placed on the machine as the driver's variable (Part A), e.g. `WAHA_WEBHOOK_URL`, so a driver
  registers it (WAHA `verify()`) knowing nothing about the hub.
- B2-F3 Deleting the deployment deletes its webhooks; provider-side configuration is reported.
- **Tests:** hub unit/api for create-at-deploy, retarget-on-redeploy, delete; **live:** a hub local-node test — deploy
  a WAHA agent, the placed `WAHA_WEBHOOK_URL` is the hub URL, real WAHA delivers through it, redeploy onto a new node,
  delivery continues on the same URL.

---

## Part C — The paid LLMEndpoint on a deployment

**Why:** a deployed agent's model calls must be paid by the hub for its owner, with no provider key on the box, and
the accounting must be visible and enforced. The OSS hub tier's `test_new_user_can_spend` fails today.

**Read first** — hub docs: `docs/llm-endpoint.md` ("How a box gets bound", "Which endpoint funds a spawn", Testing),
`docs/access-model.md`, `docs/e2b-sandboxes.md`, `docs/deploy.md`, `docs/plans/agent-e2e-plan.md`; OSS docs:
`docs/snippets/llm-endpoints.md`, `docs/agentic-process.md`, `docs/collab/cloud-sharing.md`. Code — hub:
`builtin/llm_endpoint.py` (`invoke`, `_forward`, `_gate`, `_book`, `usage_report`, `box_binding`, `ensure_user_default`),
`core/llm/ledger.py` (`BufferedLedger`), `core/llm/stack.py`, `builtin/faas/compute_node.py`
(`setup_llm_endpoint`), `app/actions/token_plan/`; OSS: `flow_sdk/builtin/llm_endpoint.py`,
`instance_settings/llm_endpoint.py`, `cli_drivers/hub_endpoint_binding.py`, `cli_drivers/llm_source.py`,
`cli_drivers/api_auth.py`.

**Functional requirements**
- C-F1 Root-cause and fix `tests/hub_tests/test_new_user_can_spend.py` ("the ledger did not move"). Leads: `hub_get`
  called with shifted arguments (`hub_get("llm_endpoint", {}, id, "usage")`), and `usage` reads only the flushed store
  while bookings sit in the 2 s buffer. Decide in the plan whether `usage` must include buffered bookings (as `totals()`
  does) — a product answer, not a test sleep.
- C-F2 A deployed agent's worker calls go through the hub endpoint bound at workspace-ready (the agent identity gets
  its creator's capped default); the box holds no provider key (env, files, logs).
- C-F3 Every turn books to the right payer and shows in usage / the token plan; an exhausted allowance refuses the
  turn with a named reason that reaches the deployment's conversation or run, not a silent failure.
- C-F4 Readiness at a cloud deployment reports model funding (bound endpoint, allowance) as an item, so a deploy
  that cannot pay for a turn is visible before it runs.

- C-F5 **Token allocation in the deploy dialog** (user, 2026-09-27): a "Token allocation" checkbox with an info
  tooltip.
  - **Unchecked:** the agent draws on its owner's capped default endpoint, which is today's behavior.
  - **Checked:** a root token source / LLM endpoint must be selected (the deploy is refused without one). The
    deployment then gets its **own allocation**: a new endpoint drawn from the selected one through `allocate`,
    granted to the agent's identity and bound to its machine. It is deleted with the deployment, and its spend is
    visible on its own.
  - **Quick fields:** $/day (`limits.cost_usd_per_day`, enforced by the gate) and **one model**, which is both the
    only model allowed (`filters.models_allow`) and the agent's default.
  - **Configure:** opens the existing LLM endpoint editor for that allocation in a tab (every limit and filter);
    the allocation is created first.

**Decided (user, 2026-09-27)**
- Usage includes bookings still in the buffer (saved + pending, the same number the gate enforces), so a turn
  shows at once and C-F1 needs no wait.
- The root-source picker offers only endpoints the user can allocate from (`allocate` is authorized against the
  source). A plain member sees only their own default allowance.
- Deleting the deployment deletes its allocation. Its past spend stays on the root's usage under its name.
- The allocation's model wins on that deployment; `agent.json` is untouched, and the dialog pre-selects its model.

**Architectural requirements**
- C-A1 One booking path (`_book`); no second counter. C-A2 Tests observe bookings by flushing, never by sleeping or
  widening a wait. C-A3 No hub credential or provider key reaches the box.

**Tests** — OSS: `tests/hub_tests/test_new_user_can_spend.py` green; `tests/unit/test_llm_source_resolution.py`,
`tests/unit/test_llm_client.py`, hub-binding unit tests; hub: `tests/llm_harness.py`-based unit/api tests for usage and
refusals; long: `tests/long_tests/test_llm_endpoint_e2b.py`, `test_llm_endpoint_share_e2b.py` (the ledger-assert
template). **Live scenario:** the hub local-node long test deploys an agent, runs one real turn, and asserts the owner's
usage moved and the box carries no key; an exhausted allowance refuses the next turn with its reason.

---

## Part D — The e2b cycle with real providers, and cleanup that leaves nothing

**Why:** the goal itself — the four steps on real e2b with real providers — plus the cleanup gaps the exploration found.

**Read first** — `ops/e2b/flowpad-exec-env/README.md` (local template, ngrok), hub `docs/e2b-sandboxes.md`,
`docs/deploy.md`, `docs/agent-mailbox.md`; OSS `docs/snippets/agents-on-channels.md`, `docs/snippets/agent-deployment.md`,
`docs/secret_share.md` (deleting, sweep), `scripts/instance_ctl.sh`. Code — hub: `builtin/deployment.py` (delete),
`builtin/faas/compute_node.py` (`_shutdown_op`), `core/faas/compute/providers/e2b_provider.py` (`shutdown`, `pause`),
`app/services/deployment_secrets.py` (`revoke`), `external_apis/oauth_lib/oauth_provider_config.py` (`revoke_url`),
`external_apis/sod/leftovers.py`, `builtin/agent.py` (delete, mailbox); OSS: `builtin/credential_sweep.py`,
`builtin/agent_serve.py`, `builtin/deployment_process.py`, the six channel drivers, `sources/base.py`.

**Functional requirements — cleanup (built and unit-tested first)**
- D-F1 e2b shutdown kills by sandbox id even when the provider has not cached it; a failed kill fails the delete.
- D-F2 Deleting a deployment deletes its authorization rows and revokes the provider token where the provider has a
  `revoke_url`; reports where it cannot.
- D-F3 A driver teardown seam (a `Source` classmethod, default no-op) runs on source / deployment delete; WAHA clears
  its session webhook; the deployment's webhooks (Part B) go with it; the agent's AgentMailbox address is deleted at the provider.
- D-F4 The sweep: the e2b leg lists paused sandboxes and any `source` label of the given ids; hub legs for
  authorization rows and webhooks; output is the suite's final assertion.

**Functional requirements — the cycle** (a hub long suite, `MANUAL_TESTING`, `live_hub` fixture)
- D-F5 Rig: a template built from this checkout (`build.sh --local`, `DEFAULT_E2B_VERSION=local-<me>`); the local hub
  with `SERVICE_URLS_CONFIG__EXTERNAL_HOST` = ngrok; a throwaway desktop (`instance_ctl.sh`) signed in to it; GitHub
  connected; the e2b key from the hub's own config. A rig check: the box answers `credentials/drop`.
- D-F6 Step 1 — build: a project repo with one agent owning real channel sources (agentmail, Telegram, WAHA, WhatsApp
  Cloud API, Slack, phone), credentials declared in the project, place-specific values as variables (Part A); every
  channel answers locally (inbound + reply, outbound send).
- D-F7 Step 2 — deploy as is: publish → plan → readiness → use mine → authorize Slack → deploy on e2b; values placed;
  webhooks opened at stable URLs (Part B), configured once at each provider.
- D-F8 Step 3 — validate: every channel answered by the **box** (the local deployment stopped — "who answers" is
  deferred), twice; the credential cycle (placed, used, rotated without redeploy); a redeploy onto a new sandbox keeps
  webhook delivery on the same URLs; model turns paid by the hub (Part C); no value in box logs or transcripts.
- D-F9 Step 4 — remove: delete the deployment (UI and SDK), then the agent and project; the sweep and direct checks
  (e2b list incl. paused, hub SOD and rows, provider token state, WAHA session config, agentmail addresses) show nothing
  left; provider-side settings made by hand are reported.
- D-F10 Inbound traffic: a second account where one exists (a second agentmail address, second Slack identity, second
  Twilio number, second WAHA session); otherwise a prompted send by the user. Each channel records which.

**Architectural requirements** — cleanup fixes are generic (the teardown seam lives in the driver's asset); the suite
tears down what it created even on failure and refuses to start when the sweep is not clean.

**Tests** — hub unit/api for D-F1..D-F3 (`tests/unit`, `tests/api`); OSS `tests/unit` for the sweep and the teardown
seam, per-driver WAHA tests; the new hub long suite `tests/long_tests/test_credentials_e2b_real.py`; existing real
legs reused: `tests/long_tests/test_agentmail_roundtrip.py`, `test_telegram_send.py`, `tests/e2e/whatsapp_serial_demo.py`;
the e2b rig tests `test_agent_places_e2b.py` / `test_trigger_run_agent_e2b.py` (pong fixture moved to `agent.json`).
**Accounts** (the user provides; names only are read): e2b access for the hub, ngrok, `AGENTMAIL_PROBE_INBOX` (a second agentmail address),
`TELEGRAM_TEST_CHAT_ID`, a second Slack identity, a second WAHA test number, Cloud API phone number id + test
recipient, `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` + a second number, `OPENAI_WEBHOOK_SECRET` + SIP project id.

### Part D plan (step 2, written 2026-09-27)

**What Parts A–C and the live runs already give D.**
- A deployed agent's secrets, settings and webhooks are placed on its box.
- Its model turns are paid through a token allocation.
- `test_local_node_*` prove each piece on real local nodes.
- The e2b run (Part C) proved deploy → bind → one turn → usage → delete.

**What the live runs taught (they shape the order).**
- (a) e2b boots the RELEASED template (0.2.170), not this branch. A branch cycle needs a template built from this
  checkout.
- (b) `ProviderE2B.shutdown` killed only a sandbox the hub process still had cached. After a hub restart, a delete
  marked the rows gone and left the sandbox alive, and the old e2b sweep leg saw only running sandboxes. The
  account's 110 PAUSED sandboxes (2026-08-03 onward) are all labelled `environment: production`: the
  production hub's (real users' paused workspaces, same e2b account), not local leaks. They must never be
  reaped by a test or a script of ours.
- (c) The desk cannot list hub endpoints, and the publish checklist blocks Launch for an already-published
  agent. Both stop a pure-UI run.
- (d) The deploy flow has no "who answers" rule. The laptop and the box both answer a channel unless the local
  deployment is stopped.

**Phase D1 — cleanup that leaves nothing** (hub + OSS, unit/api tested, no e2b needed)
1. **D-F1 kill by id.** `ProviderE2B.shutdown(id)` connects when the id isn't cached (`Sandbox.connect`, then
   `kill`), or kills by id through the API. "Not found" counts as done; any other failure raises, and
   `Deployment.delete` keeps the row, as it does today. Test: an uncached id is killed (a fake e2b client);
   the delete refuses when the kill fails.
2. **D-F2 authorizations.** `deployment_secrets.revoke` deletes the `DeploymentAuthorization` rows and calls the
   provider's `revoke_url` when one exists (`oauth_provider_config`). The result names what could not be revoked.
   Test: api test with a fake provider that records the revoke call.
3. **D-F3 driver teardown seam.**
   - `Source.teardown(config, credentials)` is a classmethod on `flow_sdk.sources`, a no-op by default.
   - It runs on source delete and on the box when its deployment is deleted, through a new box call
     `credentials/unplace`-style `sources/teardown` before the machine goes.
   - WAHA implements it: it clears its session webhook, and only the placed URL, never the paired session's
     other config.
   - AgentMailbox address deletion joins the agent delete.
   - Tests: WAHA driver test (fake WAHA); the self-contained gate stays green.
4. **D-F4 sweep.**
   - `credential_sweep._e2b` lists running AND paused sandboxes, filtered by the deployment ids' labels or
     metadata.
   - Hub legs cover `DeploymentAuthorization`, `Webhook` (`deployment_typeid`), allocation endpoints
     (`llm_endpoint_typeid`) and SOD keys.
   - `flow credentials sweep --deployment` prints it.
   - Test: unit, with fakes for each leg.
5. ~~The paused backlog~~ dropped: the paused sandboxes are production's (see (b)). The sweep counts only sandboxes
   attributed to what it checks (`source` = the agent), running or paused.

**Phase D2 — the rig** (reusable, scripted: `scripts/e2b_cycle_rig.sh up|down`)
- Template from this checkout: `ops/e2b/flowpad-exec-env/build.sh --local --size sm`, then
  `DEFAULT_E2B_VERSION=local-<me>` on the hub.
- Hub :8093 with ngrok (the static domain) as `SERVICE_URLS_CONFIG__EXTERNAL_HOST`.
- Desk: `instance_ctl.sh launch cyc-1 --hub …`.
- Rig check: the box answers `credentials/drop` and reports the branch version.
- Fix (c) first, so the cycle runs through the UI:
  - the desk lists hub endpoints: its `llm_endpoint` list and `catalog` reflect to the hub (the funding view
    already does);
  - the checklist treats `remote` + `origin` as published (the backend already skips the publish).

**Phase D3 — the cycle** (hub long suite `tests/long_tests/test_credentials_e2b_real.py`, `MANUAL_TESTING`)
- **Step 1, build.** One agent owns real channels: agentmail, Telegram, WAHA (our own unpaired or second number,
  never the personal one), WhatsApp Cloud API, Slack and phone. Credentials are declared in the project, and
  per-place values are variables (A). Every channel answers LOCALLY.
- **Step 2, deploy as is.** The desk dialog runs publish → plan (webhooks B2, token allocation C) → readiness
  (funding item) → use mine → authorize Slack → Launch on e2b. Values are placed, webhooks are at stable
  URLs, and each provider is pointed at them once.
- **Step 3, validate.**
  - The local deployment is stopped first (d).
  - Every channel is answered by the BOX, twice.
  - A value is rotated without a redeploy.
  - A redeploy onto a NEW sandbox keeps the webhook URLs.
  - Turns are booked on the allocation, and an exhausted cap is refused with its reason.
  - No secret appears in box logs or transcripts.
- **Step 4, remove.** Delete in the UI, then the agent and project. The D1 sweep shows nothing left (e2b incl.
  paused, hub rows and SOD, provider tokens, WAHA session config, agentmail addresses). Provider settings
  made by hand are reported.
- **Inbound (D-F10).** A second account where one exists, else a prompted send. Each channel records which.
- **Order.** D1 first (it makes step 4 provable), then D2, then D3 one channel at a time: agentmail → Telegram
  → WAHA → Slack → Cloud API → phone. The first two need no hand-made provider config.

**Accounts still needed from you** (names only are read): the second AgentMail inbox, `TELEGRAM_TEST_CHAT_ID`, a
second Slack identity, the WAHA test number, Cloud API phone number id + test recipient, Twilio SID/token + second
number, the OpenAI SIP project. Channels without an account stay out of D3 and are reported.

**D3-WAHA run (user, 2026-09-27).**
- **Scope:** a local WAHA project → deployed to e2b through the standard UI → talked to on WhatsApp via the
  "בין" contact (session `default`, eSIM 972557709288) → the box's UI watched while texting.
- **Decided:**
  - pause prod's WAHA channel for the run and restore it after;
  - the personal number is the ONLY allowed sender, this run only, removed after;
  - Claude types the test messages in WhatsApp Web;
  - publish through the hub-hosted repo as it is now.
- **Gaps:**
  - G4, the hub-repo publish hub side, is uncommitted;
  - G5, a template from HEAD;
  - G6, a public URL for WAHA;
  - G6b, the deployment's own `WAHA_BASE_URL`;
  - G8, only the box answers;
  - G9, a box answering channel messages is unproven;
  - G11, the box's thread view.

**Remaining decision for you before D3:** "who answers a channel" stays deferred (the plan stops the local
deployment), or gets a rule now.

---

## Status (kept current; each part's step 4 updates it)

| Part | State | Commits | Live scenario |
|---|---|---|---|
| Previous plan 1–3 | DONE | oss d3c481e99..172986348, hub ac5515f3b..45a2f66d0 | local node: placed / rotated / wiped |
| A vars | DONE 2026-09-27 | oss 6579ec273, hub 5510f60e4 | real WAHA (own unpaired container): boot lift moved the URLs out of `data_source.json`, verify registered the moved `WAHA_WEBHOOK_URL`, signed push ingested / bad signature 401; local node: the box registered the DEPLOYMENT's URL on WAHA (`test_local_node_place_settings.py`) |
| B1 node webhooks | DONE 2026-09-27 | hub 8ae6188d6, oss glossary | two real local nodes: a WAHA-signed push through the hub URL ingested on the first; an unsigned one refused by the webhook's filter; retarget → the same URL delivers to the second, the first gets nothing (`test_local_node_webhook.py`) |
| B2 deployment webhooks | DONE 2026-09-27 | oss d9ee0e8b3, hub 4f437523e | real local node + own never-paired WAHA: nobody stored `WAHA_WEBHOOK_URL`; the hub kept the deployment's webhook, stored its URL, placed it; placing verified the box's source, which registered the hub URL on WAHA; a signed push through it ingested on the box; the deployment's delete → the URL 404s (`test_local_node_deployment_webhook.py`) |
| C LLM | DONE 2026-09-27 | oss 24bac9bfd + 6f126a318, hub 24e9c744b + c2e44efdb | e2b via the desk dialog on a local hub over ngrok: a deployment's own allocation ($2/day, haiku) bound on the box, one real turn booked on it ($0.044, owner default 0), usage in the hub UI, delete removed allocation + sandbox; real `claude -p` against a spent allocation stops in 3.8s with the named limit; a brand-new user's spend moves the ledger (`test_new_user_can_spend`) |
| D e2b + cleanup | D1 + the lifecycle cycle PASS 2026-09-27; channel legs (D3) need accounts | oss 84ecd9893, hub e130a6d4c + 3540cf27a | real e2b, template built from this checkout (`flowpad-exec-env-local-shlom-cyc-sm`, flowpad 0.2.177+localcyc1): plan (secret, token allocation, webhook) → deploy → placed, bound, a real paid turn → a value rotated and re-placed while running → a NEW sandbox keeps the webhook URL → delete → hub leftovers empty, no sandbox running or paused, webhook 404 (`test_deployment_cycle_e2b.py`, 80 s) |

**Remaining issues** (carried; each part adds its own):
- (D) Done and proven: D-F1 (kill by id), D-F2 (authorization rows go; nothing to revoke at the provider — the box
  only held short-lived tokens from the owner's connection), D-F3 teardown seam + WAHA (unit; no live WAHA on a box
  yet), D-F4 sweep sees paused sandboxes + `deployment_leftovers`, D-F5 rig (local template, tunnel, test hub).
- (D) Open: the real-channel legs (D-F6..F10) — each needs its account from you (second AgentMail inbox, Telegram
  test chat, second Slack identity, WAHA test number, Cloud API recipient, Twilio second number, SIP project). The
  AgentMailbox address is still NOT released when an agent is deleted (a deliberate explicit verb today) — decide.
- (D) Found by the cycle and fixed: the exec-env image was python:3.10 under a 3.11 floor (no release template since
  would build); a redeploy onto a new machine hit the ServiceEndpoint id constraint.
- (D) The e2b account is shared with production: its 110 paused sandboxes are production workspaces; the sweep
  attributes by `source`, and nothing of ours reaps by account.
- (D) Rig gaps not fixed yet: the desk cannot list hub endpoints (UI-only runs), the publish checklist blocks an
  already-published agent.
- (C) A brand-new user spends the uncapped global root directly (the catalog's `authenticated_role` stamp), not a
  capped default — `test_new_user_can_spend` records it as "uncapped". A deployed agent is capped (its allocation or
  its creator's default); a human with no default yet is not.
- (C) The model pin moved to the hub (`aliases_for_pinned`) after the live e2b run; the live run proved the older
  box-side override. The alias pin is unit-proven (`resolve_alias` redirects the family) and needs nothing on the box.
- (C) The funding check proves the allocation's model and the owner default's agent model; codex/opencode reaction
  to a 429 refusal was not measured (claude's was: no retry, the reason shown).
- (C) `setup_llm_endpoint` still looks the placement up with `Deployment.for_compute_node` (a scan of agent
  deployments) on each workspace-ready of an agent box — the pattern `_deployment_login_principal` already had;
  a node→deployment index would remove both.
- (C) /simplify skips: `SourcePicker` reuse for the dialog's source select (it takes `LLMEndpoint`s, the dialog
  has funding offers); a `plan_deployment` response carrying funding (saves one round trip per deploy).
- (C) Gate: two OSS fast-tier failures (`test_agent_terminal_reuse`, `test_voice_channel_matrix`) passed alone —
  load from a hub tier run beside it.
- (C) A desk cannot list or open hub endpoints (its `llm_endpoint` list is local and `catalog` 422s): the LLM
  Endpoints screen is empty on a desk and Configure opens a page showing only the id; usage is read in the hub UI.
  The dialog's picker uses the funding view (`can_administer`).
- (C) The deploy dialog's publish checklist demands GitHub even for an already-published agent, so Launch stays
  disabled there; the live run made Launch's own SDK call.
- (C) e2b boxes run the released template (0.2.170): no box-side "bound model wins" (the live run used the agent's
  own model) and no `agent.json` (the throwaway repo carried an `agent.md` too).
- (B2) A deployment's webhook has no node of its own: it delivers to whatever machine its deployment has now, so a new
  sandbox needs no retarget (unit-proven; Part D's e2b cycle exercises a fresh sandbox live).
- (B2) /simplify skips: re-verifying received sources on every credential write (not only hub placement) — a laptop
  still presses Verify, by the received-source rule; verifying only sources whose values CHANGED (every re-place
  re-verifies); authored drivers not yet loaded are not in `DRIVERS`, so their sources are not re-verified at
  placement; `WEBHOOK_ROUTE` is a third copy of the frozen route (the router's prefix serves other routes too);
  treating a driver's webhook URL as a placement-provided value instead of a stored credential variable.
- (B2) Seen in the gate, passes alone: `tests/unit/test_conversation_project_binding.py::
  test_bound_conversation_auto_installs_on_receive` — `database is locked` under the full run.
- (B2) WhatsApp Cloud API and voice_phone declare no `webhook` (their callback URL lives in the provider's dashboard):
  their owners set the hub URL there by hand; a driver-owned "register my URL" seam would automate it.
- (B2) Placing now verifies the sources that read placed values (a provider round trip per source); an unpaired
  provider leaves the source in setup with its detail reported, never fatal. The agent answers only an ACTIVE source,
  so a real channel still needs its provider side done (WAHA paired, etc.).
- (B2) A webhook the deploy no longer asks for is removed, but its stored URL variable stays in the deployment's store.
- (B2) Readiness items now carry `missing` (which of `vars` the store lacks): "use mine" copied a whole credential's
  vars before, which would have overwritten the hub's webhook URL with the laptop's.
- (B1) No abuse limit on a public webhook URL yet: anyone who can post to it can wake a paused (paid) machine and fill
  a queue-mode webhook's pending deliveries. A body-size cap and a per-webhook rate limit were proposed and not
  decided.
- (B1) Queue mode redelivers on events only (the next delivery, the node resuming, a retarget, hub boot) — a timed
  retry needs the user's approval (no new retry/backoff loop without it).
- (B1) /simplify skips: `wake` stays in `builtin/service_endpoint.py` (a reviewer suggests `ComputeNode.ensure_awake`,
  since `flow.py` uses it too); the router still sniffs `<webhook id>` in its catch-all (two typed routes would turn
  the legacy "Skipped" 200s into 404s); a gone node answers 503, not 410 (a webhook may be retargeted); the resume
  hook stays in `ComputeNode.resume` (single-flight drains made it safe); queued bodies are base64 in the row (a
  blob store would be leaner); a shared dot-path reader with `oauth_test._read_path`.
- (B1) Pre-existing hub api failure, failing at clean HEAD too: `tests/api/test_shell_tool_and_command.py::
  test_shell_via_use_tool_streaming` (ConnectError).
- (B1) Deleted as dead: the legacy `app/actions/webhook.py` action, `api/webhook_api.py`, `Plugin.get_by_hook_id`.
- (A) The boot lift runs once per instance (a stamp in the instance config): a row cloned in later carries another
  machine's value, which must not become this one's, so its stale keys stay in the file as dead weight the `Config`
  ignores. Stripping them where the file becomes a row (`DataSource.save`'s index path) would clean them.
- (A) /simplify skips: authored drivers are not in `DRIVERS` at boot (they load lazily), so an authored driver that
  moves a field is not lifted; `cache_root` (gcs, gdrive) and `voice_file.folder` are per-machine paths still in
  config; the hub long test writes the store directly (the hub store types every value as a confidential key by
  design); a shared GitHub `put_file` test helper (three copies).
- (A) `waha/README.md` still documents the URLs as config — another session has uncommitted edits to it; update after
  those land.
- (A) Pre-existing failures seen in the gate, failing at clean HEAD too: `tests/unit/test_rag_observer.py::
  test_markdown_runs_both_observers`, `tests/api/test_source_cli_matrix.py::test_types_and_list_answer`; plus another
  session's untracked red test `tests/unit/test_agentic_process/test_transcript_prompts_reuses_streamed_transcript.py`.
- (A) The live WAHA check used a separate never-paired container: the running `waha` container's only session is paired
  to a real number and points at :9007 — a live test must never re-point it.
- Who answers a channel (both laptop and box answer a source without `answer_place`) — deferred; Part D stops the
  local deployment.
- Shared use-only grants for teammates (R3.6) — deferred.
- DataSpec rule: hand-rolled dicts in the drop file, place/unplace/use-mine answers, inventory, the 409 payload.
- `flow agent deploy` adds a 600 s HTTP budget (`DEPLOY_SECONDS`) — awaiting the user's ruling.
- /simplify skips: the hub deriving `require` itself; a batch env-var write; `HubStore.load` returning `{}`;
  `for_compute_node` full scan; inventory loads every event; `running_node` trusts cached state; local revoke POST
  flag vs hub DELETE; one adopt/rekey carrying the environment.
- e2b auto-pause snapshot keeps placed values; the agent can read placed values.

## D3 live run 2026-09-27 — WhatsApp on e2b

**WAHA: live.** Phone → WAHA → hub webhook (ngrok) → e2b box → agent turn → reply on the phone ("(from e2b)"),
thread live on the box's deployment page. What it took (fixed):
- F1 hub: an agent Identity's listing was always empty (the walk started at a `User` node) → the box dropped the
  hub-bound LLM endpoint on every status refresh → "no usable LLM source". Hub 8313962c1 (+ test).
- F2 oss: `tags/relay.py` posted without the cookie-gate header → the box's app refused every relay → no live UI.
- F3 oss: `discovery/notify.py` notifications posted without the gate header → refused on a gated box.
- F4 oss: a turn stamped STARTED whose worker never came up waited for a transcript that never appears →
  never retried. F2–F4 landed inside fba137231 (swept in by a peer commit from the shared tree).
Open:
- G13 the hub-repo publish carries only the agent folder: its channels (`data_source`, embedded transport) and
  credential never reach the box — the WAHA channel was added in the box's UI by hand.
- G14 the desk's Open link is a bare hub URL; a browser without a hub session gets the hub's local auto-login
  (machine user) → "no access", no login screen. Fix: Open goes through the desk (its hub key → open-service →
  the box's gate URL).
- G12 `allowed_senders` is row-only (worked around: set on the box's channel).
- The deployment page on the box shows its own place as "Development · local".

**WhatsApp Cloud API (official) — gaps before the same run:**
- C1 the stored Meta token is a 24 h temp token, expired 2026-09-16 → a new token (a System User token for a
  deployment that must outlive a day).
- C2 the driver declares no `webhook` block: its callback URL lives in Meta's app config, not in `auth.vars`, so
  B2 cannot declare it (the validator requires an `auth.vars` key) → no hub webhook is made for the deployment.
- C3 Meta's GET `hub.challenge` handshake carries no signature header; a hub webhook's `required_headers` apply to
  every method → it must be POST-only on the header (or none), methods `GET`+`POST`.
- C4 one callback URL per Meta app: pointing it at the deployment's hub webhook takes it from wherever it points
  now; re-registering is `POST /{app_id}/subscriptions` with the app token (outward-facing).
- C5 the test number only messages pre-registered recipients; the person texting it must be on that list.
- G13 applies (the channel must be created on the box).

**2026-09-28 (after a reboot ended the e2b box):**
- G15 FIXED hub 385743e76: a redeploy reused a node whose sandbox the provider had ended (NOT_FOUND), placed
  nothing, answered success → now drops it and boots a new box for the same placement (store/webhooks kept).
- G16 the local hub's hosted git repos live in `$TMPDIR` (`git_storage_mount_folder`) → wiped at boot while their
  rows survive → "could not clone the project repository" (rig; restored from the desk's mirror).
- G17 the desk shows a cloud place "On" after its machine is gone, and offers only Pause/Delete machine — no
  redeploy for a dead machine in the UI.
- C3 is not a gap for a hand-made hub webhook (no required header): Meta's GET handshake answered through
  hub → box (`hub.challenge` echoed, 200).
- G18 a picture sent on WhatsApp did not reach the agent on the e2b box (the caption did): the box's template
  predates the channel-files feature (2cf4d00bc..) → rebuild the template from HEAD for picture turns.

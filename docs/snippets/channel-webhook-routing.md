---
id: 6b24748e-5b14-42c4-ad98-cda4a1ff9173
version: 2
---
# Channel webhooks: from WhatsApp to an agent

This guide connects Flowpad's channel, hub and deployment contracts using the `whatsapp`
driver for Meta's WhatsApp Cloud API. A **channel** is a `DataSource` whose driver can send;
an agent owns it, a webhook delivers to it, and a running deployment answers it.
Claims, placement and admission below are Flowpad behavior, not Meta API concepts.

Start with [agent and credential creation](agents-on-channels.md). The Python example below
is run as written by `tests/unit/test_agents_on_channels_snippets.py`. Routing and setup are
also pinned by `tests/unit/test_data_source_route.py` and
`tests/unit/test_data_source_setup_step.py`.

## 1. Choose the channel and account

| Driver          | Account and reply path                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp`      | Your business number on Meta's Cloud API. The receiving machine holds its credentials and sends replies through Graph.                                                                        |
| `flow_whatsapp` | Your phone linked to Flowpad's own number. Its connection wizard proves the sender with a link code; replies go through the hub. It is not a replacement for your own business-number source. |

For `whatsapp`, config holds `phone_number_id` (Meta's account identifier, not the display
phone number), `app_id`, `waba_id` and `verify_token`. The source's `allowed_senders` holds
the permitted sender IDs; this driver's current parser and configuration use digits-only
WhatsApp phone IDs. `group` is empty for the account source or holds a group ID verbatim.
Leave `base_url` empty to use Meta's Graph host; the driver currently pins `v23.0`.
These are the implemented driver's capabilities, not a promise to support every newer API feature.

The driver's `whatsapp` credential maps `access_token` to `FLOW_WHATSAPP_TOKEN`,
`app_secret` to `FLOW_WHATSAPP_SECRET`, and `webhook_url` to `FLOW_WHATSAPP_WEBHOOK_URL`.
Store secrets through the [credential/store contract](secret-stores.md), not config.
Bind the appropriate store to each source when several accounts use the same variable names.
The receiving deployment needs its own accessible credentials for replies and media downloads;
proving an account to the hub does not provision the deployment's secrets.

Meta's [webhook authentication reference](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/)
(archived official SDK documentation) describes the challenge response and app-secret signature.
Its [Cloud API reference](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
describes the provider endpoints. Consult Meta for current account eligibility and API availability;
the routing rules in this guide are implemented by Flowpad.

## 2. Choose the delivery path

| Path                                                          | Receiving endpoint                        | Authentication and identity                                                                                                           |
| ------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Direct provider callback, or a generic hub deployment webhook | `/api/v1/data_source/webhook/whatsapp`    | Original raw body and vendor signature; routes each account/group in the batch. An optional `source_id` query targets one connection and its same-owner groups. |
| Hub account/user/group claim chain                            | `/api/v1/data_source/{source_id}/webhook` | The hub verifies the original signature, splits the batch and targets an existing source by ID.                                       |

The claim path is:

```text
Meta → account claim's public URL → most specific matching claim
     → desktop hub socket or compute node → source-ID endpoint
     → ingestion → conversation → owning agent's deployment loop → Graph reply
```

A deployment webhook is not an extra automatic hop in this chain. Generic deployment
webhooks follow their deployment's current machine and retain their URL; chain node targets
name a compute node explicitly. After a node replacement, inspect and update a chain's target.

The hub is the trust boundary for split deliveries: Meta's original signature does not cover
the new per-event body. The source-ID route calls `ingest_pushed(..., verified_by_hub=True)`;
it relies on the instance's hub socket replay or the node's cookie gate. Do not expose this
route as a public provider callback or treat a client-supplied chain header as authentication.

## 3. Set up the account before its parts

1. Save the agent and its `whatsapp` source with `owner=agent`. Save before claiming: the
   target must name a real source ID. Supply config and credentials from §1 and an explicit
   account allowlist. The existing WhatsApp setup wizard handles provider setup; it also has
   test-message steps that contact the configured recipient.
2. For hub delivery, sign the instance into the hub. Run `await source.step("public-webhook")`. For this driver
   it proves an `account` claim under `@whatsapp`, includes its app secret and verify token,
   targets this desktop's `instance_uid()` and source ID, and stores the returned callback URL.
   A missing verify token is generated. Inspect the returned `exit_code` and `detail`; HTTP
   200 from a step action alone does not mean the step succeeded.
3. Run `await source.step("subscribe")` once the app, number, WABA and callback are set.
   This registers the number's callback override and WABA subscription. It preserves an
   existing app-level callback; a new app gets its initial subscription. Meta's challenge
   must succeed. `await source.verify()` verifies credentials/account access and activates
   the source; it does not prove that a real inbound message reached it.
4. Add user/group child claims only after the account claim exists. Select the delivery
   destination (§5), put the same source ID and required credentials there, and run the
   owning agent's deployment. For this computer use `await agent.run_locally()`; cloud
   deployment and readiness are covered in [agent deployment](agent-deployment.md).
5. Confirm an allowed inbound message is stored on this source, produces an agent turn,
   and receives a reply. Check these separately (§6).

For local direct delivery, replace the hub step with
`await source.step("public-webhook", values={"delivery": "direct"})` through the backend action.
The callback is returned as `value.shown.link` and saved to the same driver URL credential;
no hub sign-in is needed. The source remembers this transport choice. The signed-provider-only
listener preserves its port across restarts and leaves the main API gate intact. It exposes no
hub-trusted source-ID route. Callback `source_id` scopes both challenge and delivery to the chosen
connection; stale IDs never fall back to another source. See the
[data source asset contract](../data-management/data-source-asset.md) for listener configuration.

For manual hub wiring, `POST /api/v1/graph/webhook/chain` accepts `parent`, `claim`,
`proof` and `target`. An account request uses `parent: "@whatsapp"`,
`claim: {"kind": "account", "key": PHONE_NUMBER_ID}` and
`proof: {"credential": ACCESS_TOKEN, "app_secret": APP_SECRET, "verify_token": VERIFY_TOKEN}`.
The returned account URL is what the provider calls. Keep proof values out of logs and files.

A child uses the account claim ID as `parent` and either
`claim: {"kind": "user", "key": SENDER_ID}` or
`claim: {"kind": "group", "key": GROUP_ID}`. The caller must own that account;
these children need no new proof. A group directly under the root is refused.
Do not confuse this with a root-level `user` claim, which uses the hosted channel's link-code flow.

Every desktop/node target requires `data_source_id`. A desktop target is
`{"kind": "desktop", "instance_id": INSTANCE_UID, "data_source_id": SOURCE_ID}`;
a node target is `{"kind": "node", "node_typeid": "compute_node-<uuid>", "data_source_id": SOURCE_ID}`.
Claim creation without a target is not an agent connection. Matching descends to the most
specific claim (`user` before `group` before `account`), then uses the nearest target above it.
A sender claim can therefore take that person's messages in a group ahead of the group claim.
Account children match only their account's events. Separate configured destinations can
receive copies; this is not globally exclusive routing.

## 4. Give a group its own source

The group source's `group` is the provider's group ID, never a title or a participant's phone.
It shares the number's callback and credentials, and claims the group under the account.
It does not subscribe a second provider callback. The source's natural key includes the
account part, so saving it does not replace the account source.

Given a saved `account_source`, a saved `agent` and `GROUP_ID` from the provider:

```python
from flow_sdk.builtin.data_driver import DataDriver

driver = await DataDriver.get("whatsapp")
group_source = driver.create_source(
    driver.create_config(**{**account_source.config, "group": GROUP_ID}),
    name="Support group",
    owner=agent,
    secret_store=account_source.secret_store,
    allowed_senders=[],  # for a group: every participant; use a list to restrict it
)
await group_source.save()
claim_result = await group_source.step("public-webhook")
if not claim_result.ok:
    raise RuntimeError(claim_result.detail)
verdict = await group_source.verify()
if not verdict or not verdict.get("ready"):
    raise RuntimeError("Group source is not ready; inspect its setup status")
```

The group must already exist and its account must already be claimed. This example does
not create a group, deploy an agent or prove delivery. A group message keeps its participant
as author, but its conversation and replies address the group. Use `source.reply_spec`,
`m.reply` or `Conversation.send` rather than constructing a reply to the author yourself.

An active account source with an empty allowlist admits nobody to the agent. An active
group source with an empty list admits every participant; a nonempty list restricts either
source. A disabled source admits nobody. Routing selects the channel; admission decides
whether its agent answers. Allowlist values are private runtime data and must be configured
on the answering machine, not assumed to travel in the shared source config.

## 5. Delivering somewhere and answering there are separate

On the instance, `GET /api/v1/graph/data_source/{id}/route` returns the claim, available
places, current destination and additional destinations. `POST` to the same prefix's
`set_route` with `{"place": "this"}` or `{"place": DEPLOYMENT_ID}` updates the claim's
target. The cloud place must belong to the source's owning agent and have a compute node.
This changes neither the provider callback nor `answer_place`, and does not copy the source.
The target instance must hold the same source ID; otherwise delivery returns 404.

`answer_place` is a **Deployment ID**, not a node or webhook ID. Set it and save the source
to select the deployment that answers; ensure receiving copies carry that setting too.
If unset, each running deployment holding the source may answer there. The email channel
has its own `email_place` fallback. There is no local-only default for WhatsApp.
`add_route` adds a destination rather than moving one; do not use it when only one answer
is intended. Its root-level sibling-claim implementation is not a recipe for group children;
keep a group's account parent when wiring additional group claims manually.

Planning a cloud deployment can also provision a generic per-driver webhook and its URL
credential. That does not establish or move a user/group claim. For an existing chain,
keep the account's provider callback aimed at that chain instead of repointing it to a
generic deployment webhook during another subscription setup.

## 6. Diagnose each stage separately

| Evidence                                      | What to inspect next                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Account proof or callback handshake fails     | Account ID, token access, app secret, verify token and the step's returned detail.                                        |
| Claim exists but nothing arrives              | Hub `GET /api/v1/graph/webhook/mine`; target, parent, competing user claim, connected desktop instance or available node. |
| Source-ID delivery returns 404                | Driver availability and the exact source ID on the destination. Node routing counts this as a misroute.                   |
| Generic callback succeeds with zero ingestion | It can acknowledge an unknown account without storing anything; inspect its response/log and account source lookup.       |
| Message stored but no turn                    | Source active state, sender admission, owning agent, serving deployment, `answer_place`, and harness/LLM readiness.       |
| Turn completed but no reply                   | Outbound credentials on this machine, Graph reachability and the recorded send outcome.                                   |

Read stored items with `SourceItem.get_all({"data_source_id": str(source.id)})`; inspect the
agent's conversation/process and outbound result independently. A webhook response is not
an acknowledgement that the model answered.

The chain stores routing metadata and bounded in-memory deduplication IDs, not a durable
body queue. Offline delivery produces 503 for provider retry. On the desktop leg, successful
socket notification is treated as handoff before local replay finishes; the later replay ack
does not give the chain a durable queued body. On the node leg, 404 is a misroute and
5xx/transport failure is retryable; other statuses below 500 currently count as taken.
These are implementation limits, not an end-to-end or exactly-once delivery guarantee.
Generic queued webhooks are a separate mechanism; do not transfer their guarantees to claims.

The driver ingests supported text, button/interactive replies and media. Reactions update
state rather than creating a new agent message. Delivery statuses do not become messages;
the hub can route group lifecycle events, but this driver does not project those events
into conversation membership/title records or agent turns. A successful response to an
unsupported event may therefore store nothing.

## Implementation references

* [Source setup and route actions](../../flow_sdk/builtin/data_source.py): `step`, `_public_webhook`, `_hub_claim`, `set_route_action`.

* [Receiving routes](../../flow_sdk/server/routes/data_source_webhook.py): provider signature versus source-ID delivery.

* [WhatsApp driver](../../flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/whatsapp/source.py): `hub_claim`, `account_part`, `events_from_webhook`, group reply addressing.

* [Agent admission and placement](../../flow_sdk/builtin/agent_serve.py): `admits`, `answers_here`.

* Hub source checkout: `docs/webhooks.md`, `flowpad/hub/app/services/webhook_chain.py` and `webhook_providers/meta_whatsapp.py`. These are in the hub repository, not this SDK checkout.


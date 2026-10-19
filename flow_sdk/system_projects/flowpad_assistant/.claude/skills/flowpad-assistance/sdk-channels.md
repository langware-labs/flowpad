# Flow SDK channel documentation map

Use this map for questions about webhook delivery, account/user/group claims, channel
admission or the deployment that answers. Read only the relevant sections; do not begin
by searching the whole filesystem or treating a messaging integration as record CRUD.

## Locate the documentation

These references require a **Flowpad source checkout**. All `docs/...` paths below are
relative to that checkout's root, not the user's agent project or this skill directory.
In the source tree, this skill lives under
`flow_sdk/system_projects/flowpad_assistant/.claude/skills/flowpad-assistance/`;
walk up to the root containing both `flow_sdk/` and `docs/snippets/`.
For an installed copy, first check the checkout already identified in the session. If none
is known or the guide is absent, ask for the checkout path. Do not invent a docs location,
assume a wheel includes repo docs, or silently substitute an unrelated checkout.

## Read by question

| Question | Checkout-relative reference |
| --- | --- |
| How does a WhatsApp message reach the agent? Which driver and credentials? | `docs/snippets/channel-webhook-routing.md` §§1–3 |
| How do user/group claims, group replies and allowlists work? | `docs/snippets/channel-webhook-routing.md` §§3–4 |
| Where does delivery go, and which deployment answers? | `docs/snippets/channel-webhook-routing.md` §5; `docs/snippets/agent-deployment.md` |
| A webhook succeeds but the agent is silent; what proves delivery? | `docs/snippets/channel-webhook-routing.md` §6 |
| Create the agent/source or run my own answering loop | `docs/snippets/agents-on-channels.md` |
| Reply with files, quotes or reactions | `docs/snippets/message-channels.md` |
| Bind credentials to a source or placement | `docs/snippets/secret-stores.md` |
| Understand driver declarations or ingestion internals | `docs/data-management/data-source-asset.md`; `docs/data-management/data-sources.md` |

The canonical routing guide links the code that defines each contract. If code and docs
disagree, cite both and report the discrepancy; do not invent missing APIs. Hub internals
live in a separate hub checkout, whose `docs/webhooks.md` is named by the guide; request that
checkout only when implementation-level hub work needs it.

The examples use the official provider API contract and describe Flowpad-specific routing
separately. Third-party API emulation, pairing and service configuration belong in that
service's documentation. For implementation, retain the existing handoffs: `agent-builder`
owns agent creation and deployment, and `connect-data-source` owns source connection and
verification. A documentation question alone does not authorize connecting or sending.

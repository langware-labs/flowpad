---
id: a16f7ad9-19c9-41b7-88bb-8f06f3f27735
---
# A WhatsApp agent, end to end — credential from `.env.local`, conversation in the stream inbox

precondition: an instance is up (`scripts/instance_ctl.sh launch dev-1`) with this checkout's
project (`flowpad-oss`) indexed, and a public tunnel to its backend. The checkout's `.env.local`
holds `FLOW_WHATSAPP_TOKEN` and `FLOW_WHATSAPP_SECRET` for a Meta app's WhatsApp test number, and
the tester's own WhatsApp number is an approved test recipient, signed in at web.whatsapp.com.
Nothing secret is typed into any form and nothing secret is printed.

Run by an agent with browser control (Chrome MCP): WhatsApp Web cannot be driven headless without
the tester's own session, so this is a checklist run, not a Playwright spec. Record results under
`ui/tests/manual_regression/_results/<date>/whatsapp_agent_e2e.json`.

What this proves: a message source's credential is DECLARED (a SecretPack in the agent's
project) and FOUND (the project's `.env.local`) without being pasted into the source; a person on
WhatsApp drives the agent through the agent's local deployment; the answer comes back on WhatsApp;
and the agent's stream inbox holds the conversation with each side attributed correctly.

test 1: The credential is declared, not pasted
- [api] POST /graph/compute_node/@local/credentials/save {scope: project, project_id: <flowpad-oss>,
  manifest: {name: "whatsapp", vars: {FLOW_WHATSAPP_TOKEN, FLOW_WHATSAPP_SECRET}}} — no `values`
- [api] GET /graph/compute_node/@local/credentials/status?project_id=<flowpad-oss> → the
  `whatsapp` credential reports both variables as set (names only)

test 2: The agent lives in that project, and its answer is checkable
- [api] POST /graph/agent {name: whatsapp-e2e, project_id: <flowpad-oss>, system prompt: reply
  `KEY-<TEXT UPPERCASED, SPACES AS DASHES> | turn <n>`}
- [browser] {APP_URL}/dock/agent/<agent id> — the profile shows the local place

test 3: The channel is the agent's, with no secret in its config
- [api] POST /graph/data_source {provider: whatsapp, owner: agent-<agent id>, config: {phone_number_id,
  verify_token}, inbound_allowed_senders: [<tester>]} — access token and app secret NOT in config
  (the dialog's verify-token field is a token the checklist agent may not type; a person can use
  agent place → Channels → Add channel → WhatsApp with the same fields)
- [browser] agent place → Channels lists the WhatsApp channel with the WhatsApp glyph, enabled
- [api] POST /graph/data_source/<id>/verify → `ready: true`, "Sending as +1 555-…" — proof the
  token was read from the declared credential
- [api] register the webhook (Graph `/{app-id}/subscriptions`, fields `messages`, callback
  `<tunnel>/api/v1/data_source/webhook/whatsapp`) → `success: true` — Meta's handshake reached us

test 4: One turn
- [browser] web.whatsapp.com → chat with the test number → send `alpha one`
- [browser] within 60 s the chat shows `KEY-ALPHA-ONE | turn 1`
- [api] the source's items: the inbound `alpha one` from the tester's number, the outbound reply
  from the business number

test 5: The agent stream inbox attributes both sides
- [browser] {APP_URL}/dock/agent/<agent id>/stream_inbox → one WhatsApp conversation (WhatsApp glyph)
- [browser] open it: `alpha one` is from the tester (WhatsApp sender), the reply is from
  whatsapp-e2e (the agent), in that order
- [api] FlowMessage rows of that conversation: sender `whatsapp:<tester>` then `agent:<agent id>`,
  both with `origin.kind == "whatsapp"`; the conversation `owner` is `agent-<agent id>`

test 6: Ten turns, one conversation
- [browser] send `turn two` … `turn ten` one at a time, each after the previous answer arrived
- [browser] every answer echoes its own message as a key, and `turn <n>` counts 2…10 — the agent
  keeps one session per WhatsApp chat
- [browser] the agent stream inbox still shows ONE conversation with 20 messages, alternating tester/agent

teardown: disable the source (keep the credential declaration; it holds no value).

---
id: 6083d921-ef25-47d1-9b27-fa7195009079
---
# Stream inbox channel matrix — owner × channel, in the browser

precondition: an isolated instance (`scripts/instance_ctl.sh launch mx-8`) served from a
PRODUCTION UI build (`npx vite build --mode mx-8 --outDir <scratch>` + `vite preview --port 5018`;
the shared Vite cache is clobbered by other sessions' dev servers); the local hub restarted with
`AGENT_MAILBOX_ENABLED=true AGENT_MAILBOX_PROVIDER=local`; the channel doubles process
(`FLOW_INSTANCE=mx-8 FLOWPAD_HUB_URL=http://localhost:8093 uv run python tests/e2e/channel_doubles.py
--backend http://localhost:6009`), which hosts every driver's `Double` (loopback Gmail IMAP/SMTP, Slack, Meta Graph,
Telegram Bot API; the hub's own local mailbox provider for agent email) and plants the credentials
each driver resolves them with. `channel_matrix.md.ts` does all of this but the instance, the build
and the hub.

What is being proved, per cell: a message arriving on that channel lands in THAT owner's stream inbox
and nobody else's; the row wears the channel's source chip and the channels bar shows its mark;
the conversation's composer replies "in <Channel>"; the reply leaves through the channel (the double
records it) — as the agent's persona on an agent cell.

| owner \ channel | gmail | slack | whatsapp | telegram | agent email |
|---|---|---|---|---|---|
| user (`/dock/stream_inbox`) | test 1 | test 2 | test 3 | test 4 | n/a — an agent email address is an agent's by definition |
| agent (`/dock/agent/<id>/stream_inbox`) | test 5 | test 6 | test 7 | test 8 | test 9 |

Setup, once: `[api]` the local user (`GET /graph/user`, `uname == local`); an Agent created locally
(`POST /graph/agent {name, worker_type}`) and `POST /graph/agent/<id>/allocate_mailbox` (the backend
provisions it on the hub under the instance's own login — never a second hub login for that user, it
rotates the instance's token; its `cloud_email` source is born owned by the agent); the doubles'
`POST /agent_mailbox {agent_id, address}` (the outsider that writes in) and `GET /channels`.

test N (every cell, the same steps):
- [api] `POST /graph/data_source` with the double's `config` (+ `secret_store` for gmail), `owner`
  = `user-<id>` or `agent-<id>`, `inbound_allowed_senders` = `[]` (an agent cell must not spawn a
  real worker turn; the runner refuses a stranger and the projection still lands); `POST …/verify`
  (Slack and WhatsApp are born in `setup`)
- [api] doubles `POST /deliver {channel, text: "hello <nonce>"}` (a Meta webhook delivery is signed and
  posted to `/api/v1/data_source/webhook/whatsapp`; the others are queued for the next poll), then
  `POST /graph/data_source/<id>/sync`
- [browser] the OWNER's stream inbox: a `stream-inbox-conversation-row` carrying the nonce; its
  `[data-chip-type="source"]` chip is titled with the channel's title (Gmail / Slack / WhatsApp /
  Telegram / Agent Email); `attached-channels[data-owner=<owner>]` holds an `attached-channel`
  with `data-provider=<provider>`
- [browser] the OTHER owner's stream inbox lists no row with the nonce
- [browser] open the row; the composer's placeholder is `Reply in <Title>`; type `reply <nonce>`, send
- [api] doubles `GET /sent?channel=<provider>` holds `reply <nonce>` — on an agent cell the composer
  sent `agent_id`, so the outbound left as the agent
- [api] delete the source

teardown: sources, the agent (and its mailbox), the doubles process (`POST /shutdown` removes the
planted credentials), the instance.

Verified 2026-09-18 on mx-8 (production build on :5018, backend :6009, local hub :8093 with the agent
mailbox provider `local`): `FLOW_INSTANCE=mx-8 VITE_PORT=5018 npx playwright test --config
tests/manual_regression/stream-inbox/playwright.config.ts channel_matrix` — 9 passed, 1 skipped (the
designed n/a); results in `_results/2026-09-18/stream_inbox_channel_matrix.json`.

---
id: d99de331-350d-410a-8198-79f961cf4761
version: 1
---
# An agent on a channel — snippets

How to put an agent on a messaging channel and answer people there, using WhatsApp as the
channel. Two ways to "run" it: **the app runs it** (the source is the agent's, the backend answers
every allowed message — nothing of yours stays running), or **your process runs the loop** (plain
Python over the same SDK, for a worker or a policy of your own). Both need Flowpad running on the
machine and an LLM source the harness can spend (Settings → LLM, or the `lm_keys` route).
Everything below is run as written by `tests/unit/test_agents_on_channels_snippets.py` against the
WhatsApp double; both variants are also proven in Docker by
`tests/long_tests/test_whatsapp_agent_in_docker.py` — a clean container, the snippet alone, a real model turn.

## 1. The credential, once

A channel's secrets are a **credential** the driver declares (`auth.credential` in its manifest),
never config. Declared once per machine (or per project), values in the vault; nothing lands in a
file a project shares.

```python
from flow_sdk.builtin.credential_service import save_credential

await save_credential(
    scope="user",
    manifest={"name": "whatsapp", "value_store": "vault",
              "setup": "Meta app → WhatsApp → API Setup: the token; App settings → Basic: the app secret. "
                       "Store them with `flow credentials set whatsapp FLOW_WHATSAPP_TOKEN=… FLOW_WHATSAPP_SECRET=…`.",
              "vars": {"FLOW_WHATSAPP_TOKEN": {"secret": True, "required": True},
                       "FLOW_WHATSAPP_SECRET": {"secret": True, "required": True}}},
    values={"FLOW_WHATSAPP_TOKEN": WHATSAPP_TOKEN, "FLOW_WHATSAPP_SECRET": WHATSAPP_APP_SECRET},
)
```

## 2. Variant A — the app answers

The agent owns the source; it is answered from wherever the agent is **deployed**. Owning a
channel places the agent nowhere — run it on this machine (`agent.run_locally()`, the "This
computer" choice under New deployment). That deployment is a **process** the app starts and keeps
running (`flow_sdk/builtin/agent_loop.py`): its loop drains every channel it answers — one durable
position per source, so a restart resumes after the last answer — turns each message from an
allowed sender into a turn in that conversation's process, and sends the answer back on the
channel. Nothing of yours keeps running.

The loop never asks the provider itself — it reads what the app's ingest lands, so an agent answers
at its channel's pace: a webhook channel (WhatsApp) at once; a pull channel whose driver declares a
fast lane (Telegram, the agent mailbox, the help desk: every 5 s) on that lane, which the loop holds
while it serves, as a person viewing the conversation does; any other pull channel (Gmail, Slack,
RSS) when its interval next polls it (`poll_interval_seconds`, 5 minutes unless set). A parked or
disabled source is not polled at all.

```python
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_driver import DataDriver

agent = Agent(name="support-bot", worker_type="claude",
              system_prompt="You answer WhatsApp messages for Acme support. One short paragraph.")
await agent.save()
await agent.run_locally()                      # a process on this machine runs its loop and answers

whatsapp = await DataDriver.get("whatsapp")
source = whatsapp.create_source(
    whatsapp.create_config(phone_number_id=PHONE_NUMBER_ID, verify_token=VERIFY_TOKEN, **EXTRA_CONFIG),
    name="Acme support line",
    owner=agent.typeid,                        # the agent's stream inbox; the agent answers
    inbound_allowed_senders=[CUSTOMER],        # who may drive it — empty admits nobody
)
await source.save()
verdict = await source.verify()                # ACTIVE once the token works
```

Point Meta's webhook at `https://<this instance>/api/v1/data_source/webhook/whatsapp` with the same
`VERIFY_TOKEN`; the thread is at `/dock/agent/<agent id>/stream_inbox`. Deploy the agent and set the
source's `answer_place` to that placement's id to have the cloud box answer instead — one place
answers a source, never two.

## 3. Variant B — your process runs the loop

The same agent and channel, but the loop is yours: a script that stays up, spawns the agent's
worker per chat, and replies — the same turn engine the app's loop uses, driven by your code. `workflow(name)` makes the position durable — a restart resumes
after the last reply.

```python
from flow_sdk.blocks import StreamInbox, workflow
from flow_sdk.builtin.agent import Agent

agent = Agent(name="support-bot-b", worker_type="claude",
              system_prompt="You answer WhatsApp messages for Acme support. One short paragraph.")
await agent.save()

async with workflow("whatsapp-support"):
    box = StreamInbox(PHONE_NUMBER_ID, provider="whatsapp", owner=agent,
                      verify_token=VERIFY_TOKEN, senders=[CUSTOMER], **EXTRA_CONFIG)
    async with agent.process_messages():
        async for m in box.listen():
            out = await agent.process_message(m)              # one session per chat
            await m.reply(await m.reply_spec(body=out.text))  # send → record → ack
```

`box.listen()` polls the source through the poller's slot and drains what landed in ingest order;
`m.reply` sends through the channel in the channel's own shape and acks only after the send is
recorded. `senders` is the loop's allowlist: the loop acks (never answers) anyone else.

To choose which of the agent's channels to listen to, or to route some messages to another agent
or to one session per customer, see `agent-deployment.md` §6 — the same loop over
`support.channel("whatsapp")` and `answer(engine, m, session=...)`, with every gate kept.

## 4. How to use it

- Text the business number from an allowed phone; the answer arrives in that chat.
- Watch the conversation in the agent's stream inbox; a reply typed there goes out as the agent.
- Change who may talk to it: `POST /api/v1/graph/agent/<id>/configure_mailbox {"allowed_senders": [...]}`
  (variant A), or the `senders=` list (variant B).

`EXTRA_CONFIG` is empty in production; a test passes the driver's loopback `base_url` through it.

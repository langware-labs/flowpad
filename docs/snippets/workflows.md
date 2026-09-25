---
id: 8b46e44c-566c-4867-8611-b25acf83c86a
---
# Workflows — snippets

`flow_sdk.blocks` is the plain-Python workflow surface. No engine, no hidden
graph: blocks are ordinary classes, your own `async for` is the orchestration,
and every value that moves between blocks is a `DataSpec`. The
[simple message block](message-block.md) yields an ephemeral `MessageRequest`;
the block owns its one-shot reply correlation. Entity-backed blocks are views
over existing `DataSource`, `Agent`, `AgenticProcess`, ingest, and projection
machinery; `MessageBlock` owns only a transient queue. Nothing here persists
state of its own.

## 1. Mail concierge

The canonical program. Pinned by `tests/unit/test_workflows_snippets.py`
(a scripted provider and a mock worker), and live by
`tests/long_tests/test_blocks_email_workflow.py` (receive → real worker turn →
typed reply → delivery verified at the counterpart inbox, 17–18s end to end).

```python
from flow_sdk.blocks import EmailMessageSpec, StreamInbox, workflow
from flow_sdk.builtin.agent_registry import get_agent

async with workflow("mail-concierge"):
    stream_inbox = StreamInbox("me@agentmail.to", api_key=KEY)
    agent = await get_agent("email-summarizer")

    async with agent.process_messages():
        async for m in stream_inbox.listen():         # m: Delivered[SourceItemSpec]
            out = await agent.process_message(m)      # out: PromptResult
            await m.reply(EmailMessageSpec.reply_to(m, body=out.text))   # send → record → ack
```

What each line does:

* `workflow(name)` names the consumer. Every process spawned inside carries
  the name in its `context_data`, and — the part that matters — the loop's
  position is stored under it: a restart resumes from the last `ack()`.
  Outside a workflow the position lives only for the loop.
* `StreamInbox(address, ...)` finds or creates the `DataSource` for that account
  (`DataSource.find_for_account` on the driver's `identity_config_key`). Extra
  keyword config lands on the row verbatim.
* `stream_inbox.listen()` syncs the source every `poll_every` seconds, projects what
  landed into its conversation, and yields arrivals in ingest order, each
  wrapped as a `Delivered` that reads like the item and adds `ack()` and
  `reply()`. Items present when the position was first created are the
  baseline. Your own sent copies and senders outside `senders=` are filtered
  and acked, so they never become a gap.
* `agent.process_messages()` owns the private runner and closes its processes
  on exit. `agent.process_message(m)` uses one `AgenticProcess` per provider
  thread, so the same thread continues the same conversation. Spawns go
  through the agent's `Deployment`, so worker, model and permission mode come
  from `agent.md`.
* `agent.process_message(m)` prompts with the message body and answers with a
  frozen `PromptResult`: `text` is the assistant's reply, `executor` the process
  that ran it. A turn the process would not take answers `NOT_YET` with
  `ran=False` instead of hanging — see [call-returns](call-returns.md).
* `EmailMessageSpec.reply_to(m, body=...)` addresses the author, keeps the
  thread, adds `Re:` once. `m.reply(spec)` sends it through the driver and
  then acks — the ack piggybacks on the reply. It records its intent before
  the send, so a crash anywhere in between is visible on redelivery and the
  item is never mailed twice. `m.ack()` alone is for an item you handled
  without replying.

Control flow is Python, not configuration:

```python
from flow_sdk.blocks import EmailMessageSpec, StreamInbox
from flow_sdk.builtin.agent_registry import get_agent

agent = await get_agent("email-summarizer")
stream_inbox = StreamInbox("me@agentmail.to", api_key=KEY, senders=["boss@corp.com"])

async with agent.process_messages():
    async for m in stream_inbox.listen():
        if "urgent" not in m.name.lower():
            await m.ack()                        # handled: deliberately ignored
            continue
        out = await agent.process_message(m)
        await m.reply(EmailMessageSpec.reply_to(m, body=out.text))
```

Every item gets exactly one of `ack()` or `reply()`. An item that gets neither
is redelivered next time — that is the at-least-once contract, not a leak.

## 2. The same loop as a Telegram bot

Browser-proven end to end (bot created via @BotFather, per-chat session memory
across turns). Pinned by `tests/unit/test_workflows_snippets.py`; the send leg
live by `tests/long_tests/test_telegram_send.py`.

```python
from flow_sdk.blocks import StreamInbox, TelegramMessageSpec, workflow
from flow_sdk.builtin.agent_registry import get_agent

async with workflow("support-bot"):
    stream_inbox = StreamInbox("@my_support_bot", provider="telegram", bot_token=TOKEN)
    agent = await get_agent("support-agent")

    async with agent.process_messages():
        async for m in stream_inbox.listen():
            out = await agent.process_message(m)     # session per chat
            await m.reply(TelegramMessageSpec.reply_to(m, body=out.text))
```

Channels disagree on who a reply targets: email replies to the author,
Telegram replies to the chat. Each `MessageSpec` subclass owns its `reply_to`,
so the loop body does not change between them.

Name the class only when the loop already knows its channel, as these do. Code
that handles whichever source it is given should ask instead —
`await m.reply_spec(body=out.text)` (or `await stream_inbox.reply_spec(m, body=...)`),
which routes to the driver's own rule. Naming `EmailMessageSpec` on a Slack
source is not a type error: it sends a DM to the person instead of posting where
everyone is reading.

## 3. The same loop in a Slack channel

Slack differs from both: the reply targets the channel, inside the message's
thread, and Slack echoes the bot's own post back through history, so the
driver records nothing itself. Pinned by `tests/unit/test_workflows_snippets.py`,
and by `flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/slack/tests/test_slack_source.py` (send, identity stamp, channel reuse)
against a loopback Slack.

```python
from flow_sdk.blocks import StreamInbox, SlackMessageSpec, workflow
from flow_sdk.builtin.agent_registry import get_agent

async with workflow("channel-helper"):
    stream_inbox = StreamInbox("C0123456789", provider="slack")   # the channel id, not its name
    agent = await get_agent("slack-summarizer")

    async with agent.process_messages():
        async for m in stream_inbox.listen():
            out = await agent.process_message(m)       # session per thread
            await m.reply(SlackMessageSpec.reply_to(m, body=out.text))
```

* The Slack token is the machine's connected Slack credential; there is no
  per-source key. `StreamInbox` checks `require("slack")` before it touches a row,
  so an unconnected instance fails on that line with the fix in the message
  (see [connections](connections.md)). It reuses the source whose `channel`
  is that id — one source per channel.
* `SlackMessageSpec.reply_to(m, ...)` sets `to` to the channel the message's
  origin names (the last part of `m.origin_namespace`) and carries `m.thread_key` through as `thread_ts`, so the answer
  lands in the thread. A top-level message is its own thread root.
* The loop never answers itself: the first `send` stamps the bot's user id
  onto the source via `auth.test`, and `listen()` drops items whose author is
  one of the source's own identities.
* Slack allows one history read per channel per minute for a non-Marketplace
  app, so `listen()` on a busy channel samples it rather than mirroring it.

## 4. The same loop on every channel, for a user or an agent

One body serves every channel and both owners. `OWNER` is `None` — the local user's stream
inbox — or an `Agent`, whose stream inbox is its own (`/dock/agent/<id>/stream_inbox`) and whose
replies go out as the agent. `m.reply_spec(body=…)` asks the channel who a reply is addressed to,
so nothing here names a channel. Pinned by `tests/unit/test_workflows_snippets.py` over
gmail, slack, whatsapp, telegram and agent email, for both owners.

```python
from flow_sdk.blocks import StreamInbox, workflow
from flow_sdk.builtin.agent_registry import get_agent

async with workflow("any-channel"):
    stream_inbox = StreamInbox(ADDRESS, provider=CHANNEL, owner=OWNER)   # the channel's own id: a mailbox, a channel, a chat
    agent = await get_agent("channel-helper")

    async with agent.process_messages():
        async for m in stream_inbox.listen():
            out = await agent.process_message(m)
            await m.reply(await m.reply_spec(body=out.text))          # addressed the way THIS channel replies
```

An agent email address (`cloud_email`) is an agent's by definition: there is no user-owned cell
for it, and `StreamInbox("…", provider="cloud_email")` without an agent owner has no mailbox to
adopt.

## 5. Values only

The unit pins in `tests/unit/test_blocks_email.py`. Useful when you want the
shapes without a provider.

```python
from flow_sdk.blocks import EmailMessageSpec, PromptResult, SlackMessageSpec, TelegramMessageSpec

reply = EmailMessageSpec.reply_to(m, body="yes!")
reply.to                      # [m.author_external_id]
reply.thread_key              # m.thread_key
reply.reply_to_external_id    # m.external_id
reply.subject                 # "Re: <m.name>", never stacked

reply.body = "edited"         # raises: frozen
EmailMessageSpec(to=["a@b"], body="x", cc=["nope"])   # raises: extra="forbid"

PromptResult.satisfied("The agent replied.", text="done")   # what a turn returns

SlackMessageSpec.reply_to(m, body="x").to      # [channel id] — from m.origin_namespace
TelegramMessageSpec.reply_to(m, body="x").to   # [chat id] — the leading part of thread_key
```

Three channels, three answers to "who does a reply go to": email to the
author, Telegram to the chat, Slack to the channel's thread. Each spec owns
that rule, so the loop body is the same line in all three.

## 6. The opening program

The SDK site opens with this program: §4's loop with the channel written in. Pinned by
`tests/unit/test_workflows_snippets.py` exactly as shown, on each of the four channels.

```python
from flow_sdk.blocks import StreamInbox, workflow
from flow_sdk.builtin.agent_registry import get_agent

async with workflow("any-channel"):
    # one word = one channel: gmail, slack, telegram, whatsapp
    stream_inbox = StreamInbox("support@acme.com", provider="gmail")
    agent = await get_agent("channel-helper")

    async with agent.process_messages():
        async for m in stream_inbox.listen():
            out = await agent.process_message(m)
            # the reply is addressed the way this channel replies
            await m.reply(await m.reply_spec(body=out.text))
```

On another channel it is the same program with this one line changed:

```python
stream_inbox = StreamInbox("C0123456789", provider="slack")
stream_inbox = StreamInbox("@acme_support_bot", provider="telegram")
stream_inbox = StreamInbox("106540352242922", provider="whatsapp")
```

## Limits today

* `StreamInbox.send` takes exactly one recipient and no attachments.
* `listen()` is in-process polling. Under a running backend the heartbeat
  poller syncs the same source on its own schedule; both paths converge on the
  same rows — and on one position per workflow name, so two loops with the
  same name share it and two with different names each see every item.
* A redelivered item (`m.redelivered`) is one the process died holding. The
  agent turn and `reply()` are both safe to repeat on it; a handler with its
  own non-idempotent effect should check the flag.

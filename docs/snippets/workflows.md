# Workflows — snippets

`flow_sdk.blocks` is the plain-Python workflow surface. No engine, no hidden
graph: blocks are ordinary classes, your own `async for` is the orchestration,
and every value that moves between blocks is a `DataSpec`. Each block is a view
over entities that already exist (`DataSource`, `Agent`, `AgenticProcess`, the
ingest and projection machinery). Nothing here persists state of its own.

## 1. Mail concierge

The canonical program. Pinned live by
`tests/long_tests/test_blocks_email_workflow.py` (receive → real worker turn →
typed reply → delivery verified at the counterpart inbox, 17–18s end to end).

```python
import flow_sdk.ingest.drivers  # noqa: F401
from flow_sdk.blocks import AgentRunner, EmailMessageSpec, Inbox, workflow

async with workflow("mail-concierge"):
    inbox  = Inbox("me@agentmail.to", api_key=KEY)
    runner = AgentRunner("email-summarizer")

    async for m in inbox.listen():                    # m: SourceItemSpec
        out   = await runner.run(m)                   # out: RunOutput
        reply = EmailMessageSpec.reply_to(m, body=out.text)
        await inbox.send(reply)
```

What each line does:

* `workflow(name)` is a grouping stamp. Every process spawned inside carries
  the name in its `context_data`, so the activity can be grouped and rendered.
  Exiting changes nothing.
* `Inbox(address, ...)` finds or creates the `DataSource` for that account
  (`DataSource.find_for_account` on the driver's `identity_config_key`). Extra
  keyword config lands on the row verbatim.
* `inbox.listen()` syncs the source every `poll_every` seconds, projects what
  landed into its conversation, and yields only arrivals: items present when
  `listen` started are the baseline. Your own sent copies and senders outside
  `senders=` are filtered.
* `AgentRunner(agent)` takes the real `Agent` entity, a name, or a TypeId.
  One `AgenticProcess` per `session_key` (default: the provider thread), so the
  same thread continues the same conversation. Spawns go through the agent's
  `Deployment`, so worker, model and permission mode come from `agent.md`.
* `runner.run(m)` prompts with the message body and returns the assistant's
  reply as a frozen `RunOutput`. A failed prompt raises instead of hanging.
* `EmailMessageSpec.reply_to(m, body=...)` addresses the author, keeps the
  thread, adds `Re:` once. `inbox.send(reply)` goes through the driver and
  returns the provider's id.

Control flow is Python, not configuration:

```python
inbox = Inbox("me@agentmail.to", api_key=KEY, senders=["boss@corp.com"])

async for m in inbox.listen():
    if "urgent" not in m.name.lower():
        continue
    out = await runner.run(m)
    await inbox.send(EmailMessageSpec.reply_to(m, body=out.text))
```

## 2. The same loop as a Telegram bot

Browser-proven end to end (bot created via @BotFather, per-chat session memory
across turns). The send leg is pinned by `tests/long_tests/test_telegram_send.py`.

```python
from flow_sdk.blocks import AgentRunner, Inbox, TelegramMessageSpec, workflow

async with workflow("support-bot"):
    inbox  = Inbox("@my_support_bot", provider="telegram", bot_token=TOKEN)
    runner = AgentRunner("support-agent")           # session per chat

    async for m in inbox.listen():
        out = await runner.run(m)
        await inbox.send(TelegramMessageSpec.reply_to(m, body=out.text))
```

Channels disagree on who a reply targets: email replies to the author,
Telegram replies to the chat. Each `MessageSpec` subclass owns its `reply_to`,
so the loop body does not change between them.

## 3. The same loop in a Slack channel

Slack differs from both: the reply targets the channel, inside the message's
thread, and Slack echoes the bot's own post back through history, so the
driver records nothing itself. Pinned by `tests/unit/test_slack_driver.py`
(send, identity stamp, channel reuse) against a loopback Slack.

```python
from flow_sdk.blocks import AgentRunner, Inbox, SlackMessageSpec, workflow

async with workflow("channel-helper"):
    inbox  = Inbox("C0123456789", provider="slack")   # the channel id, not its name
    runner = AgentRunner("slack-summarizer")          # session per thread

    async for m in inbox.listen():
        out = await runner.run(m)
        await inbox.send(SlackMessageSpec.reply_to(m, body=out.text))
```

* The Slack token is the machine's connected Slack credential; there is no
  per-source key. `Inbox` checks `require("slack")` before it touches a row,
  so an unconnected instance fails on that line with the fix in the message
  (see [connections](connections.md)). It reuses the source whose `channels`
  list contains that id.
* `SlackMessageSpec.reply_to(m, ...)` sets `to=[m.segment_key]` (the
  channel) and carries `m.thread_key` through as `thread_ts`, so the answer
  lands in the thread. A top-level message is its own thread root.
* The loop never answers itself: the first `send` stamps the bot's user id
  onto the source via `auth.test`, and `listen()` drops items whose author is
  one of the source's own identities.
* Slack allows one history read per channel per minute for a non-Marketplace
  app, so `listen()` on a busy channel samples it rather than mirroring it.

## 4. Values only

The unit pins in `tests/unit/test_blocks_email.py`. Useful when you want the
shapes without a provider.

```python
from flow_sdk.blocks import EmailMessageSpec, RunOutput, SlackMessageSpec, TelegramMessageSpec

reply = EmailMessageSpec.reply_to(m, body="yes!")
reply.to                      # [m.author_external_id]
reply.thread_key              # m.thread_key
reply.reply_to_external_id    # m.external_id
reply.subject                 # "Re: <m.name>", never stacked

reply.body = "edited"         # raises: frozen
EmailMessageSpec(to=["a@b"], body="x", cc=["nope"])   # raises: extra="forbid"

RunOutput(text="done", files=[])   # what a turn returns; files carry FileRef

SlackMessageSpec.reply_to(m, body="x").to      # [m.segment_key] — the channel
TelegramMessageSpec.reply_to(m, body="x").to   # [chat id] — the leading part of thread_key
```

Three channels, three answers to "who does a reply go to": email to the
author, Telegram to the chat, Slack to the channel's thread. Each spec owns
that rule, so the loop body is the same line in all three.

## Limits today

* `Inbox.send` takes exactly one recipient and no attachments.
* `RunOutput` carries the captured chat text; parsing it against the agent's
  declared `output` shape is the planned upgrade and lands without changing a
  caller.
* `listen()` is in-process polling. Under a running backend the heartbeat
  poller syncs the same source on its own schedule; both paths converge on the
  same rows.

---
id: 370a5982-3e75-4a8b-a8fb-49e59485be6c
---
# Files, quote-replies and reactions on a channel

Every message channel (WhatsApp, WAHA, Telegram, Slack, email) speaks the same three verbs when the
provider allows them. What a channel can do is data on its conversation — `channel_spec.accepts_attachments`,
`quotes`, `reacts` — never a test of its name. A file or an emoji the channel cannot take is refused with the
reason, before anything is sent; nothing is converted or dropped.

Run as written by `tests/unit/test_message_channels_snippets.py`.

## 1. Send files, and quote a specific message

```python
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.source_item import MessageFile

chat = await Conversation.get_one({"id": CONVERSATION_ID})
question = (await chat.messages())[-3]                  # the message being answered

await chat.send("Here's the invoice and the site photo.",
                reply_to=question,                      # quotes it on WhatsApp/Telegram; a thread reply on Slack
                files=["invoice.pdf", "site.jpg"])      # WhatsApp: 2 messages, text as the caption of the first
await chat.send("", files=[MessageFile(path="note.ogg", as_="voice")])   # a voice note, not an audio file
```

`files` are paths on this machine (or `MessageFile`s). A channel that carries one file per message
(WhatsApp, Telegram) gets one provider message per file, and only the first quotes.

## 2. The agent loop: react when a message arrives, answer with a file

```python
from flow_sdk.blocks import StreamInbox, workflow
from flow_sdk.builtin.agent import Agent

agent = Agent(name="site-inspector", system_prompt="Answer site photos in one line.")
await agent.save()
box = StreamInbox(ADDRESS, provider=PROVIDER, owner=agent, senders=[CUSTOMER])

async with workflow("site-photos"):
    async with agent.process_messages():
        async for m in box.listen():
            await m.react("👀")                                         # seen
            out = await agent.process_message(m)                        # m.files arrive as local paths
            await m.reply(await m.reply_spec(body=out.text, files=out.files))
            await m.react("✅")                                         # on WhatsApp this replaces 👀
```

The agent reads the message's words, the message it quotes, and the local path of every file it
carried; a file it saves into the folder its turn names comes back in `out.files`. The answer quotes
the message only when the person wrote again before it went out.

## 3. Read what came in

```python
async with workflow("read-files"):
    async for m in box.listen():
        for f in m.files:                            # already copied when the message arrived
            print(f.name, f.media_type, f.as_, f.caption, f.path)
        print(m.reply_to, m.reactions)               # the message they quoted, or None; who reacted with what
        break
```

A file whose link expired before it could be copied keeps its name and says why in `f.fetch_error`.

## 4. React from anywhere

```python
answer = (await chat.messages())[-1]
await chat.react(answer, "👍")
await chat.unreact(answer)                     # takes back all of ours
chat.channel_spec.quotes, chat.channel_spec.reacts, chat.channel_spec.accepts_attachments   # what the UI reads
```

An emoji the channel cannot show is refused, never swapped for another — a Telegram bot reacts only
from Telegram's own list:

```python
await chat.react(answer, "🦩")
# Rejected: 🦩 is not a reaction this channel shows
```

## 5. From the command line (what an agent uses)

```bash
flow conversation reply $CID "Fixed — see the screenshot" --reply-to $MESSAGE_ID --file shot.png
flow conversation react $MESSAGE_ID 👍
flow conversation react $MESSAGE_ID 👍 --remove
```

---
id: 2b719cf7-f386-4c5e-a62d-d68f07c31e3d
---
# Threads and replies — one model on every channel

A conversation holds threads: an email thread, a Slack thread, or a reply chain in Flowpad's own
chat. Two facts on a message carry it: **`reply_to_id`** — the message it answers (the quote) — and
**`thread_id`** — the thread it is in. The verbs are the same on Flowpad's chat and on every data
source channel; what a channel can do is data on its conversation (`channel_spec.replies`,
`quotes`), never a test of its name.

Run as written by `tests/unit/test_message_threads_snippets.py`.

## 1. Reply in a thread on Flowpad's own chat

```python
from flow_sdk.builtin.conversation import Conversation

chat = await Conversation.get_one({"id": CONVERSATION_ID})
question = (await chat.messages())[0]

answer = await chat.send("Which home — 43 or 51?", reply_to=question)   # quotes it and opens its thread
await chat.send("Snapshot taken.", in_thread=answer.thread_id)          # into that thread, quoting nobody
print(answer.reply_to_id == question.id, answer.thread_root_id == question.id)   # True True
```

The thread is keyed by its first message. Only that message's id travels to the other members;
each member's app files the reply into its own copy of the thread, so the quote and the thread
look the same on every machine.

## 2. Read one thread

```python
for t in await chat.threads():
    print(t.title, t.message_count, t.channel)          # the root's opening words, 3, flowpad

thread = (await chat.threads())[0]
for m in await chat.messages(thread=thread):            # the thread's messages, oldest first
    print(m.sender_name, m.text, m.reply_to_id)
read = await chat.transcript(thread_id=thread.id)        # what `flow conversation show --thread` prints
```

`thread=` takes a thread, its id, or the id of any message in it.

## 3. The same verbs on a data source channel

```python
mail = await Conversation.get_one({"id": CHANNEL_CONVERSATION_ID})
thread = (await mail.threads())[0]

await mail.send("Thanks — booked for Tuesday.", in_thread=thread)        # lands in that thread
first = (await mail.messages(thread=thread))[0]
await mail.send("Tuesday 10:00 works?", reply_to=first)                    # answers that one message
print(mail.channel_spec.replies, mail.channel_spec.quotes)               # what the UI reads
```

A channel whose replies only thread (email, Slack) files the reply in the thread; one that quotes
(WhatsApp, Telegram) also shows the message being answered. `in_thread` never quotes.

## 4. From the command line

```bash
flow conversation show <conversation>                         # lists the threads; each message names its thread
flow conversation show <conversation> --thread <thread-or-message-id>
flow conversation send <conversation> "On it" --reply-to <message-id>      # Flowpad's own chat
flow conversation reply <conversation> "On it" --reply-to <message-id>     # a data source channel
```

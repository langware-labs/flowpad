# Threads on every message channel — in the browser

precondition: an isolated instance (`scripts/instance_ctl.sh launch <name>`) and the channel doubles process
(`tests/e2e/channel_doubles.py`, spawned by the `.md.ts`), which hosts every driver's `Double`. Run:

    FLOW_INSTANCE=<name> VITE_PORT=<frontend port> [THREAD_CHANNELS=gmail,slack] [SHOT_DIR=<dir>] \
      npx playwright test --config tests/manual_regression/stream-inbox/playwright.config.ts channel_threads

What is proved, per channel (gmail, slack, telegram, whatsapp, agentmail, teams, cloud_email). The person writes a root and
two more messages in its thread, each the way that channel continues a thread (gmail In-Reply-To, slack
`thread_ts`, teams `replyToId`, agentmail thread id; on telegram/whatsapp the chat is the thread and the
follow-up quotes the root).

Receiver:
- the conversation opens from the base stream inbox (`stream-inbox-conversation-row`);
- the thread packs into ONE stack (`thread-stack-open`: "2 earlier in this thread");
- opening it is a navigation: the URL gains `?thread=`, and `thread-header` names it with "3 messages";
- where the provider names the answered message (gmail, telegram, whatsapp, teams), the follow-up shows the
  quote block (`message-quote`) of the root.

Sender:
- the open thread's composer shows `composer-thread-banner`, and a plain send lands in THAT provider thread:
  - a channel whose replies only thread (gmail, slack, agentmail, teams) addresses the thread (its key, root
    or newest message);
  - a quoting channel (telegram, whatsapp) sends to the chat and quotes nobody;
- ⋮ → Reply on the root (`message-reply`, `composer-reply-banner`) reaches the provider as a reply to the root;
- our copies join the thread: the header count reaches 5.

Back: `thread-header-all` ("All messages") drops `?thread=`; the thread packs again.

cloud_email is an agent's email, so its cell runs on an agent:
- the spec creates the agent, allocates its mailbox and opens it on the doubles (`/agent_mailbox`);
- the agent's stream inbox (`/dock/agent/<id>/stream_inbox`) is where it opens;
- the hub needs `AGENT_MAILBOX_ENABLED=true AGENT_MAILBOX_PROVIDER=local`.

Not covered here:
- voice channels offer no Reply (`ChannelSpec.replies` false, unit-tested in `tests/unit/test_conversation_channel.py`);
- Flowpad's own chat between two users is `native_threads.md`.

| channel | test |
|---|---|
| gmail | test 1 |
| slack | test 2 |
| telegram | test 3 |
| whatsapp | test 4 |
| agentmail | test 5 |
| teams | test 6 |
| cloud_email | test 7 (agent-owned) |

Verified 2026-10-05 on instance thr-6 (local hub :8093, agent mailbox on): 7 passed, twice.

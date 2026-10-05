# Threads on Flowpad's own chat, between two users — in the browser

precondition: two isolated instances on ONE hub that mirrors `reply_to_id` / `thread_root_id` (FlowPad
9e28d65fc or later), e.g. `scripts/instance_ctl.sh launch thr-6` (user A) and `launch thr-7` (user B; the
instance's hub user is `<name>@local.test`). Run:

    THREADS_A_UI=<A frontend> THREADS_A_API=<A backend> THREADS_B_UI=<B frontend> THREADS_B_API=<B backend> \
    THREADS_B_EMAIL=<B's hub email> [SHOT_DIR=<dir>] FLOW_INSTANCE=<A> VITE_PORT=<A frontend> \
      npx playwright test --config tests/manual_regression/stream-inbox/playwright.config.ts native_threads

Setup ([api], A): `conversation-create` with B, `share` it to B, `add_message` the root; poll until B's machine has the
root (`conversation-transcript`).

What is proved. Each side opens the conversation from its base stream inbox (`stream-inbox-conversation-row`).

B — receiver of the root, sender of the reply:
- ⋮ → Reply on A's root (`message-reply`, `composer-reply-banner`), send;
- B's own feed packs root + reply into one thread (`thread-stack-open`: "1 earlier in this thread").

A — receiver of the reply, sender into the thread:
- the reply arrives packed with the root;
- the thread opens by URL (`?thread=`); `thread-header` is titled by the root and says "2 messages";
- B's reply shows the quote of the root (`message-quote`);
- A writes into the open thread (`composer-thread-banner`): "3 messages", and A's message carries no quote.

B again:
- the thread grew ("2 earlier in this thread");
- opened, it holds A's message unquoted, beside B's quote of the root.

Back on both: `thread-header-all` drops `?thread=`.

The wire: B's reply reaches A's machine with `reply_to_id` + `thread_root_id`, and each machine files it into its
OWN `MessageThread` row (`("flowpad", <root id>, <owner>, "")`). `flow conversation show <conv>` on either
instance lists the thread and labels each message `🧵 <title>`.

Verified 2026-10-05: thr-6 (A) + thr-7 (B) on the local hub :8093, 1 passed (repeated 3×).

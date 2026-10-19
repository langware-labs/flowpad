---
id: 83721fc6-346e-4dc7-9ade-09e4c97f2d23
---
# Stream stream inbox automations — the walk

The browser tier for `docs/snippets/stream-inbox-automations.md`, as a person meets it. Driven by
`stream_inbox_automations.md.ts` against an instance whose backend runs the mock worker and the
Decision API double (`tests/e2e/mock_worker_backend.py`, `MOCK_DECISION=1`); messages come from
the Telegram loopback double (`tests/e2e/channel_doubles.py`).

```
scripts/instance_ctl.sh launch auto-7
kill <its backend pid>; set -a; source .env.auto-7.local; set +a
MOCK_DECISION=1 uv run python tests/e2e/mock_worker_backend.py &     # then put its pid in ~/.flow/instances/auto-7/launcher.json
cd ui && FLOW_INSTANCE=auto-7 VITE_PORT=5056 AUTOMATIONS_SHOTS=/tmp/stream-inbox-shots \
  npx playwright test --config tests/manual_regression/automations/playwright.config.ts stream_inbox
```

## 1. A message arrives; its quick ⚡ opens the two-box screen prefilled

- Deliver a message through the double, sync the source, open the Stream Inbox: the row is there.
- Open the conversation, hover the message: the ⚡ beside the star is the door.
- It lands on `/dock/automations?creating=message&source=<id>`, the channel chip pressed.

## 2. Sentence, agent, prompt; the fast test and Try answer; Save turns it on

- Type the sentence, pick the agent (only runnable ones are offered), type the prompt.
- Paste a sample and ask "Would it catch this?": the rule is saved first (the URL turns to
  `?trigger=<id>`), the verdict chip reads *Would catch*.
- "Try it on recent messages" lists the message from step 1, caught.
- Enabled is on; the row holds `gate.sentence` and `then.run_agent`.

## 3. A second message is caught

- Deliver another refund message. The rule's runs show one caught fire with a session.
- The stream inbox row wears "⚡ Billing helper"; the message shows the chip; the lifecycle line reads
  *Handling* then *Replied* (the mock worker answers at once).
- The chip opens the session (`/dock/process-runs?run=…`).
- The top-bar ⚡ carries a count; the list row shows "N caught · M passed over" and a mark.
- No page errors; no `/graph/trigger` response at or above 400 (404 and 422 excepted).

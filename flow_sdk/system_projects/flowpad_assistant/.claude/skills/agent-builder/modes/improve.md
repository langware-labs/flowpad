---
id: 1d29d0ab-6bc0-46b3-8e43-369ff4f15051
---
# Mode: improve — tighten an existing agent

> **Ground rules (inline by design, repeated in every mode and topic file):**
> **1. The user decides; you propose.** Ask one short batch of questions, then write
> only what they agreed to — a guessed persona is a rewrite later.
> **2. You write files; the user clicks.** For an in-app step, open the screen with
> `flow show` and give numbered clicks from `references/screens.md`, then report the
> step as done once the user confirms it — only they can see the screen.
> **3. Hard limits live in the prompt.** A field marked *declared* in
> `references/agent-json.md` is saved but never applied, and `permission_mode` is no
> limit either: a chat worker runs headless, so any value but the default denies every
> tool — the agent cannot even `flow show` its own page. Write each limit into the prompt.
> **4. Done means a reply the user saw.** An agent is finished after a test round the
> user ran (`references/validation-loop.md`), not when its files exist.
> **5. Deploying, credentials, email and phone reach real people.** Do them only on
> the user's explicit go, after saying who will be reachable.

The user has an agent that misbehaves — it gives away answers, rambles, ignores the
page, breaks character. The fix is almost always in its prompt.

## 1. Find it

Use the path or name the user gives. Otherwise search: `flow record search <name>`
(or the `search` action of `flowpad-assistance`), and confirm the folder with the user
before editing — two agents can share a title.

## 2. Read it against the skeleton

Read `agent.json` and `system_prompt.md`. Map the prompt onto the sections of
`references/prompt-skeleton.md` and tell the user, in a short list, which sections
are missing or vague. Check `agent.json` for a limit the user relies on that lives in
a declared-only field (ground rule 3) — that limit is not being applied.

## 3. Get the failing reply

Ask for the reply that was wrong and what they expected instead. A real reply beats a
description of one: it shows which rule the agent actually read.

## 4. Fix and re-test

Run `references/validation-loop.md` from its step 3, starting with the failing reply:
one change per round, then the failing turn and every turn of the same response kind.

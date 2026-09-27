---
id: ab9ffc74-0bdf-4bf2-97c8-8e48defe4f90
---
# Topic: a chat / guide agent

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

A person talks to this agent in a chat: a tutor, a guide, a helper with a persona.
Its quality is almost entirely its prompt.

## Ask

- What should it be called, and how should it introduce itself?
- Who talks to it — age or expertise, language, and how it should address them?
- What must it never do, even when asked nicely? (This becomes the core rule.)
- Should it start by itself when the project opens, or when the user picks it?

## Build

1. **Prompt first.** Fill `references/prompt-skeleton.md` and follow its rules —
   above all, lead with the single role.
2. **The core rule gets the most words.** Turn "never do X" into the method the agent
   follows instead: a ladder of steps, one at a time.
3. **`intro`** — the welcome text at the top of the chat. The model never sees it, so
   anything the agent must know goes in the prompt, not here.
4. **Auto-launch** — set `auto_launch: true` and an `auto_launch_prompt` only if the
   user wants it to start on its own. The prompt is sent as the user's first message,
   so write it in the user's voice ("Hi, I'm starting — open the lesson for me").
   It fires **once per project on each machine**; after that, opening the project
   shows its home. To test it again, the user resets it (`references/screens.md` →
   *Re-test auto-launch*) — do not make copies of the project to get a fresh launch.
5. **Opening move** — if the agent should show something first (a page, a doc), say
   so in the prompt's *Opening move* with the exact `flow show file <path>`.

## Show and test

- *Chat with it* from `references/screens.md`.
- Validate with `references/validation-loop.md`. For a guide agent the rule-break turn
  is the one that matters most: the user asks straight out for the answer, then
  pushes ("just this once").

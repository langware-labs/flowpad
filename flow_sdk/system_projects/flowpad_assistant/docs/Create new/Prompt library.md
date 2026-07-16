---
id: 58edd7c0-8a10-424c-a36b-94044cd32c06
title: Prompt library
---

# Prompt library

A **prompt** is reusable prompt text you save once and send to an agent
whenever you need it — the instruction you keep retyping: a review request, a
release checklist, the way you like commits written.

Creating one asks for four things: a **name**, the **text** itself, and an
**icon** and **color** so you can find it at a glance in the library. Both name
and text are required. There's no path to choose and no scope to pick — a
prompt is its text, so it's created in one step and lands in the
[[Flowpad project]]'s `prompts/` folder (or your home folder if no project is
active) as a plain `.md` file.

## Using one

Open the **prompt library** from the popover next to the queue in a session's
bottom ribbon. Clicking a prompt **adds it to that session's queue** — it
doesn't open it for editing. The agent picks it up when it's ready for the next
message. Flowpad tracks how often each prompt is used and when you last used
it.

## Sending a prompt to someone else

You can also attach a prompt to a message in a [[Conversations|conversation]],
so the recipient can run it against their own project. That's a separate flow
with its own permission step — see [[Prompt execution]] for what happens on the
receiving side.

## Good to know

- **Prompts are plain text, not templates.** There are no variables or
  arguments to fill in — what you save is what gets sent.
- **Creating one from the assets list gives you an empty prompt.** The "+" on
  the assets page only asks for a name, so you get a prompt with no text yet;
  open it and write the body. The create tile's dialog asks for both at once.

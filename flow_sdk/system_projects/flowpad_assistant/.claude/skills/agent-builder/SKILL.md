---
id: 2408c41c-b3a4-42fe-8868-243b2ff11aae
name: agent-builder
description: Builds a Flowpad agent together with the user — "make me an agent that…",
  "a tutor / guide / assistant agent", "an assistant / helper / bot our customers
  use to do X", "an agent that watches this page", "an agent my code can call", "deploy
  an agent to email / WhatsApp / a chat endpoint", "give my agent a persona or auto-launch".
  Interviews for the job, picks the kind (chat, page-aware, typed service, deployed),
  writes agent.json and system_prompt.md, opens the agent's screens with the clicks
  to make, and tightens the prompt through a test script the user runs. `improve <agent>`
  fixes one that misbehaves ("it keeps giving away the answer", "it ignores the page").
  NOT for a Claude Code subagent in `.claude/agents/` (building-deliverables), other
  records (flowpad-assistance), or opening an agent that exists (flowpad-navigation).
tags: ''
version: 2
---
# agent-builder

A Flowpad **agent** is a folder, `<scope>/agentic-assets/agent/<name>/`, holding
`agent.json` (its definition) and `system_prompt.md` (who it is). People chat with it,
pages report to it, code calls it, channels reach it. It is not a **subagent** — a
Claude Code helper file in `.claude/agents/` that a session delegates to; those are
built by `building-deliverables`.

This skill builds an agent *with* the user: they decide what it is and do the in-app
steps; you write the files, open the right screen and test it with them.

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

## Your first reply

For a new agent, your first reply is the interview in `modes/build.md` §1 and nothing
else — no file written, no existing agent edited or renamed. An agent that already
does this job is a question for the user ("improve it, or build a new one?"), not a
thing to change on your own. Every path below is relative to this `SKILL.md`'s folder;
read the mode file before acting.

## Modes (from the skill arg)

The first token, if it is exactly `improve`, selects improve mode. Anything else is a
natural request for a new agent.

| Skill arg                                        | Load               | What it does                                                                               |
| ------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------ |
| *(none)*, or a natural request — **the default** | `modes/build.md`   | Interview, pick the kind, write the files, index, show, validate with the user             |
| `improve [<agent>]`                              | `modes/improve.md` | Read an existing agent against the skeleton, get the failing reply, fix one thing, re-test |

## Kinds

Build mode picks these from the interview; one agent can be several — load chat
first, then the others that apply.

| The user said…                                                                       | Kind               | Load                      |
| ------------------------------------------------------------------------------------ | ------------------ | ------------------------- |
| someone chats with it — a tutor, a guide, a helper with a persona                    | chat / guide       | `topics/chat.md`          |
| it should see what the user does on a page                                           | page-aware         | `topics/page-aware.md`    |
| code calls it with data and gets a result back                                       | typed service      | `topics/typed-service.md` |
| it answers email, WhatsApp or a chat endpoint, runs on a schedule or a cloud machine | deployed / channel | `topics/deployed.md`      |

## Reference

| When you need to…                                                                         | Load                            |
| ----------------------------------------------------------------------------------------- | ------------------------------- |
| write or check `agent.json` — every field, which ones are enforced, shapes, places        | `references/agent-json.md`      |
| write or review `system_prompt.md` — the section skeleton and the rules that make it hold | `references/prompt-skeleton.md` |
| test the agent with the user and tighten its prompt                                       | `references/validation-loop.md` |
| open a screen and tell the user what to click                                             | `references/screens.md`         |
| show a file, a snippet or any other screen                                                | the `flowpad-navigation` skill  |
| an `.mcp.html` page — rendering and form submissions                                      | the `mcp-ui` skill              |


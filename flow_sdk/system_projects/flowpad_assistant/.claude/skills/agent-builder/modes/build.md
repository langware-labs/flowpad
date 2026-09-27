---
id: 9075033e-47fb-48df-99dc-e7c157767b7e
---
# Mode: build — a new agent, with the user

> **Ground rules (inline by design, repeated in every mode and topic file):**
> **1. The user decides; you propose.** Ask one short batch of questions, then write
> only what they agreed to — a guessed persona is a rewrite later.
> **2. You write files; the user clicks.** For an in-app step, open the screen with
> `flow show` and give numbered clicks from `references/screens.md`, then report the
> step as done once the user confirms it — only they can see the screen.
> **3. Only enforced fields do work.** A field marked *declared* in
> `references/agent-json.md` is saved but never applied — put every hard limit in the
> prompt and in `permission_mode`.
> **4. Done means a reply the user saw.** An agent is finished after a test round the
> user ran (`references/validation-loop.md`), not when its files exist.
> **5. Deploying, credentials, email and phone reach real people.** Do them only on
> the user's explicit go, after saying who will be reachable.

## 1. Interview — one batch, then wait

Send these together, in plain words, and **end your turn there** — write no file until
the user answers. A detailed request does not skip this step: for each question the
request already answers, state the answer you took from it as an assumption to confirm,
and offer a sensible default for the rest, so the user can reply "yes" to most of it.
Building before they confirm is how a persona or a limit gets guessed wrong.

1. **The job** — what is the one thing this agent does? What is it *not* for?
2. **Who uses it** — expertise or age, language, how it should address them.
3. **Material** — which files, folders or pages does it need to know about?
4. **Hard limits** — what must it never do, even when asked?
5. **How it starts** — someone chats with it; it sits beside a page; code calls it;
   or it runs on its own (a channel or a schedule).
6. **Where it lives** — this project (default) or everywhere the user works.

Before sending it, list the agents that already exist (`agentic-assets/agent/*/` in
the project and in the user's home). When one already does this job, make the first
question "improve `<name>`, or build a new agent beside it?" — improving goes to
`modes/improve.md`; never rename or rewrite an existing agent on your own.

## 2. Pick the kind

Match the answer to question 5 against the *Kinds* table in `SKILL.md` and load every
topic file that applies — chat first. Read each topic's own *Ask* list and add any
question the first batch did not cover.

## 3. Write the files

1. Folder: `<scope>/agentic-assets/agent/<name>/` — `<name>` lowercase, digits, `-`
   and `_`; it becomes the agent's address.
2. `agent.json` from `references/agent-json.md` — only the fields this agent needs;
   never `id`, `type` or `name` (indexing mints the id, the folder is the name).
3. `system_prompt.md` from `references/prompt-skeleton.md`, in the agent's language.
4. Show the user the prompt's core rule and style section before going on; those two
   are where their intent most often differs from your draft.

## 4. Make it visible

```bash
flow record index <abs-agent-folder>/agent.json --types agent    # prints the agent's TypeId
```

Today a new agent folder is not picked up until it is indexed — without this the
agent does not appear on the project home and cannot be launched. Keep the TypeId it
prints.

## 5. Show it

`flow show file <abs-agent-folder>/agent.json`, then walk the user through
*See and edit the agent* in `references/screens.md`. Then apply each loaded topic
file's *Build* and *Show and test* sections — the agent's page is already open.

## 6. Validate together

End the build turn by handing the user the round-1 test script from
`references/validation-loop.md` — not by announcing the agent is done. Then run the loop
with them until a full round comes back clean. Only then report what the agent does,
where its files are, and which clicks the user still owns (deployment, credentials).

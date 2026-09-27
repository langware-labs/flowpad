---
id: d44ec01e-eea6-4122-902c-f00e16bc4d8d
---
# Topic: a deployed / channel agent

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

The agent runs somewhere on its own — this computer or a cloud machine — and answers
people on a channel: email, WhatsApp, a chat endpoint, or a schedule. Once deployed,
real people can reach it, so this topic is the one where the user's go matters most.

## Ask

- Where does it run: on this computer (free, only while it is awake) or on a cloud
  machine of its own?
- Who reaches it, and how — its email, a phone number, a chat endpoint, or only on a
  schedule?
- Which credentials does it need (a mailbox, an API key)? Names only — the user
  enters the values in the app, never in chat or in `agent.json`.
- Should one deployment behave differently from another (a bigger model in the
  cloud)?

## Build

1. Get the agent working in a chat first (`topics/chat.md`) — a deployment only
   changes where it runs, not how it behaves.
2. List what it needs in `requirements` (names of credentials and variables).
3. Put hard rules for strangers in the prompt: who it may answer, what it may reveal,
   when to hand off to a person.
4. `machine_size` (`sm` / `md` / `lg`) matters only for a cloud machine.

## Deploy — the user's clicks

Say who will be able to reach the agent, get an explicit go, then:

- *Deploy it* and *Give it credentials* from `references/screens.md`. A deployment
  stays blocked until every credential it needs is filled.
- The command-line equivalent is `flow agent deploy <name> [--environment <env>]`;
  prefer the screen so the user sees the missing credentials.
- Per-deployment differences go in `places` — the editor writes them when the user
  changes a deployment's settings (`references/agent-json.md` → *Places*).
- `email_place` picks the one deployment that answers the agent's email; without it,
  every machine that polls the mailbox may answer.
- A recurring job is *Schedule it* from `references/screens.md`.

## Show and test

- `flow show view process-runs` — each channel message becomes a run the user can
  open.
- Test on the channel itself with the user as the sender: one normal message, one the
  agent must refuse, one it should hand off. Only the user sends to real channels.
- How deployments, placements and channel routing work, in code (in a Flowpad source
  checkout only): `docs/snippets/agent-deployment.md`.

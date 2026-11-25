---
id: 8c5f7f0f-526a-504c-8f6c-999792fe8754
name: live-session-helper
description: >-
  Works on another person's machine through a Flowpad live session, for the user who is its
  guest — "check it on her machine", "look at his setup", "run this over there", "why does it
  fail on their side", or a launch prompt that says "a live session with X is active". Covers
  reading the session's state and what its host approved (prompts, commands, Flowpad control),
  picking the cheapest kind of turn, sending each kind, waiting for the answer, and reading a
  failure line. Use it before the first turn you send into a session. NOT for wording a message
  to a person (message-formatter), or for showing something in this user's own app
  (flowpad-navigation).
---

# live-session-helper — working on someone else's machine

A live session lets your user (the **guest**) run things on another person's machine (the
**host**). The host approved it by hand, for this session only, and ticked which kinds of turn
it may run. You never see their machine: you send a turn, their Flowpad runs it, the answer
comes back as a message in the session.

## 1. Read the session first

```bash
flow conversation live-session <conversation id>
# {"session_id": "…", "status": "idle", "host_name": "…", "turn_kinds": ["prompt", "command", "control"], …}
```

| `status` | what it means for you |
|---|---|
| `pending` | not approved yet. Nothing can be sent. Tell the user; do not poll. |
| `idle`, `running`, `error` | live. `error` only says the last turn failed; the next one runs. |
| `ended`, `declined` | over. Run the command again to request a new one — the host approves again. |

`turn_kinds` is what the host approved. A kind that is not listed is refused before it leaves
this machine. Empty or missing means prompts only (an older Flowpad on their side).

No session yet? The same command requests one; `--kinds prompt,command` asks for less than all
three. The host sees the request with a tick per kind.

## 2. Pick the cheapest kind that answers the question

| you need | kind | why |
|---|---|---|
| a fact on their disk or in their shell: a file, an env var's presence, a version, `flow …` output | **command** | No LLM on their side. Works when they have no tokens, no subscription, a broken worker. |
| what their Flowpad knows or can do: an entity, a status, an action a button calls | **control** | A script in their open Flowpad tab with the SDK. No LLM. Returns typed JSON. |
| judgment on their side: "find out why", read and reason over many files | **prompt** | Their worker does it. It spends THEIR tokens and fails when they have none. |

Start with a command when you can. A prompt that fails with a provider error (429, out of
credits, not signed in) is the signal to stop sending prompts and switch kind.

## 3. Send one turn

One turn runs one thing. The first argument after the conversation id is what the host READS
in the session; write it for a person, short.

```bash
S="--session <session id>"
flow conversation send <conv> "Listing your token sources." $S --command "flow llm list"
flow conversation send <conv> "Reading the Claude sign-in state." $S --script "
  const s = await sdk.dataManager.callAction(new sdk.ActionInfo('status/refresh', 'compute_node', '@local', 'POST'));
  return s.harnesses.find((h) => h.worker_type === 'claude').login;"
flow conversation send <conv> "Looking for what routes Claude to the budget." $S --prompt "<the full task>"
```

- **Command**: runs in the session's folder (a project of theirs, or a temp folder). It is
  killed after 10 minutes. Windows hosts run it in PowerShell, others in `sh` — ask
  `flow --version` first when the syntax would differ, and write Windows paths with forward
  slashes (`C:/Users/…`).
- **Script**: the body of an async function with `sdk` in scope (`sdk.dataManager`,
  `sdk.ActionInfo`, the entity classes). `return` plain JSON. `--script @file.js` reads a file.
  It acts as the host's signed-in user, in the tab they have open.
- **Prompt**: self-contained. Their worker knows nothing of this conversation.

Turns run one at a time, in the order sent.

## 4. Wait for the answer — never poll

Add `--on-reply "<what to do with the answer>"` to the send. When the answer arrives this
session is woken with it. The session's own lines ("X approved the live session") do not count
as the answer. Read it in full with `flow conversation show <conv> --last 5`.

| the answer | means |
|---|---|
| `exit 0` + output | the command ran. Any other `exit N` is also an answer, not a failed session. |
| `returned` + JSON | the script's value. |
| `threw` + an error | the script ran and threw. Fix the script. |
| `The host could not run this prompt: …` | the turn itself failed; the reason follows. |

Failure reasons you will meet:

- `a command is not approved for this live session` — the host did not tick that kind. Ask the
  user whether to request a new session; do not try another route to the same thing.
- `No Flowpad tab is open on this machine` — a script needs their Flowpad open. Ask them to
  open it, or use a command.
- `the host restarted while this command ran — it was not run again` — check what it changed
  before sending it again.
- a provider error on a prompt — switch to a command or a script.

## 5. It is their machine

- **Read-only unless your user said otherwise.** Diagnose first, report, and change something
  over there only on the user's explicit go. A fix the host can do in two clicks is theirs to do.
- **Never print a secret.** Report a variable's NAME and whether it is set, a URL's host, a
  key's length — never the value. Their output lands in a conversation both sides read.
- **Say what you run.** The host sees every command and script in their session view; the
  line they read should match what it does.
- **One session, one approval.** A later session needs their approval again. Do not ask for
  more kinds than the task needs.

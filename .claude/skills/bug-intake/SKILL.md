---
id: a1d6ac86-ebfd-4336-b885-f98c907c2e32
name: bug-intake
description: Take a bug a teammate reported in a Flowpad conversation from message
  to proven cause — read it, reproduce it in an isolated clone and instance, ask the
  reporter for exactly what is missing (and resume when they answer), then hand off
  to `rca` and `rca test`, and deliver an HTML report with a one-command reproduction.
  Use when a bug arrives in a conversation (e.g. "New BUGS") and must be triaged end
  to end without touching the user's checkout or prod.
---

# Bug intake — message → repro → RCA → report

One bug = one folder = one state file. Everything here runs WITHOUT the user's
checkout and WITHOUT the prod instance.

## Paths

| What | Where |
| --- | --- |
| Isolated clone (never the user's checkout) | `~/Developer/flowpad-bug-triage/` |
| Per-bug folder | `~/Developer/flowpad-bug-reports/<YYYY-MM-DD>-<slug>/` |
| State of one bug | `<bug-folder>/state.json` |
| Reproduction | `<bug-folder>/repro.sh` (+ screenshots) |
| Report | `<bug-folder>/report.html` |

`state.json`: `{"slug", "conversation_id", "message_ids": [...], "reporter", "status":
"analyzing|waiting_for_info|reproduced|rca_done|reported|cannot_reproduce", "asked": "<what we
asked>", "branch": "bug/<slug>", "repro": "<path>", "rca_test": "<path or null>"}`.

## 0. Which bug is this message about?

Read the new message in full: `flow conversation show <conv> --last 15` and
`flow conversation message <msg-id>` (attachments land on disk — read them: screenshots,
`claude_session-*` transcripts, logs).

Then list `~/Developer/flowpad-bug-reports/*/state.json` with `status: waiting_for_info` for
this conversation. The message is a **reply** when it quotes / threads under one of their
`message_ids` or answers what that bug's `asked` requested → resume that bug at step 2.
Otherwise it is a **new bug** → step 1. Not a bug at all (thanks, chit-chat, a bug sent by
someone else) → do nothing and say so in one line.

## 1. Analyze

Write down, in `state.json` and your notes: symptom, expected behaviour, steps, version
(the reporter's Flowpad version), platform, severity (important / normal / minor — as the
reporter gave it), which surface (UI page, CLI, hub, sharing between two users…).

## 2. Reproduce

1. Prepare the clone (first time: `git clone git@github.com:langware-labs/flowpad
   ~/Developer/flowpad-bug-triage`). Then `git fetch` and check out a fresh
   `bug/<slug>` from the newest `origin/release/v0.x`. If the reporter's version is older and
   the bug does not reproduce on the newest branch, say so — it may already be fixed.
2. Use the cheapest surface that shows the symptom:
   - logic / backend → a short script or pytest against a disposable instance;
   - UI → a disposable instance (`scripts/instance_ctl.sh launch bugtriage-<n>`) and the
     `real-browser` skill; keep a screenshot of the failure;
   - two users / sharing / conversations → the `2dev-users-setup` skill;
   - the reporter's own logs → the `flowpad_logs` skill tells you where they live;
   - need richer traces → the `toplog` skill.
3. Capture the reproduction as `<bug-folder>/repro.sh`: one command that brings up what is
   needed and shows the bug (prints the wrong output / opens the failing page). Run it once
   more from scratch to confirm it reproduces on demand.
4. Kill only the instances and PIDs you started (`scripts/instance_ctl.sh kill <name>`).

**Could not reproduce** → step 3. **Reproduced** → `status: reproduced`, step 4.

## 3. Ask the reporter — exactly what is missing

Reply in the conversation, threaded under their bug message, in the reporter's language:

```bash
flow conversation send <conv> "<text>" --reply-to <their-msg-id>
```

The message: one line on what you tried and what happened, then a numbered list of the
specific items you need, each with HOW to get it. Pick from: exact steps from app start,
Flowpad version (Settings → About), OS, a screenshot or short screen recording of the moment,
the error text, the backend log around the time (`~/.flow/instances/prod/logs/`), whether it
happens again after a restart. Ask only for what would change your next attempt — never more
than 4 items. Start the message with `🤖 Gadi's bug assistant:`.

Set `status: waiting_for_info`, store `asked` and the message id, and end the run. The reply
arrives as a new message and resumes at step 0. If after one more round it still does not
reproduce → `status: cannot_reproduce`, and report that (step 5) with everything tried.

## 4. RCA

With the bug reproduced, in the clone, run the `rca` skill (RCA mode) on it, then `rca test`.
Any probe or toggle the RCA adds stays in the clone on `bug/<slug>`; at the end leave only the
failing test on that branch (commit it locally, never push). Save the RCA flow chart, the
core one-liner, the `rca test` outcome (FOUND / NOT FOUND / IMPOSSIBLE) and the suggested fix
(the change that flips the proven switch — described, with file:line, not applied).

## 5. Report

Write `<bug-folder>/report.html` (self-contained, readable, Hebrew) with these sections:

1. **Bug** — reporter, date, severity, the reporter's words (quoted), link back to the
   message id.
2. **Reproduction** — status, the one command (`bash <abs>/repro.sh`), what you see when it
   runs, screenshot inline if any.
3. **Root cause** — the RCA flow chart (in `<pre>`), the core one-liner in plain words,
   the proven on/off switch.
4. **RCA test** — outcome, test path and name, the failing assertion, the branch
   `bug/<slug>` in `~/Developer/flowpad-bug-triage`.
5. **Suggested fix** — what to change, where (file:line), and why it removes the cause.
6. **Open questions** — anything unproven, said plainly.

Then deliver it:

```bash
flow artifact file <bug-folder>/report.html
flow conversation attach 35aca1ca-7028-4ee9-9e59-e26a93f978fb <bug-folder>/report.html "🐞 <one-line title> — <reproduced / not reproduced>, <core cause in a few words>"
flow conversation attach 35aca1ca-7028-4ee9-9e59-e26a93f978fb <bug-folder>/repro.sh "Reproduction: bash repro.sh"
```

`35aca1ca-7028-4ee9-9e59-e26a93f978fb` is Gadi's private `Bug triage reports` conversation —
only he is in it. The report never goes to the bug's own conversation (New BUGS); Ami only
ever gets the questions of step 3.

Set `status: reported`.

---
id: 17c6bd69-7165-42b9-89fe-9ab2517738f2
title: Prompt execution
---

# Prompt execution

When someone you're collaborating with sends a **prompt** into a shared
conversation, it opens a **live session** on your machine. Flowpad does not run
it silently: the prompt shows up in the conversation with a session card that
asks you first — **Approve** or **Decline** — because running it means running
it **on your computer, with your local agent and your permissions**.

Only approve sessions from people you trust. **Never run prompts from untrusted
sources.** A prompt is instructions for an AI agent that can read and write files
in the active project, run tools, and take actions on your behalf. Treat an
incoming session the same way you'd treat a script someone asked you to run: if
you don't trust the sender, decline it.

## The trust boundary

- Every turn of the session runs on **your** computer, not the sender's.
- It executes with the **same access your own prompts have** — the current
  project's files, connected tools, and any MCP servers you've configured.
- **Decline** is always safe: nothing runs, the session ends, and nothing is
  remembered.
- **Approve** runs the prompt that opened the session and every follow-up the
  sender types into it, until you **Pause** or **Disconnect**. Follow-ups and
  replies live inside the session view, not in the conversation thread.

## One session, one approval

A session is approved once. While it is active the sender can keep working
through the session view without asking again. **Pause** holds the session —
new prompts bounce with a visible line until you **Resume**. **Disconnect** ends
it for good; the sender has to send a fresh prompt to start another.

## Always allow sessions from someone

Ticking **Always allow sessions from {name}** when you approve grants a standing
permission: their future sessions start approved without asking. By default it
is scoped to **this project only** — the safest choice — so trust you extend in
one project doesn't leak into the others. Choose **everywhere** only for a
sender you fully trust across all your work.

A standing permission is remembered as a per-contact permission. You can review
or revoke it at any time from the contact's permissions, or from any session's
header. Revoking returns you to being asked when their next session opens.

## Replies: auto-send or review

Each session has a reply policy, proposed by the sender on the first prompt and
editable by either side in the session view:

- **Auto-send** (default) — every reply goes back into the session as soon as
  the agent finishes.
- **Review before sending** — replies land as drafts inside the session view;
  you read them and press Send. Nothing leaves your machine until you do.

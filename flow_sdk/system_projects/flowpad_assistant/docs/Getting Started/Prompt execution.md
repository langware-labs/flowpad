---
id: 17c6bd69-7165-42b9-89fe-9ab2517738f2
title: Prompt execution
---

# Prompt execution

When someone you're collaborating with sends a **prompt** into a shared
conversation, Flowpad does not run it silently. Instead it asks you first —
**"Allow {name} to run prompt on this computer"** — because running a received
prompt means running it **on your machine, with your local agent and your
permissions**.

Only allow prompts from people you trust. **Never run prompts from untrusted
sources.** A prompt is instructions for an AI agent that can read and write files
in the active project, run tools, and take actions on your behalf. Treat an
incoming prompt the same way you'd treat a script someone asked you to run: if you
don't trust the sender, decline it.

## The trust boundary

- The prompt runs in the **shared session** on **your** computer, not the
  sender's.
- It executes with the **same access your own prompts have** — the current
  project's files, connected tools, and any MCP servers you've configured.
- Declining (**Cancel**) is always safe: nothing runs, and nothing is remembered.
- **Allow** runs the prompt once. If you also want to stop being asked for this
  sender, use **Don't ask again** (or the Advanced options below).

## Auto-run

**Don't ask again** grants this sender an *auto-run* permission so their future
prompts run without a confirmation dialog. By default it is scoped to **this
project only** — the safest choice — so trust you extend in one project doesn't
leak into the others. When the conversation isn't tied to a project, it applies
globally instead.

Expand **Advanced** for the full control:

- **Auto-run prompts from {name} for this project** — future prompts from this
  sender run automatically, but only inside the current project. This is what
  "Don't ask again" toggles.
- **Auto-run prompts from {name} (all projects)** — future prompts run
  automatically everywhere. Grant this only to a sender you fully trust across
  all your work.

Auto-run is a standing grant. You can review or revoke it at any time from the
contact's permissions.

## Auto-reply

Some collaborations expect a reply to flow back to the sender after a prompt
runs. The **Auto-reply** options control whether — and how automatically — that
happens:

- **Send the reply for just this message** — a one-time reply for this prompt
  only. Nothing is remembered.
- **Always auto-reply to {name} for this project** — replies are sent back
  automatically for this sender, within this project.
- **Always auto-reply to {name} (all projects)** — replies are sent back
  automatically for this sender everywhere.

The project-scoped options are the conservative default; the global options apply
across every project and should be reserved for senders you fully trust.

## Reviewing and revoking

Every grant made here is remembered as a per-contact permission. To see what a
contact is allowed to do — or to take a permission back — open that contact's
permissions and remove the entry. Revoking returns you to being asked before each
prompt runs.

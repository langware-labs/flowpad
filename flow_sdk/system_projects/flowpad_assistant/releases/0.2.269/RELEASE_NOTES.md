---
release: 0.2.269
from: v0.2.268
to: HEAD
source_hash: f26aa085a127bc34
---

# Flowpad 0.2.269

*Released Nov 16, 2026*

## New

- **Attach files from the command line** — `flow conversation send --file` sends files with the message.
- **`flow project register`** — answers the folder's project, or creates it; the git setup agents use it.
- **Apps can open an agent's chat** — a page can ask Flowpad to open the chat with an agent.

## Improved

- **GitHub PRs** — a pull request's conversation is its chat: comments, reviews, and the merge, close or reopen. Pull requests that mention you are included.
- **Messages** — once a session was started from a message, its button opens that session.
- **Monitoring** — one card per issue, with no separate Resolved line.
- **Set up again** asks for a credential whose login was refused.

## Fixed

- Opening an agent reopens its chat; a chat no longer closes while its turn saves.
- A session's own message no longer wakes its wait for a reply.
- Pressing **Send** again in Ask for help never starts a second diagnosis.

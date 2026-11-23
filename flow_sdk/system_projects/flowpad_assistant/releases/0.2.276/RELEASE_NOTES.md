---
release: 0.2.276
from: v0.2.275
to: HEAD
source_hash: 5cf41e9794e4e22d
---

# Flowpad 0.2.276

*Released Nov 19, 2026*

## New
- **Stream Inbox classification** — a classifier proposes a tag for each conversation; you review the results table and apply.
- **Stream Inbox filters** — a tag filter button, a filter line that stays pinned while you scroll, and a Tasks button with the open-task count.
- **Active secret manager** — one vault per target, read by the agent when it needs a value, shown in the footer.
- **Home icons** — agents and apps on the desktop and hub home show as icons with a properties panel.
- **Automation messages are cards** — Status, Summary and Details, with automation answers posted on the conversation.
- **Quick prompts** — edit in place; delete takes two clicks; the menu grows to fit its lines.

## Improved
- A ready update shows as the top bar's pill and a green dot on the version chip, not a toast.
- Hosted apps lists only apps that still serve; a row opens the app in Flowpad.
- Copy session details moved into the session menu and includes the worker process id.
- The project picker search matches the project's own name.
- Set up again asks for a credential the setup check refused.

## Fixed
- An offline server no longer blocks a page — a small closeable tag says Flowpad isn't running.

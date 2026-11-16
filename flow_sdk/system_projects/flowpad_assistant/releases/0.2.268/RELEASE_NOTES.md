---
release: 0.2.268
from: v0.2.267
to: HEAD
source_hash: ed511f9da710ac10
---

# Flowpad 0.2.268

*Released Nov 16, 2026*

## New

- **Orphaned projects** — projects whose folder is gone are listed, and cleanup can remove them; a project on an unplugged drive is not an orphan.
- **Teams spend** — the **Teams** tab shows the organization's spend that no team accounts for.

## Improved

- **Deleting a project** keeps its folder unless you ask to delete it too.
- **Engine updates** — a newer engine replaces one that is waiting, there is one engine button, and **Update available** no longer shows beside a ready update.
- **Automations** — status tabs replace the kind chips, and a rule that has ended has no on/off switch.
- **Home button** opens the active project's home page when it has one; **Chats** on the rail opens the tabs view from Vibe too.
- **Message tags** button shows a tag icon.
- A membership invite threaded into a conversation marks that conversation unread.

## Fixed

- Times sent with a time zone are stored at the right moment, not hours off.
- A box signed in as an agent no longer shows the sign-in overlay in the Stream Inbox.
- Opening a PC from an invite link works from a browser that is already signed in.
- Projects in an instance's own workspace are indexed.
- A failing desktop update feed no longer stops the engine update check.

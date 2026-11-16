---
release: 0.2.267
from: v0.2.266
to: HEAD
source_hash: 35f520d2d7470825
---

# Flowpad 0.2.267

*Released Nov 16, 2026*

## New

- **Message tags in the Stream Inbox** — incoming messages are classified into tags, and a rule on a tag runs once per message, in order. Manage tags from **Stream Inbox tags**.
- **Help desks** — create a desk from **Contacts**, add one like a contact, and answer requests on a two-sided ticket page.
- **Session browser** — one setting per project chooses the browser a session drives, a status-bar chip shows it, and the agent browser is the default; it works on every worker.
- **Local Vertex** — a Vertex service account can fund workers; LLM endpoints carry their own default model, and **Token sources** lists every key, login and hub endpoint in one place.
- **Fix it from Monitoring** — an issue's button can do the fix, such as **Reset machine** for a machine that is gone.
- **Message files** — a `.flowmsg` received as a file has its own chip and opens what it carries.
- **Context menu** — every context entry shows how it was added, and the menu filters by it.
- **Diagnosis messages** — an icon opens the context worker that ran the diagnosis.
- **Apps on Home** — each app gets a tile with its own face.

## Improved

- **Help button** — a larger icon counts your open requests, and the list splits what was asked of you from what you asked.
- **Tabs** — a coloured tab's border marks the selected one; **Add note** is a sticky-note icon.
- **Notes** — no colour is the composer's default, and clicking the chosen colour again clears it.
- **Display** — a web page or app has one toolbar row, with history in the viewer's address bar.
- **Vibe-only chat** — a large **Close** at the right of the display row closes its tabs and goes Home; **Chats** from a chat opens Past builds.
- **Stream Inbox filters** — the picked channel stands out, and the **Unread** pill and empty state speak for the filtered channel.
- **Replies** in Flowpad's chat quote the message instead of opening a thread.
- **Home page picker** shows a spinner while it loads.

## Fixed

- Clearing a remembered Stream Inbox channel filter works, and the whole **Showing** chip clears it.
- Hebrew copied from Claude Code on Windows pastes in the order it was written.

---
release: 0.2.265
from: v0.2.264
to: HEAD
source_hash: 33bfcfe96384bbd7
---

# Flowpad 0.2.265

*Released Nov 13, 2026*

## New

- **Phone layout** — below 768px every screen gets one phone top bar and menu; an email link opens the conversation, and the reply box is phone-friendly.
- **Monitoring** — issues arrive as cards in a Monitoring conversation with their status, a fix button and a seen mark; an issue's page reads as a report, and its fix buttons open the project or deployment they are about.
- **Slack** — set it up by signing in with Slack, as you.
- **Preferences** — a redesigned page with a **Trace logging** tab that smart search can open.
- **Hub project Git** — a **Git** button shows the clone command, branches, who has access and recent commits.
- **Open in browser** — a globe on every place that shows an HTML file opens it in your system browser.
- **Sessions** — a session can wait for a reply, and can repeat a check as one automation that counts its runs and ends.
- **Prompt requests** — the host sees the answer and can open the run; the sender can run a failed prompt again.
- **Release notes** — the version popover opens the notes for each release.
- **Outdated CLI warning** — Flowpad warns when a harness CLI is out of date.
- **Assets sidebar** — the header **+** creates any type, even one the project has none of yet.
- **App tab** — a refresh button in the address bar.
- **Ask for help** — an image dropped on the dialog is attached.

## Improved

- **LLM sources** — three tabs over one table and one endpoint dialog; model sizes are set on each endpoint, a key on this machine shows as an endpoint, and Vertex endpoints work.
- **Messages** — the favorite star sits before the name; **Reply**, **Forward** and **Forward to worker** are labeled under the body.
- **Inbox** — clicking a channel shows only that channel, ⌘/Ctrl-click adds or removes it; a share row names what was shared, and only open or refused shares get a chip.
- **Chat list** — hovering a row's status mark opens a card with the status, the CLI's own error words and the last prompt.
- **Chats** — a chat opens on the newest page of its history, and an answered question no longer reads as waiting once the session works past it.
- **Chat about this file** — the agent is told which file you are asking about.
- **Live sessions** — one open session per guest, so another member's prompt waits for its own **Approve**.
- **Agents** — a machine running a deployed agent signs in as that agent's identity.
- **Terminal links** — a command or path wrapped over several rows opens whole from any row.
- **Tabs** — a note with only a colour colours the tab.
- **Address bar** — a cloud or local icon before the project name.
- **Project list** — **+** and Git shortcuts next to **Open project**.
- **Git** — a merge conflict shows only as the footer's **Resolve** chip, not as an alert.
- **Warnings** — informational warnings are not counted, and the "Cloud is not available" alert is gone.
- **Project cleanup** — folders with no project record are moved to the trash.
- **Speed** — a page load fetches each shared list once, opening a project reads its dependencies once, and the LLM endpoint list answers right away.
- **Opening your computer from another device** — a refused page says why, and what happened just before it.
- **`flow diagnose <request id>`** — works on a machine that is not signed in.
- **Connections** — `Connection.connect(scopes=...)` asks for an optional scope, and `flow connections test --scope` counts a scope the provider granted.
- **Mockify** — a mock is a tree of screens and actions with a persona, and the mock project keeps its data across a restart.

## Fixed

- On Windows, web apps and dev servers are no longer lost when the system reports their ports oddly.
- A working data source is no longer parked by a save.
- A hub project's Deployments page opens instead of "Invalid asset pointer".
- A member's organization page no longer raises "Cloud Request Failed".
- A terminal that starts slowly no longer holds up the rest of the page, and terminal output reaches every open browser in order.
- An automation whose file was removed by a pull stops firing.
- Tasks channels and sources Flowpad makes itself no longer land in a project folder.
- Changing a schema updates the schemas that refer to it.

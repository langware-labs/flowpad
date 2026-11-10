---
id: bf59ac8c-d5fa-5713-af0c-904a86740082
release: 0.2.263
from: v0.2.262
to: v0.2.263
source_hash: ffca550d61830b11
---
# Flowpad 0.2.263

*Released Nov 10, 2026*

## New

- **Secured transfer** — send a credential by name and key; the receiver saves it with one **Accept**.
- **IT messages** — each operation is one conversation, and every send shows the machines that answered in a table (status, response, open the machine).
- **Messages** — delete your own message within 15 minutes of sending it.
- **Scheduled check-ins** — a session can set a one-time callback into itself to check something later.
- **Invites** — refill a budget per line or in bulk, and add invites with your own codes.
- **Tags** — one tag field on every item replaces labels.

## Improved

- **Inbox** — channels move to the top row; channels that need attention share one chip.
- **Toasts** — **Clear all** above a stack of more than two, **Dismiss** beside a toast's own buttons.
- **Help desk** — one status control, the status on every ticket row, and staff can read a ticket's messages before picking it up.
- **Automations** — a saved rule opens as three plain lines, and the time zone is no longer hidden under "Advanced".
- **Chat list** — every row shows its worker status icon.
- **Stream inbox** — the From / Subject / Date filters stay in the page link.
- **Setup questions** — their text is shown as formatted markdown.
- **First-agent wizard** — the Slack agent connects with your own sign-in, names the right channel, and can remove a machine you abandoned.
- **Auto-launch** — offers every budget your account may use.

## Fixed

- **Live sessions** — a session from another machine always waits for your **Approve**; nothing is approved automatically anymore.
- Shared apps, documents, files and projects open after you install them (no more "Missing asset").
- A credential set for you before a project was cloned is found by that project.
- A private setting of a shared data source stays on your machine.
- A plain terminal comes back after the backend restarts.
- A terminal link with a space in a folder name opens as one link.
- One person known by both account and email shows as one contact.
- Starting a new conversation no longer fails.
- Clicking the tag field in a breadcrumb card no longer opens the ask box.
- A long-running worker is marked timed out only after 10 minutes of silence, not 90 seconds.

## Upgrade notes

- On upgrade, labels are turned into tags automatically, and a data source you received drops its sender's private settings — enter your own if it asks.


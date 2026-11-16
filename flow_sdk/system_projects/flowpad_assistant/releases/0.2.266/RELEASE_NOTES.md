---
release: 0.2.266
from: v0.2.265
to: HEAD
source_hash: 0330e24ef63ae7a5
---

# Flowpad 0.2.266

*Released Nov 15, 2026*

## New

- **Context button** — the navigation bar lists everything an item holds in context and everything that holds it, each with its time; a row opens that item, a conversation lists its tasks, and a received transcript has the button too. Desktop only for now.
- **Network errors** — **Settings > General > Network errors** lists every failed cloud request, with **Clear**.
- **Prompt requests** — **Run** and **Decline** sit on the prompt itself, the host can run a finished request again, and the sender opens the run with **View run** to see the prompt, the tools it used and the answer.
- **Worker updates** — an out-of-date worker warning shows the old and new versions, and **Install** starts a session that does the upgrade.

## Improved

- **Phone layout** — the navigator opens as a drawer, dialogs open as bottom sheets, buttons are finger-sized, and actions that used to appear on hover are always visible on touch; the keyboard never covers the page, and a phone on its side is still a phone.
- **Cloud warnings** — a warning says when the request last failed and what to do, and a background check the cloud did not answer no longer leaves "Cloud Request Failed" up for hours.
- **Chain sessions** — the review step asks for a report only, with no files or actions.

## Fixed

- Turning a data source back on no longer sends it through setup again.
- Git push and pull no longer fail when a fetch runs at the same moment.
- A machine's reply in an IT conversation raises no notification and arrives already read.

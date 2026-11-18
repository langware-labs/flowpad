---
release: 0.2.272
from: v0.2.271
to: HEAD
source_hash: a3162c0218f7c1ba
---

# Flowpad 0.2.272

- **Stream Inbox is the first screen** — a launch with no last place opens the Stream Inbox.
- **Message tags** — a one-tag classifier sorts incoming messages under a tag tree you edit, with a Try panel to test a tag on a message; each Stream Inbox row shows its tag cell.
- **Tags start automations** — the classifier is the first automation, and a rule's Then is a list of steps.
- **Stream Inbox rows** — an icon-only source chip, a star on hover, and a Starred view.
- **Read/unread follows the provider**, starting with Gmail.
- **Gmail: Sign in with Google** beside the app password; the consent asks only for mail.
- **HTML emails** render as the page they are, in a sandboxed frame.
- **.docx files** open by their extension, like PDF and images.
- **Ticket page** draws both sides at once.
- **Live sessions** — a guest waiting for approval can cancel the request; a refused turn ends with its reason; a shown folder opens as a folder.
- **Agent page** — an agent's packages are asked under its own project, and the server's reason is shown.
- **Trust** — a project dependency is trusted even under a trusted folder.
- **Fixes** — the classification settings reject a non-boolean `enabled`; a worker that ends on its own error line raises with that line.

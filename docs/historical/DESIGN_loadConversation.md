---
id: cea68048-7fbf-59cf-8316-fc6b9be99407
---

# Design: `loadConversation` Loader — moved

This design has been folded into the collaboration docs section. See:

➡️ [`docs/collab/hub-fanout-and-loader.md`](docs/collab/hub-fanout-and-loader.md)
— "Conversation Loader" covers the URL-first loader cascade (conversation
hard-required → parent task silent-optional → project cascade → context writes →
prefetch), the route wrapper, and the design rationale (series-not-parallel,
silent-fail on task 404, no loader-specific timeout).

Related: [`docs/collab/`](docs/collab/index.md) is the full collaboration
architecture section (conversation model, messages/attachments, sharing/sync,
invites/members/identity, hub fan-out).

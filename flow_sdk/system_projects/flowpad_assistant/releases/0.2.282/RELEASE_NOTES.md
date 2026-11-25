---
release: 0.2.282
from: v0.2.281
to: HEAD
source_hash: b3634f798a38bd13
---

# Flowpad 0.2.282

*Released Nov 25, 2026*

## New
- **Agents in Flowpad conversations** — add an agent to a conversation from New conversation or the contacts book's new Agents tab, where agents show a bot icon. Its creator adds the "Flowpad Conversations" channel to the agent, the same way as Slack or Telegram, and the agent answers in every conversation it was added to. If the channel stops while the machine is signed out, it picks up again by itself once the machine signs back in as the agent.
- **New agent wizard** — a "Setup from scratch →" button on the wizard's first step leaves the wizard for the plain new-agent form.

## Improved
- **Agent deployments** — a new deployment now signs in under its own identity by default, whether you deploy from the New deployment dialog, the first-agent setup or `flow agent deploy`. Changing an existing deployment's token allocation keeps the identity it already has.
- **Conversation page** — opens on a machine signed in as an agent instead of asking for a login. A signed-out person still gets the sign-in prompt.

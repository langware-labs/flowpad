---
id: 0c53e7ba-ad93-4d1e-96a8-bafa02377f59
title: Slack channels
---

# Slack channels

A new Slack [[Data sources|data source]] says **needs setup**. That is expected,
and it is not an error: Slack will not let an app read a channel nobody invited
it to, and no setting on our side can change that. Two minutes of work in Slack
finishes it.

## The three steps

1. **Connect Slack.** Settings → Connections → Slack. This authorizes the
   workspace once; every Slack source afterwards reuses it.

2. **Add the channel IDs** to the source. Use the **ID**, not the name — in
   Slack, click the channel name, and the ID (`C…`) is at the bottom of the
   panel that opens. A renamed channel keeps its ID, so keying on the ID means a
   rename never forks its history.

3. **Invite the bot to each channel.** In the channel, type:

   ```
   /invite @Flowpad
   ```

   For a private channel this is the only way in — there is no admin setting
   that grants it.

Then press **Verify** on the source card.

## What Verify checks

It asks Slack for one message from each channel — the cheapest question with the
right answer. Scopes, membership and the token are all visible in the reply.

- **All channels readable** → the source becomes **active** and polls on its
  schedule.
- **Some channel still refuses** → the source stays in **needs setup** and names
  the channels that are still missing. Invite the bot there and press Verify
  again; it is safe to press as often as you like.

It is all-or-nothing on purpose. A source reading three of five channels looks
like it is working, so nobody goes looking for the two that are missing.

## When Verify says something else

- **"No Slack credential is available"** — step 1 has not happened on this
  machine, or the connection was made as a different user. Reconnect from
  Settings → Connections.

- **"The Slack app is missing the history permission"** — the app itself is
  missing `channels:history` (and `groups:history` for private channels). No
  amount of inviting fixes this; a workspace admin has to add the permission,
  and everyone reconnects afterwards.

- **`channel_not_found`** — usually a channel *name* entered where an ID was
  expected, or a channel in a different workspace than the one you connected.

## Why the bot has to be invited at all

Slack scopes an app's read access per channel, not per workspace. That is a
privacy property, not an obstacle: a channel the bot was never invited to is one
Flowpad cannot see, and you can revoke that at any time by removing the bot from
the channel. The source will report the channel as pending again on its next
Verify.

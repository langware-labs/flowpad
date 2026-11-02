Connect Slack — one of three ways.

**Your own app (the default: everything you are in, live).** Data Sources → Add → Slack → **Connect Slack**
runs the `slack-connect` wizard: Flowpad cloud hands out a public URL, a link creates your Slack app from a
manifest that already names it (user scopes, event subscriptions, Request URL), you select your workspace → Next → Create and Install →
Allow, paste the **User OAuth Token** (`xoxp-…`, OAuth & Permissions), and say hi. Replies are posted as you. By hand, or as an agent: create
the app at https://api.slack.com/apps "From an app manifest" with user scopes `channels:history`, `groups:history`,
`im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`, `chat:write`,
`files:read`, `files:write`, `reactions:read`, `reactions:write` and user events `message.channels`,
`message.groups`, `message.im`, `message.mpim`, `reaction_added`, `reaction_removed`; pipe the lines
`SLACK_USER_TOKEN=<xoxp token>` into
`flow credentials set slack_channel --stdin`; then `flow source step <source> public-webhook`, `… app`,
`… public-webhook` again (the proof) and `… verify`. The source has NO channel configured.

**One channel as your own bot** (replies come from the bot): at https://api.slack.com/apps create an app
"From scratch", add the Bot Token Scopes `channels:history`, `groups:history`, `channels:read`, `chat:write`,
`channels:join`, install it to the workspace, and copy the Bot User OAuth Token (`xoxb-…`). Pipe
`SLACK_BOT_TOKEN=<token>` into `flow credentials set slack_channel --stdin`. Configure the source's `channel`
and invite the bot to it (`/invite @<bot>`).

**Sign in with Slack** (one channel, replies come from you): connect Slack in Flowpad
(`flow connections connect slack`), then record the way with `flow credentials set slack_channel signin`.

Confirm with `flow credentials check slack_channel`. Never print or repeat a token or secret.

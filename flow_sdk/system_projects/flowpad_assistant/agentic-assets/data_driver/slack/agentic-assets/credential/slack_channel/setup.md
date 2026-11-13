Connect Slack — one of three ways.

**Sign in with Slack (the default: everything you are in, as you).** Data Sources → Add → Slack → Setup →
**Sign in**, then Allow in Slack. Reads every DM, group DM and channel you are in and replies under your name.
As an agent: `flow connections connect slack`, then `flow credentials set slack_channel signin`. The source has
NO channel configured. New messages arrive on the next poll.

**Your own app (everything you are in, as you, live).** Replies are posted as you and new messages arrive as
they happen, through your app's Request URL. Create
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

Confirm with `flow credentials check slack_channel`. Never print or repeat a token or secret.

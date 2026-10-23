Connect Slack — one of two ways: your own bot (replies come from the bot), or a Slack sign-in (replies come from you).
1. Ask which way they want:
   - **Your own bot** — at https://api.slack.com/apps create an app "From scratch", add the Bot Token Scopes `channels:history`, `groups:history`, `channels:read`, `chat:write`, `channels:join`, install it to the workspace, and copy the Bot User OAuth Token (`xoxb-…`). Pipe `SLACK_BOT_TOKEN=<token>` into `flow credentials set slack_channel --stdin`. Then invite the bot to the channel (`/invite @<bot>`).
   - **Sign in with Slack** — connect Slack in Flowpad (`flow connections connect slack`), then record the way with `flow credentials set slack_channel signin`. Replies are posted as the person who signed in.
2. Confirm with `flow credentials check slack_channel`. Never print or repeat the token.

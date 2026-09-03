---
id: 0e60e3ba-93df-4623-9048-3e8a7bb2c31c
---

# Attached channels — one bar, two owners

precondition: an instance is up with ONE message source owned by the local user
(a connected Slack channel is the easiest: `scripts/instance_ctl.sh launch slack-6`,
connect Slack under Credentials, add a `slack` source for a channel id) and at
least one Agent. The instance must have run the owner backfill
(`uv run -m flow_sdk.migrations.migration_2026_09_owner_backfill --apply`) OR the
rows must have been created after `owner` existed — the bar treats an unowned row
as the local user's either way, but the disjointness check below assumes the
agent's rows carry `owner`.

What is being proved: the bar is one component over `DataSource.owner` and the
spec's `sends` flag. The user's inbox and each agent's inbox show DISJOINT rows,
the toggle is the same verb the Data Sources card uses, and "+" from an agent's bar
creates a source the agent owns.

test 1: the user's bar shows the user's channels, lit
- [browser] navigate to {APP_URL}/dock/inbox
- [browser] validate data-testid="attached-channels" has data-owner starting with `user-`
- [browser] validate exactly one data-testid="attached-channel" with data-provider="slack" and data-status="active"
- [browser] hover it; the tooltip reads "<name> · listening"

test 2: click = pause, click = resume, the card agrees
- [browser] click the slack icon
- [browser] validate it now has data-status="disabled" and class contains `opacity-50`
- [api] GET /api/v1/graph/data_source/<id> — `status` is `disabled`
- [browser] click it again; a toast says "Resumed — it polls on the next tick."
- [api] `status` is `setup` (Slack owes a Verify) — the icon carries the red badge
- [browser] click the badged icon: the Data Sources tab opens (URL /dock/data-sources)
- [browser] press Verify on the card; back on the inbox the icon is lit again

test 3: "…" folds the row when it is short
- [browser] with 3+ channels, shrink the window until the bar has fewer than (channels + 1) slots of 32px
- [browser] validate data-testid="attached-channels-more" is visible and the hidden channels are listed in its menu with the same toggle
- [browser] validate data-testid="attached-channels-add" stays visible

test 4: an agent's bar is its own
- [browser] navigate to {APP_URL}/dock/agent/<agent-id>/inbox
- [browser] validate data-testid="attached-channels" has data-owner `agent-<agent-id>` and NO data-testid="attached-channel" (the user's Slack is not there)
- [browser] click data-testid="attached-channels-add"; only providers whose spec `sends` are offered (no rss / folder)
- [browser] pick Slack, name it, paste the channel id, Add source
- [browser] the icon appears in the agent's bar at once (status `setup`, badged) and the agent's inbox list renders
- [api] the new row's `owner` is `agent-<agent-id>`
- [browser] back on {APP_URL}/dock/inbox the user's bar still shows only the user's source

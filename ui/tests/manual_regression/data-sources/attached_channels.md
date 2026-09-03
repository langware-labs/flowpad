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
and the toggle is the same verb the Data Sources card uses.

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

test 4: an agent's bar is its own
- [api] create a slack source with `owner: "agent-<agent-id>"` (POST /api/v1/graph/data_source)
- [browser] navigate to {APP_URL}/dock/agent/<agent-id>/inbox
- [browser] validate data-testid="attached-channels" has data-owner `agent-<agent-id>` and exactly one data-testid="attached-channel" (the agent's), badged `setup`
- [browser] the agent's inbox list renders (not the "no channel" empty state)
- [browser] back on {APP_URL}/dock/inbox the user's bar shows only the user's source

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

What is being proved: the header line is one component over `DataSource.owner`
and the spec's `sends` flag. The user's inbox and each agent's inbox show
DISJOINT rows, and chip-present / chip-removed is the same pause/resume verb the
Data Sources card uses.

test 1: the header line shows the user's channels as chips
- [browser] navigate to {APP_URL}/dock/inbox
- [browser] validate data-testid="inbox-select-all-row" holds data-testid="attached-channels" with data-owner starting with `user-`
- [browser] validate exactly one data-testid="attached-channel" with data-provider="slack" and data-state="on", showing the coloured Slack mark and the source name
- [browser] validate every conversation row's source chip (data-chip-type="source") shows the same coloured mark

test 2: × turns a channel off, + turns it back on, the card agrees
- [browser] click the chip's data-testid="attached-channel-remove"
- [browser] the chip is gone; [api] GET /api/v1/graph/data_source/<id> — `status` is `disabled`
- [browser] click data-testid="attached-channels-add"; the menu lists the source (data-testid="attached-channel-off"); pick it
- [browser] a toast says "Resumed — it polls on the next tick."; the chip is back
- [api] `status` is `setup` (Slack owes a Verify) — the chip is amber with data-testid="attached-channel-fix"
- [browser] click that warning: the Data Sources tab opens (URL /dock/data-sources)
- [browser] press Verify on the card; back on the inbox the chip is plain again

test 3: the + menu when everything is on
- [browser] with every channel on, open +: one disabled line "Every attached channel is on" and "Attach a channel in Data Sources…", which opens that screen

test 4: an agent's bar is its own
- [api] create a slack source with `owner: "agent-<agent-id>"` (POST /api/v1/graph/data_source)
- [browser] navigate to {APP_URL}/dock/agent/<agent-id>/inbox
- [browser] validate data-testid="attached-channels" (in the inbox header line) has data-owner `agent-<agent-id>` and exactly one data-testid="attached-channel" (the agent's), amber with the fix warning
- [browser] the agent's inbox list renders (not the "no channel" empty state)
- [browser] back on {APP_URL}/dock/inbox the user's bar shows only the user's source

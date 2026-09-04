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
DISJOINT rows; a mark filters the list, the details popover carries the one
pause/resume verb the Data Sources card uses, and + creates a source born with
that owner.

test 1: the header line shows the user's channels as round marks
- [browser] navigate to {APP_URL}/dock/inbox
- [browser] validate data-testid="inbox-select-all-row" holds data-testid="attached-channels" with data-owner starting with `user-`
- [browser] validate exactly one data-testid="attached-channel" with data-provider="slack" and data-state="on" (green dot, coloured Slack mark), plus data-testid="attached-channels-add" and data-testid="attached-channels-details"
- [browser] validate every conversation row's source chip (data-chip-type="source") shows the same coloured mark

test 2: a mark filters; × shows everything again
- [browser] click the mark: it gains a ring (aria-pressed="true"), the other marks dim, the two controls are replaced by data-testid="attached-channels-clear", and only rows whose latest message came through that source stay listed
- [browser] click ×: every row is back, the + and details controls return

test 3: the details popover is where on/off and delete live
- [browser] click data-testid="attached-channels-details": one data-testid="attached-channel-row" per channel with its switch and trash
- [browser] flip the switch off: the mark's ring turns dashed; [api] GET /api/v1/graph/data_source/<id> — `status` is `disabled`
- [browser] flip it on: a toast says "Resumed — it polls on the next tick."; [api] `status` is `setup` (Slack owes a Verify) and the mark wears the "!" badge with "Finish setup, then press Verify." under its name
- [browser] "Manage in Data Sources…" opens that screen; press Verify; back on the inbox the mark has its green dot
- [browser] the trash asks "Remove this source?" — cancel

test 4: an agent's bar is its own
- [browser] navigate to {APP_URL}/dock/agent/<agent-id>/inbox; the line shows no mark of the user's
- [browser] click +, pick Slack, name it, paste a channel id, Add source
- [browser] validate data-testid="attached-channels" (in the inbox header line) has data-owner `agent-<agent-id>` and exactly one data-testid="attached-channel" (the agent's), with the "!" badge
- [browser] the agent's inbox list renders (not the "no channel" empty state)
- [browser] back on {APP_URL}/dock/inbox the user's bar shows only the user's source

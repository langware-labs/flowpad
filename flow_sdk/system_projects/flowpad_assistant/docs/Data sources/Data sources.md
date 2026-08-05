---
id: 3d75ef1d-1193-4598-ac42-aeede60db918
title: Data sources
---

# Data sources

A **data source** is a remote system Flowpad syncs from — a feed, a mailbox, a
Slack workspace. Each one polls on its own schedule, keeps its own position, and
turns what it finds into records you can search, open and reply to.

They live on the **Data sources** screen in the left rail.

## What's inside

- [[Slack channels]] — why a new Slack source says **needs setup**, and the two
  minutes of work that finishes it.

## Status, and why it is not "on / off"

A source shows one of four states, and they answer *should this be running*:

- **new** — just created; Flowpad is deciding what it needs. You will rarely
  see it.
- **needs setup** — something has to be done outside Flowpad first (for Slack,
  inviting the bot to each channel). It is not broken and it is not paused; it
  simply is not finished. Press **Verify** when you have done it.
- **active** — running on its schedule.
- **paused** — you stopped it. Nothing polls until you resume it.

That is a separate question from **health**, which answers *does it work*: `ok`,
`retrying`, `needs attention`. A paused source has no meaningful health, and an
active one can still be unhealthy — so the card shows the lifecycle first and
health once the source is actually running.

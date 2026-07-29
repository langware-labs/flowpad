---
id: 05633604-7cd5-479d-8465-80f850cc0099
title: Data privacy modes
---

# Data privacy modes

Flowpad has one switch that decides whether anything you do can reach Flowpad's
cloud. You'll find it in the footer, next to the view controls — a shield when
it's off, a cloud when it's on.

There are exactly two settings.

## Local

> No data leaves this machine. Sharing and login are disabled. Auto-update stays
> active.

Nothing you create can travel. Sharing is refused, signing in is refused, and
the app cannot build a cloud address to send anything to even if some part of it
tried.

## Connected

> When data is shared on a conversation, it is sent to all members using Flowpad
> cloud.

This is the default. Note what it does *not* say: Connected is not "sync
everything". It means sharing is **permitted**. Something leaves this machine
when you deliberately share it — start a conversation, assign a task, invite
someone to a project. An asset you never share stays exactly where it is.

## What Local mode turns off

| You try to… | What happens |
| --- | --- |
| Share an asset, or assign a task to someone | *Sharing disabled in Local mode* |
| Sign in to your cloud account | *Login disabled in Local mode* |
| Open conversations | *Unavailable in Local mode* — conversations use Flowpad cloud |
| See project members | *Members are unavailable in Local mode.* |
| Report an issue to support | *Reporting is disabled in Local data privacy mode* |

## This is enforced, not just hidden

The buttons don't merely grey out. The refusal lives in the backend, so the
guarantee holds even for something driving the API directly:

- Outbound cloud requests have nowhere to go — in Local mode the app resolves
  **no** cloud address at all, so there is no HTTP call to intercept.
- The share and task-assign endpoints reject the request outright.
- The sign-in routes reject the request outright.
- Background mirroring of your edits to the cloud is switched off.

## What it does *not* cover

Worth being straight about, so you can make an informed choice:

- **Auto-update still runs.** This is deliberate — you keep getting fixes. It
  uses the update feed, not your data.
- **This setting is about Flowpad's own cloud.** It says nothing about traffic
  from other things you've connected — the model provider behind a coding
  agent, or an MCP server you've configured. Those are separate decisions, made
  where you configured them.

## Where the setting lives

One setting for this whole Flowpad instance — every project and every asset on
it — saved on this machine and applied the moment you flip it. It is not
per-project, and it does not follow your account to another machine.

## What it means for a file you already have

Every asset carries a badge saying whether it is local, on the cloud, or in a
git repo — and switching modes does not rewrite the past. That half of the
story lives in [[Where your assets live]].

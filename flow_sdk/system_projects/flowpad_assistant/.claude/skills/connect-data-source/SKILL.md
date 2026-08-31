---
id: aa478f19-3dad-4794-a34a-9e6863d50860
name: connect-data-source
description: >-
  Connects a data source to Flowpad end to end — "connect my Notion", "pull my RSS
  feeds in", "sync these Slack channels", "watch this git repo", "index my Google
  Drive", "start ingesting my mail" — turning the request into a source that
  actually produces records, then showing the Data Sources screen. Also diagnoses a
  source that is failing, empty, stuck in setup or parked ("my feed stopped
  updating", "nothing is syncing", "the source says it needs setup"). Subcommands:
  `author <system>` writes a new source type when nothing installed fits, `debug
  <name>` diagnoses one, `define <source>` gives a connected source's items an
  output shape, dataset and gold labels ("label these", "make a training set from
  this feed"), and `list` shows what is connected. NOT for enrolling this machine
  as a compute node, an OAuth authorisation on its own, Flowpad itself being broken
  (flow-diagnose), or creating records (flowpad-assistance).
tags: ''
version: 1
---

# connect-data-source

A data source is one remote account or tree that Flowpad syncs from — a feed, a
mailbox, a channel, a repository, a folder. This skill turns *"pull my X in"*
into a source that demonstrably works, and shows it to the user.

> **Ground rules (inline by design, repeated in every mode file):**
> **1. Evidence, never events.** A verb returning 200 is not proof. `poll_now`
> only marks a source due — the heartbeat picks it up within 60s — so "I polled"
> is never "items landed".
> **2. Read before you poke.** `poll_now` clears `health`, `error_code` and
> `error_detail` together. Snapshot first or you destroy the only evidence.
> **3. Never widen a wait, a timeout, or a retry to make something pass.**
> **4. Never destroy the user's data to fix a symptom** — `purge_items` and
> `delete` discard records and their read/starred state. Only on explicit
> request, having said the cost out loud.
> **5. Say what is the user's step.** Credentials, OAuth and bot invites are
> theirs. Name the exact click; never loop waiting for it.

## Modes (from the skill arg)

The FIRST whitespace-separated token, if it is exactly `author`, `debug`,
`define` or `list`, selects that mode. **Anything else is a natural request** — so
"debug my rss feed" is debug mode, while "connect my debug server's logs" is a
connect request.

| Skill arg | Load | What it does |
| --- | --- | --- |
| *(none)*, or a natural request — **the default** | `modes/connect.md` | Map the request onto a source, configure it, prove each gate, show it |
| `author <system>` | `modes/author.md` | Write a NEW source type (`data_source.json` + `fetch.py`), index it, then connect it |
| `debug [<source>]` | `modes/debug.md` | Ordered diagnosis of a source that is failing, empty or stuck |
| `define <source>` | `modes/define.md` | Sample the items, agree an output shape, create the dataset bound to the source, label an example |
| `list` | *(inline, below)* | Read-only — what is connected and how healthy it is |

### `list` — the read-only answer

"What sources do I have?" is a question, not a diagnostic. Run
`python3 <skill>/scripts/source_ctl.py list` and report `name`, `provider`,
`status`, `health` and `last_synced_at`. Do not verify, poll or change anything.
If one looks unhealthy, offer `debug` — do not start it.

## The five gates

Every mode ends by making these true, in order, and **stops at the first that
fails** with what the user must do:

| Gate | Passes only when |
| --- | --- |
| **setup** | An installed spec covers the request, and its credential need is known and met |
| **connect** | The row exists, a read-back confirms every field applied, and `verify` is `ready` (or names what a human must do) |
| **test** | **Records actually landed** — `observe` returns `items`, or `empty_but_healthy` with the window explained |
| **use** | The content is findable — `flow record search`, or the reflected file opens |
| **view** | `flow show view data-sources` and the card is in the listing |

## Reference

| When you need to… | Load |
| --- | --- |
| turn a person's words into a provider + config | `references/mapping.md` |
| run any mechanic — specs, create, verify, poll, observe, snapshot | `scripts/source_ctl.py` |
| sample items, create a dataset, promote, annotate, snapshot counts | `scripts/dataset_ctl.py` |
| the gate-safe transport both scripts share (never call it directly) | `scripts/_ctl_common.py` |
| know what a manifest may declare | `docs/data-management/data-source-asset.md` (repo) |
| know how the sync loop, health and reflect behave | `docs/data-management/data-sources.md` (repo) |
| present something to the user, or take them somewhere | the `flowpad-navigation` skill |

## Showing the user

`flow show view data-sources` opens the Data Sources screen beside the work
without interrupting it — in a vibe session it becomes a child tab of the
workspace. Use it at the **view** gate, once there is something worth looking at.
`flow show entity <typeid>` pins one record. For "take me there instead", defer
to the `flowpad-navigation` skill — it owns that decision.

Exit codes from `flow show`: `0` recorded · `2` bad address · `3` no active tab
· `5` server down. `0` means the target was recorded, **not** that the user
looked at it — never claim they saw it.

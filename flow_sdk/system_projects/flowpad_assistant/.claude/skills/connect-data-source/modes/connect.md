# Mode: connect — a request becomes a working source

> **Ground rules (inline by design):**
> **1. Evidence, never events.** A 200 is not proof; `poll_now` only marks a
> source due, so "I polled" is never "items landed".
> **2. Read before you poke** — `poll_now` clears `health`, `error_code` and
> `error_detail` together.
> **3. Never widen a wait, a timeout, or a retry to make something pass.**
> **4. Never destroy the user's data to fix a symptom.**
> **5. Credentials and invites are the user's step** — name the exact click.

The default mode. The user said something like *"pull my RSS feeds in"*. Take it
through the five gates and stop at the first that fails.

`SC` below means `python3 <this skill>/scripts/source_ctl.py`.

## Gate 1 — setup

1. **`SC specs`.** Never work from memory: the installed set is data, and a
   source added as an asset appears here without any release.
2. **Map the request** using `references/mapping.md`. If nothing installed can
   express what the user named as a *segment*, say so and offer `author` mode —
   do not force a near-match. Pointing `rss` at a Notion export produces a
   source that syncs the wrong nouns and looks healthy.
3. **Credential need** comes from the spec's `auth`:
   - absent → nothing to do (rss, hackernews, folder, git).
   - `{env: [NAME]}` → the variable must be set **before the backend started**;
     a key exported afterwards is not visible to it.
   - `{connector, scopes}` → a human OAuth step. Say which provider, point at
     the Connections screen, and stop. Do not loop.

**Passes when** a spec is chosen and its credential is actually available.

## Gate 2 — connect

1. Build `config` per `references/mapping.md` — typed from `config`,
   empty values omitted, `pattern` checked per value before sending.
2. `SC create '<json>'`. Read `dropped` in the reply: the create route silently
   discards keys it does not recognise, so a non-empty `dropped` means a field
   did **not** apply. Fix and re-create; never report success over it.
3. `SC verify <id>`. Read `layer`:
   - `ready: true` **with** a layer → a real check ran.
   - `ready: true` with no layer → **nothing was checked.** Say "nothing to
     verify — the test gate is the proof", not "verified".
   - `ready: false` → `detail` is written for the user; relay it verbatim and
     list `pending`. This is a human step; stop here.

**Passes when** the row exists, `dropped` is empty, and verify is ready or has
named the human step.

## Gate 3 — test (the one that matters)

`SC poll <id>` then `SC observe <id>`. `observe` samples until one of three
outcomes, and **all three are legitimate answers** — report which:

| `outcome` | Means | Say |
| --- | --- | --- |
| `items` | records landed | it works, with the count |
| `empty_but_healthy` | synced, nothing new | **not a failure** — the window (`window_days`) or the digest gate. Check `window_days` before calling it broken |
| `stalled` | the cursor never advanced | read `health`/`error_code` and go to `modes/debug.md` |

Never extend `--wait` to turn `stalled` into a pass. The heartbeat ticks once a
minute by design.

**Passes when** `outcome` is `items`, or `empty_but_healthy` **and** you have
explained why nothing arrived.

## Gate 4 — use

Show the content, do not assert it. `SC items <id> --limit 5` for what landed;
`flow record search "<a phrase from an item>"` to prove it is findable. For a
files source (`reflect` is `copy`/`symlink`), check the paths exist under
`reflect_into` — if that is empty, nothing was placed anywhere and the source
still reads healthy.

## Gate 5 — view

`flow show view data-sources`, then `SC list` to confirm the card is in the
listing. Exit `0` means recorded, not seen — never claim the user looked at it.
Close by naming the source, what it produced, and its cadence — and offer the
next step: *"want to say what you need out of each item?"* → `modes/define.md`.

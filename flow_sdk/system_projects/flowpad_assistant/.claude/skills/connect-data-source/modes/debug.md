# Mode: debug — a source that is failing, empty, or stuck

> **Ground rules (inline by design):**
> **1. Evidence, never events.** A 200 is not proof; `poll_now` only marks a
> source due, so "I polled" is never "items landed".
> **2. Read before you poke** — `poll_now` clears `health`, `error_code` and
> `error_detail` together.
> **3. Never widen a wait, a timeout, or a retry to make something pass.**
> **4. Never destroy the user's data to fix a symptom.**
> **5. Credentials and invites are the user's step** — name the exact click.

**Rule 0, before anything else: `SC snapshot <source>`.** `poll_now` clears
`health`, `error_code` and `error_detail` in one breath, so polling first
destroys the only record of why it parked. Snapshot, then reason.

`SC` means `python3 <this skill>/scripts/source_ctl.py`.

## Ordered checks — stop at the first that explains it

1. **Is it the source they mean?** `SC list`. `SC` refuses an ambiguous name
   rather than guessing; if it does, ask which.

2. **`status`.**
   - `disabled` — a human paused it. Only a human un-pauses it. Say so; do not
     flip it.
   - `setup` — read `setup_detail` verbatim (it is written for the card) and
     check `verified_at`. The fix is the human step, then `SC verify`.

3. **`health` + `error_code`** from the snapshot:
   - `unknown_provider` — no driver for this `provider`. Marker: `status` is
     `active` and `segment_count` is 0. Either the name is a typo, or it is an
     authored spec whose folder is not indexed. Re-index the project and wait
     one tick.
   - `unauthorized` / `not_found` / `client_error` — config errors. The first
     is a credential, not a config field.
   - `rate_limited` / `server_error` — **transient. These never stop polling.**
     The correct action is to wait one or two cadence ticks and change nothing.
     Reporting a transient error as broken is a false alarm.
   - `config_error` — parked, and the poller refuses it until un-latched. This
     is the one state where `SC poll` is part of the fix, and only *after* the
     cause is fixed.

4. **Per-segment health** — the source rolls up the WORST cursor, so one dead
   feed makes a healthy source look broken. Report per segment: "4 of 5 feeds
   fine, this one 404s" is the actual finding and it is invisible from the row.

5. **No cursors at all** — it never enumerated. It failed before listing
   segments: unknown provider, or a capability gate.

6. **Credential gate** — a non-empty `required_capabilities` whose capability is
   unavailable means it silently never polls. That is a gate, not an error code.

7. **Healthy but empty — the most common false alarm.** `health: ok`, a recent
   `last_synced_at`, cursors advanced, no items. In order: (a) `window_days`
   excludes everything the provider has; (b) there is genuinely nothing new;
   (c) the user is looking in the wrong place — only `content.message.*` kinds
   reach the Inbox, so an RSS item is a record, not mail. Check `SC items`
   before believing "nothing arrived".

8. **Files-mode sources** — `reflect` is `copy`/`symlink` but `reflect_into` is
   empty ⇒ nothing is placed anywhere and it still reads healthy.

## Never

- Never `purge_items` or `replay` to "make it try again" — purge discards the
  user's read/starred state and re-mints ids, dangling every reference.
- Never `reset_cursors` alone and call it fixed: re-reading the same window
  finds digest-identical rows and writes nothing. It looks broken by design.
- Never delete the source — it cascades cursors *and* every record.
- Never lower `poll_interval_seconds` below 60; the heartbeat ticks once a
  minute regardless.
- Never raise a timeout or widen a wait to make a check pass.

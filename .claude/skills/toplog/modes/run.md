# Mode: `run <issue>` — trace the failure

The goal is traceability that *assists* root cause — turn on the streams that
illuminate the suspect path, reproduce, and feed the richer log into `/rca`.

1. **Pick topics.** Match the issue against the catalog (`../topics.md`) first;
   for areas the catalog doesn't cover, run `scripts/scan_topics.py` to see which
   topics existing `toplog.log` calls already emit near the suspect subsystem.
2. **Note gaps.** If the decisive code path has no `toplog.log` coverage, the
   trace can't help — say so and offer `learn` to add a topic there. The lever
   for a useful trace is coverage on the path that fails; aim activation there
   rather than at topics that miss it.
3. **Activate** on the surface that matches where the bug runs:
   * **Live backend** — `from flow_sdk import toplog; toplog.enable(); toplog.on("pty", "sync")`,
     or `POST /api/v1/toplog/enable` then `POST /api/v1/toplog/on {"topics":[...]}`,
     or edit `~/.flow/instances/<name>/toplog.json`.
   * **In-process pytest** — call `toplog.enable()` / `toplog.on(...)` in or before
     the test; it takes effect synchronously, so assert right after (no sleep).
     A spawned worker reads topics once at import, so toggle **before** spawning
     it (see the worker caveat in `docs/toplog.md`).
   * **Frontend** — `await toplog.enable(); await toplog.on('render')` (rounds
     through the route; state mirrors back).
4. **Reproduce** the failure with the topics on, and collect the
   `toplog`-prefixed lines (`[topic] …`) as the evidence trail.
5. **Hand to `/rca`** with that trail — toplog surfaces the evidence; RCA proves
   the on/off switch.
6. **Turn the topics back off** once captured (`toplog.off(...)` / `disable()`),
   so the system returns to quiet. Off is non-destructive — the topics stay in
   the catalog and code for next time.

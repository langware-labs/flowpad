---
id: 4579522b-4226-43e9-af47-fa4de1429d0e
---
# Mode: `run <issue>` — trace the failure

The goal is traceability that *assists* root cause — turn on the streams that
illuminate the suspect path, reproduce, and feed the richer log into `/rca`.

1. **Pick tags.** Match the issue against the catalog (`../tags.md`) first;
   for areas the catalog doesn't cover, run `scripts/scan_tags.py` to see which
   tags existing `toplog.log` calls already emit near the suspect subsystem.
   Terminal slowness, lag, garbled/blank panes, dropped keys, slow tab switches
   → `pty` (read its playbook in `../tags.md`).
2. **Note gaps.** If the decisive code path has no `toplog.log` coverage, the
   trace can't help — say so and offer `learn` to add a tag there. The lever
   for a useful trace is coverage on the path that fails; aim activation there
   rather than at tags that miss it.
3. **Resolve the instance** the bug runs on (`FLOW_INSTANCE`, default `prod`;
   this checkout is `oss`) and its backend port
   (`~/.flow/instances/<name>/server.json`, or `flow instance ctl port <name>`).
   Before activating, confirm that instance runs code containing the tag's
   log points: its backend started after they landed (`flow instance ctl
   status <name>`), and open pages were reloaded since (frontend points load
   with the page). A release install (e.g. `prod`) has only the points shipped
   in its installed version. An old process emits nothing, which reads as "the
   bug left no trace" — so when the code is older, say so and ask the user
   before restarting their instance.
4. **Activate** on the surface that matches where the bug runs:
   * **Live app (backend + frontend at once)** — the REST routes; the backend
     writes `toplog.json` and broadcasts, so every open tab starts tracing
     without a reload:
     ```bash
     P=<backend port>
     curl -s -XPOST localhost:$P/api/v1/toplog/enable
     curl -s -XPOST localhost:$P/api/v1/toplog/on -H 'content-type: application/json' -d '{"tags":["pty"]}'
     ```
     Or from Python in the backend process: `toplog.enable(); toplog.on("pty")`,
     or edit `~/.flow/instances/<name>/toplog.json`.
   * **In-process pytest** — call `toplog.enable()` / `toplog.on(...)` in or before
     the test; it takes effect synchronously, so assert right after (no sleep).
     A spawned worker reads tags once at import, so toggle **before** spawning
     it (see the worker caveat in `docs/toplog.md`).
   * **Frontend only** — `await toplog.enable(); await toplog.on('pty')`
     (rounds through the route; state mirrors back).
5. **Restart survival — only when the user asks.** Activation does NOT survive a
   backend restart by default: boot resets the tags and the master switch. If the
   bug needs a restart to reproduce (PTY recovery, "dies after restart") AND the
   user asked to keep tracing across it, persist:
   `curl -s -XPOST localhost:$P/api/v1/toplog/persist -H 'content-type: application/json' -d '{"persist":true}'`.
   Never persist on your own initiative.
6. **Reproduce** the failure with the tags on (or ask the user to), and read the
   trail live. Backend and frontend lines land in the same instance log:
   ```bash
   L=$(ls -t ~/.flow/instances/<name>/logs/*.log | head -1)
   tail -f "$L" | grep --line-buffered 'toplog'     # `toplog:` = backend, `toplog.client:` = frontend
   ```
   Frontend lines also stay in the browser console as `[toplog:<tag>]`
   (arrive in the log within ~1s — they are batched).
7. **Hand to `/rca`** with that trail — toplog surfaces the evidence; RCA proves
   the on/off switch.
8. **Turn it back off** once captured, so the system returns to quiet:
   `POST /api/v1/toplog/off {"tags":[...]}` (and `POST /persist {"persist":false}`
   if you persisted). Off is non-destructive — the tags stay in the catalog and
   code for next time.

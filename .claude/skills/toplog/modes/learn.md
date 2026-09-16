---
id: 6a718120-83db-4e5c-a14e-d0d42634ce00
---
# Mode: `learn` — consolidate what helped

Run this after a root cause is proven (or whenever coverage gaps surface), to turn
a debugging session into durable traceability. Make the smallest change that
captures the lesson:

* **Enrich an existing tag** — extend its `../tags.md` entry (more **Where**,
  sharper **Use for**) so next time the right tag is obvious. One heading per
  tag; integrate, don't append a second entry.
* **Add a new tag** — a tag is a switch over log points: plain one-line-per-event
  `toplog.log` calls placed at the points past RCAs / the failure name, never
  aggregators, samplers, or helper modules. Log only events (not payloads like
  keystrokes or bytes); on hot paths rate-limit to ≤1/s. Add the code and a
  `### <tag>` entry to `../tags.md` together. Verify on a disposable instance
  with real traffic (`scripts/instance_ctl.sh launch <name>` … `kill <name>`):
  count lines in `~/.flow/instances/<name>/logs/*.log` (whole session should be
  tens of lines, not thousands), confirm zero new lines with the tag off, and
  record both in the tags.md **Verified:** line.
* **Retire a stale tag** — once its trace points are genuinely obsolete, remove
  the leftover `toplog.log` lines and the catalog entry in the same pass. This is
  the one place toplog deletes code; do it only when the trace no longer maps to
  anything real, and never as a side effect of `run` or `scan`.

After editing, run `scan` to confirm code and catalog reconcile.

# Mode: `learn` — consolidate what helped

Run this after a root cause is proven (or whenever coverage gaps surface), to turn
a debugging session into durable traceability. Make the smallest change that
captures the lesson:

* **Enrich an existing topic** — extend its `../topics.md` entry (more **Where**,
  sharper **Use for**) so next time the right topic is obvious. One heading per
  topic; integrate, don't append a second entry.
* **Add a new topic** — insert `toplog.log([...], …)` lines at the trace points
  that *would have* made the cause visible, AND add a `### <topic>` entry to
  `../topics.md`. Code and catalog land together so `scan` stays green.
* **Retire a stale topic** — once its trace points are genuinely obsolete, remove
  the leftover `toplog.log` lines and the catalog entry in the same pass. This is
  the one place toplog deletes code; do it only when the trace no longer maps to
  anything real, and never as a side effect of `run` or `scan`.

After editing, run `scan` to confirm code and catalog reconcile.

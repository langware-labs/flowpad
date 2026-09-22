---
id: 6a718120-83db-4e5c-a14e-d0d42634ce00
---
# Mode: `learn` — consolidate what helped

Two forms, one catalog:

| Arg | When | What it does |
| --- | --- | --- |
| `learn` | a root cause is proven, or a coverage gap surfaced | consolidate the lesson into the catalog + code |
| `learn tandem` | an RCA is STUCK and the path is dark | RCA and toplog feed each other, pass after pass, until BOTH are done |

## `learn` — consolidate the lesson

Make the smallest change that captures it:

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

## `learn tandem` — RCA and toplog advancing together

Consolidating afterwards is the easy case. The one that needs this mode is the
RCA that is stuck: the decisive path has no `toplog.log` on it, so every chain is
inference, or the symptom refuses to reproduce on demand.

Neither side can finish alone, and neither leads. **They feed each other**, and a
pass is only complete when the hand-off has gone both ways:

| | hands over | which the other turns into |
| --- | --- | --- |
| **toplog → RCA** | the lines a tag emitted, and the lines it did NOT | a path admitted into the chain, or one struck off it |
| **RCA → toplog** | the seam its chain now rests on but cannot see | the next tag or log point to place, aimed there |

So each pass ends with both sides further along: one more line the trace can see,
one less hypothesis the RCA carries. If a pass feeds only one direction — a trace
nobody reasoned over, or a theory nobody instrumented — it does not count as a
pass; close the loop before starting another.

**Run it to completion. Do NOT stop between passes to ask.** Tandem is one task,
not a series of check-ins: a pass that ends with "want me to continue?" has spent
the user's turn on a status report instead of the next seam. Keep looping — cover,
prove, consolidate or cover again — and come back only on a terminal outcome:

* **DONE** — the switch toggles both directions AND the catalog now covers the
  path that proved it. Report the cause, the toggle, and the tag you wrote.
* **BLOCKED** — reproducing needs something only the user can grant or decide
  (their credentials, their machine, a restart of an instance you don't own, a
  destructive step). Name the one thing you need.
* **EXHAUSTED** — a full pass retired no unknown: no new line, no hypothesis
  killed. Say what you covered, what stayed silent, and what that rules out.

Announce progress as you go if the loop is long, but keep working; the user reads
a running trail, not a question.

**A. Cover the blind path** *(RCA → toplog)*. Take the seam the RCA just named
and put a tag on it — enrich an existing tag, or add a new one (rules above).
Provisional is fine here: the catalog entry can wait for step C, the log points
cannot. Activate with `run` and reproduce.

**B. Prove and validate** *(toplog → RCA)*. Hand the trail back to `/rca`. The
bar does not move: a path enters the causal chain only when a LINE says it ran,
and the cause is accepted only when its switch toggles **both** directions. A tag
that stayed silent is evidence too — it rules its path out. Whatever the RCA
cannot see from this trail is the input to the next A.

**C. Proven → consolidate (the `learn` form above). Not proven → back to A.**
When the switch toggles, write the finding into the tag now, while it is fresh:
which line pinned the switch, what the silence of the neighbouring tags ruled
out, and the **Verified:** line. When it does not, return to A one seam UPSTREAM
of the last line you saw — carrying what the trail eliminated, so the next pass
is narrower, not wider. The loop ends one way only: a proven switch AND a catalog
that now covers the path that proved it.

Two rules keep the loop honest:

* **Every pass must retire an unknown** — a new line, or a hypothesis killed. A
  pass that adds tags and learns nothing is tag sprawl; stop and say so instead
  of turning on more.
* **Leave no provisional points behind, as part of the terminal outcome.**
  Whichever outcome you reach — and if the loop is abandoned — leave the machine
  quiet: tags off (`switch.md`), every probe either promoted into a catalog entry
  or removed, and say plainly what remains (a stash, a failing test, an instance
  still traced). Code with trace points and no entry is exactly what `scan`
  exists to catch.

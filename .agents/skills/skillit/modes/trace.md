# Mode: trace

> Ground rules (inline by design): never delete knowledge; integrate, don't
> append; max 5 findings/corrections per pass; converged is a valid verdict.

Input: the target skill and a session that ran it (a session id; "this
session" is the current one). Output: the run laid on the skill's map — the
traveled path with a counter on every edge, time and cost per block, a
timeline to replay — shown to the person.

Trace measures, it does not judge: no findings here. Judging the run is
improve mode, which starts from this output.

1. The map must be fresh: run `modes/map.md` first when `map_check.py stale`
   says it is not (a run traced on a stale map lands on the wrong blocks).
2. Follow flowmap's `trace` command (`scripts/trace.py <session> <skill dir>`).
   The skill may have run more than once in the session: `--from N` picks the
   run; the default is the last.
3. Report the totals and the moves the map does not have. Many such moves mean
   the map's `match` hints are too weak — strengthen them (map mode) and trace
   again before anyone reads the run.

# Mode: map

> Ground rules (inline by design): never delete knowledge; integrate, don't
> append; max 5 findings/corrections per pass; converged is a valid verdict.

Input: the target skill. Output: its flowmap, built or refreshed, and shown.

The map format, its checks and its viewer belong to the **flowmap** skill — load
it and follow its `map` command; this mode only decides when to run it.

1. `map_check.py stale <skill dir>` (flowmap's script). Exit 0 = the map is the
   skill as it is now: show it and stop. Exit 3 = the skill changed since the
   map: rebuild only the parts whose files changed. Exit 4 = no map: build it.
2. Build from the skill as written, following its routing exactly as review
   mode's step 1 does (every file an index row points at). A file nothing
   points at is not on the map — report it (`structure.md #6`).
3. `map_check.py check`, then `stamp`, then show it (flowmap `show`).

The map lives in the skill's own folder (`flowmap/map.value.json`) and is
committed with it: a change to the skill and its map land together.

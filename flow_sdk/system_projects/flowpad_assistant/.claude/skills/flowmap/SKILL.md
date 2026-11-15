---
id: 0daa3230-97b8-44a8-b0a9-d460304c9b70
name: flowmap
description: Maps the flow of a skill or agent so anyone can read it — how you start
  it, its blocks (instructions the assistant follows, code that runs, screens a person
  sees), what each takes and gives, and where each leads to the outcome — as one picture
  in Flowpad. Also lays a real run of the skill on that map — the path it took with
  a counter on every edge, the time and cost of every block, and a timeline that replays
  it. Use for "map this skill / agent", "show me how <skill> flows", "draw the flow
  of these instructions", "trace this run on the map", "what did the run actually
  do, how long, how much". NOT for judging or fixing a skill (skillit), a product's
  user journey (mockify), or a general diagram (chartit).
---

# flowmap — a skill's flow, and a run on it

Three commands. The format is two kinds (shipped, always registered): `flowmap.map` and `flowmap.run`
(fields: `agentic-assets/data_schema/flowmap.*` of the Flowpad assistant). Both open in the flowmap viewer —
`flow show file <path>` on a `*.value.json` draws it.

| command | input | output |
|---|---|---|
| `map <skill dir>` | a skill or agent folder | `<skill dir>/flowmap/map.value.json`, checked and shown |
| `trace <session> <skill dir>` | a session that ran it | `~/.flow/flowmap/runs/<skill>/<session>.value.json`, shown |
| `show <skill dir> [<run file>]` | | the map, or the run on it |

Scripts run with Flowpad's Python: `"$FLOWPAD_PYTHON" <this skill>/scripts/<script>` (`map_check.py` needs no
Flowpad; `trace.py` reads transcripts through `flow_sdk`).

## map

1. **Fresh already?** `map_check.py stale <skill dir>` — exit 0: show it and stop. 3: rebuild. 4: build.
2. **Read the skill the way it runs.** Start at its entry file and follow every pointer it routes to (a mode file,
   a reference, a script, an agent template). Nothing you did not reach is on the map.
3. **Entries** — every way to start it: each command / mode, and each start from inside its own output (a button
   in a page it made, a message it waits for). `say` is what the person types or presses, in their words, short
   enough to recognise in a prompt (`"Mock feedback on"`). `gives` is what they end with.
4. **Steps** — one per piece of work a person would name: `title` in plain words, `type` (`instructions`: the
   assistant reads and follows it; `code`: a script runs, same result every time; `screen`: something a person
   sees, reads or clicks — a page, a report in the chat), `takes` and `gives` in plain words, `by` when helpers
   do it (`one helper per file, all at once`), `source` (file · section, or the script call).
   `match`: what a run does when it is in this step — a script name (`validate_mock.py`), a path it writes, a
   tool name in quotes (`"Grep"`). Code steps need one; reading a script never counts as running it.
5. **Links** from entries through steps to **outcomes**. A choice gets a `label` (`fails`, `a review`); a way
   back for another round is `loop: true` (drawn dashed, beside). An entry that starts from inside the flow
   sets `lane` / `row` to sit where it happens; nothing else needs a position — the viewer lays it out.
6. `map_check.py check <skill dir>` until it prints OK, then `map_check.py stamp <skill dir>`, then show it.

Plain words throughout: the map is read by people who never opened the skill. No file names in titles, no
jargon in `takes` / `gives`; the source and the hints are where the technical detail goes.

## trace

1. The map must be fresh (`stale` exit 0) — a run on a stale map lands on the wrong blocks.
2. `trace.py <session> <skill dir> [--from N]` — the N-th start of the skill in the session (default: the last).
   No model call: every frame's time and cost come from the transcript, a helper's whole cost counts in the
   frame that spawned it.
3. Read its `moves_off_the_map`: a few is normal (a step the run took that the map does not lead to); many
   mean weak `match` hints — strengthen them and trace again before showing.
4. Show the run file. Report: total time and cost, the steps that took most, the moves off the map.

## show

`flow show file <skill dir>/flowmap/map.value.json`, or `flow show file <run file>` for a run.

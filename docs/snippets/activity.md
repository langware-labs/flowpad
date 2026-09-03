---
id: f273dd50-64e3-4e2c-99e8-9e5482779402
---

# Activity — progress on anything, from anywhere

`Activity.get(path)` finds or creates a progress row; `.child(name)` does the same one
level down; every node has the same verbs. Any producer reports through it — an index, a
walk, a RAG pass, a QA cycle, an agentic process — and every consumer reads one shape,
`ActivityProgressSpec`.

Three things are worth knowing before the code:

* **The address is the path.** `Activity.get("index").child("pdf")` and
  `Activity.get("index/pdf")` are the same node. A name nobody has used yet is created on
  first touch, so code three modules deep in a walk needs no handle passed down to it.
* **Ticks are cheap, transitions are not.** Every `inc_*` is an in-memory snapshot pushed
  over the socket, coalesced to four a second. Only `block`, `done` and the other lifecycle
  verbs publish on the event bus. Report as often as you like; you cannot make the writer
  contend.
* **A finished root is dropped.** The monitor tracks LIVE work. When a root ends, its tree
  is untracked and a later `get` on that address gives a fresh row, not the old one.

Every snippet below is run verbatim by `tests/unit/test_activity_snippets.py`; the
behaviour they lean on is pinned by `tests/unit/test_activity_handle.py`,
`tests/unit/test_activity_monitor.py` and `tests/unit/test_activity_emit.py`.

## 1. Count

```python
from flow_sdk.activity import Activity

act = Activity.get("index").label("Indexing").total(5000)
act.inc_success()                         # done += 1
act.inc_skipped()                         # done += 1, skipped += 1  (fresh, not re-parsed)
act.inc_error("encrypted", ref="a.pdf")   # errors += 1, done unchanged
act.inc("orphans", 17)                    # a delta — orphans FOUND
act.set_counter("tokens", 4_200)          # an absolute total, never moving backwards
act.current("~/notes/q3-plan.md")         # what is in hand
```

Two counter verbs, because producers come in two shapes. `inc` adds a delta, for a
producer that sees events. `set_counter` takes an absolute value, for one whose source is
a running total — an agent's token count, a re-parsed transcript — and it never moves a
counter backwards, so a re-read that lost information cannot undo work. Without it every
such producer computes the difference itself and invents its own answer.

There is no `start()`: the first mutation moves the node from `pending` to `running` and
stamps `started_at`. `total(None)` means unknown, and unknown is not zero — a scan whose
discovery *is* the count leaves it unset and the UI shows a bare number rather than a bar
pinned at 0%.

Note which verb moves which number. A skip counts into `done`, because a walk that skipped
900 fresh files out of 1000 has not got 10% through the folder. An error does not, because
a file that failed was not processed.

## 2. Children, from wherever the code is

```python
Activity.get("index").child("pdf").total(3000)

# ...three modules later, no handle in scope:
Activity.get("index/pdf").inc_success()
Activity.get("index/pdf").child("ocr").inc_error("0 pages", ref="b.pdf")
```

A parent with no total of its own reports the rollup of its children, so a job that only
orchestrates still shows a bar. A child at work also starts and refreshes its ancestors —
without that, a root that delegates everything would carry no timestamp and be reported
stale while its children ticked furiously.

Nesting stops at four tiers. Past that a producer is modelling items, and items belong in
counters, not on the wire.

## 3. End it

```python
act = Activity.get("index")
act.done("indexed 5,000 · 17 orphans")     # completed, sticky, root → untracked
act.block("waiting for hub login")          # running ⇄ blocked, NOT terminal
act.resume()
```

Terminal states are sticky: an `inc_success()` after `done()` is dropped, not applied and
not raised — a late tick from a background thread is not worth failing a job over.
`done()` on a child ends that child and leaves the tree tracked. `done()` on the ROOT ends
the tree: any child still running is recorded `interrupted`, because it was cut off rather
than finished, and recording it as completed would be a lie the receipt carries forever.

## 4. Read it back

```python
from flow_sdk.activity import monitor

spec = monitor.get("index")            # ActivityProgressSpec, frozen — or None once gone
spec.state, spec.done, spec.total, spec.errors_count, spec.skipped
spec.children[0].current
spec.fraction()                        # own total, else rolled up, else None
```

A verb returning does not mean the row says what you think. Read it.

`fraction()` is `None` when nothing can be known, never a fabricated `0.0`. The caller
renders a count in that case.

## 5. What is running right now

```python
monitor.list()               # live roots, most recently updated first
monitor.count()              # how many — the number on the footer chip
monitor.stale(seconds=60)    # roots that have not ticked inside the window
```

The monitor IS the find-or-create registry, so two callers who ask for the same address get
the same node. It holds roots; children are reached through their root, which is what makes
eviction a single delete.

It is also the duplicate-start gate — there is no separate slot to take:

```python
act = Activity.get("index")
if act.state == "running":
    raise RuntimeError(f"index already running since {act.spec().started_at}")
```

And it is the only thing that knows when each activity last moved, so it is the only thing
that can tell a slow job from a hung one. `stale()` REPORTS; it never kills and never turns
silence into a failure.

## 6. Eviction, and what a fresh row means

```python
Activity.get("index").child("pdf").inc_success()
Activity.get("index").done("indexed 5,000")

monitor.get("index")            # None — the root is terminal, the tree is untracked
Activity.get("index").state     # "pending" — a FRESH row, not the finished one
```

"Is it running" is a question for the monitor. "When did it last finish" is a question for
the receipt. The tracker this replaces conflated the two, which is why a backend restart
used to make the footer indicator vanish with nothing said.

Phase 1 is memory only: the monitor dies with the process, and a restart takes every live
tree with it.

## 7. Scope

```python
Activity.get("index")                                    # the instance — this box
Activity.get("run", scope="agentic_process-abc")         # a row on another entity
monitor.list(scope="agentic_process-abc")
```

Scope is part of the address, so two entities can each have an `index` row. It is also the
routing key: an unscoped activity goes to every connection, a scoped one only to that
entity's watchers.

## 8. Same verbs in TypeScript

```ts
import { Activity, listActivities } from '@sdk/activity';

Activity.get('index').label('Indexing').total(5000);
Activity.get('index/pdf').incSuccess();
Activity.get('index/pdf').incError('encrypted', { ref: 'a.pdf' });
await Activity.get('index').done('indexed 5,000');

await listActivities();                       // live roots
```

Verbs are camelCase here and snake_case in Python; the route takes either, so it is one
vocabulary spelled the way each language spells things. Every call goes through
`apiClient` with a path — application code never touches a backend URL.

Reading in a component goes through the store, not the client:

```ts
import { useActivity } from '@src/hooks/useActivity';

const { spec, live, elapsedMs, fraction } = useActivity('index');
```

`elapsedMs` ticks on its own clock rather than on snapshots. An activity that goes quiet
stops producing snapshots, and that is exactly when someone is staring at the row.

## 9. Same verbs from the CLI, which is how an agent does it

```bash
flow progress report index label "Indexing"
flow progress report index total 5000
flow progress report index/pdf inc-success
flow progress report index/pdf inc-error "encrypted" --ref a.pdf
flow progress report index inc --counter orphans --n 17
flow progress report index set-counter --counter tokens 4200
flow progress report index done "indexed 5,000 · 17 orphans"

flow progress list                     # what is running on this box
flow progress show index               # one tree, as the UI sees it
```

Address, then verb, then argument. Inside an AgenticProcess the scope defaults to that
process, so an agent's progress lands on its own row without it knowing its own id.

For a tight loop, `--stdin` takes one `verb arg` per line — one process for a whole walk
rather than ten thousand:

```bash
find . -name '*.md' | while read f; do
  echo "current $f"; echo inc-success
done | flow progress report walk --stdin
```

## 10. Over HTTP

```bash
curl -X POST $API/api/v1/activity/index/pdf/inc_error -d '{"message":"encrypted","ref":"a.pdf"}'
curl -X POST $API/api/v1/activity/index/done          -d '{"message":"indexed 5,000"}'
curl      $API/api/v1/activity/index                   # one tree, children included
curl      $API/api/v1/activity                         # every live root
```

The route is the same sentence as the CLI. Live ticks arrive on the `progress_report`
flow_data envelope with `attributes.kind == "activity"`; a refusal comes back as HTTP 200
carrying an `error_code`, the same convention the rest of the API uses.

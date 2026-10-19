---
id: d6e8f077-4190-4650-8378-a5d491cc4b97
---
# Datasets — snippets

A dataset is a folder of rows: `input` + `context` → the right `ground_truth`, and what a run
produced as `output`. When its `spec` NAMES a kind, every slot is a typed value — and the schemas
those kinds name can be defined as `data_schema` folders — nested in the dataset itself, or
shipped. The example is the SmartNavigator eval set: its schemas ship
(`flowpad_assistant/agentic-assets/data_schema/navigat*`),
its rows do not — they live beside the checkout at `dev/dataset/smart-navigator/`
(`flow_sdk.core.navigation.DATASET`, overridable with `FLOW_NAVIGATOR_DATASET`), and the fences that read
them skip where it is absent.

Pinned by `tests/unit/test_datasets_snippets.py` (runs every Python fence). The mechanics are
pinned by `tests/unit/test_data_spec/test_declared_kinds.py`,
`tests/unit/test_data_spec/test_typed_dataset_rows.py` and `tests/api/test_dataset_editors.py`.

## 1. Define the row schemas as folders

```
flowpad_assistant/agentic-assets/data_schema/  # shipped, flat: the folder name is the kind
  navigation.map/ .place/ .subplace/           # the map (screens)
  navigation.here/ .ref/ .shown/ .outcome/     # you are here
  navigator.dataset/                           # {"rows": {"input": "navigator.request", ...}}
  navigator.request/ .context/ .candidate/ .decision/

dev/dataset/smart-navigator/                   # the rows -- not shipped
  dataset.json                          # metadata.spec: "navigator.dataset"
  map.json                              # reference: the navigation map, for browsing
  rows/0001/
    input/request.json  context/candidates/  ground_truth/decision.json  row.json
```

```json
{"type": "data_schema", "fields": {
  "route":  {"shape": "enum:quick|agentic", "description": "quick: open now; agentic: ask"},
  "target": {"shape": "?navigator.target",  "description": "what to open; absent when agentic"},
  "verb":   {"shape": "?enum:show|navigate"}}}
```

The folder name is the kind. Indexing registers the schema under it, in the project's namespace (ours when
shipped); `?` may be absent, `enum:` is a closed set, a field naming another kind nests it.

## 2. Read a dataset

```python
from flow_sdk.builtin.dataset import Dataset
from flow_sdk.core.navigation import DATASET

nav = Dataset.at(DATASET)                 # the entity from disk alone -- no index needed
summary = (nav.spec, nav.num_rows, nav.kind_counts)   # ('navigator.dataset', 253, {'eval': 251, 'test': 2})
rows = nav.read_rows()
first = rows[0].input.utterance           # 'open data sources'
where = rows[0].input.here.view           # 'home' -- the navigation.here it was typed on
problems = nav.validate_rows()            # [] -- every row fits navigator.dataset
```

## 3. Write rows and labels

```python
from flow_sdk.builtin.dataset import Dataset

mine = Dataset.at(folder)                 # a dataset.json whose spec is "navigator.dataset"
ids = await mine.append([
    {"kind": "eval", "input": {"utterance": "open data sources"}, "context": {"candidates": []},
     "ground_truth": {"route": "quick", "target": {"kind": "view", "value": "data-sources"}}},
])
await mine.annotate(ids[0], [
    {"route": "quick", "target": {"kind": "view", "value": "data-sources"}},
    {"route": "quick", "target": {"kind": "view", "value": "connectors"}},
])
gold = mine.row(ids[0])["ground_truth"]   # both answers -- any one is right
```

`append` checks every row before writing anything; `annotate` replaces the gold. Over HTTP the
same verbs are `POST dataset/<id>/append`, `GET dataset/<id>/row/<id>`,
`POST annotate`, `POST validate`, `POST score`.

## 4. Evaluate the navigator on it

A dataset is evaluated by an **eval** -- `eval.json` (`EvalSpec`) + `eval.py` -- nested in it, or
shipped for its kind. The navigator's ships at `flowpad_assistant/agentic-assets/eval/navigator/`:
it runs each row through the public `flow_sdk.navigation.decide` on the row's OWN recorded
`here` and candidates, and answers a standard `RowEval` per row. The runner writes
`evals/<run>/run.json`, `rows.jsonl` and a navigable `report.html`.

```python
from flow_sdk import evals

run, folder = await evals.run(nav, out_dir=runs)   # `runs`: where to write (default: <dataset>/evals)
benchmark = run.slices["data.suite"]["benchmark"]   # the 52 original cases; "ux-surface" = the 200 UX sentences
scores = tuple(benchmark[k] for k in ("precision", "coverage", "agentic_recall", "confident_wrong"))
report = folder / "report.html"
```

The same from a shell: `python -m flow_sdk.evals <dataset folder> [--eval NAME] [--kinds eval]`.

Live, with Jev as the hub's decision API: precision 1.0, coverage 0.92, agentic recall 1.0,
confident-wrong 0. Without a decision API every row is `agentic` (the navigator is off).

## 5. Open it in an editor

A dataset opens in the app that edits it — its own nested editor, else one whose `webapp.json`
`edits` names its kind, else the generic dataset editor (`GET /api/v1/editors/dataset-<id>`). The
editor builds its forms from the kinds (`GET /api/v1/kinds/navigator.decision`).

## 6. Log real decisions into a training set (SmartNavigationLog)

With **Preferences → Advanced → Smart navigation log** on (off by default), every decision the
magic line makes is appended to the user's own **SmartNavigationLog** dataset
(`<FLOWPAD_TEMP_DIR>/<instance>/agentic-assets/dataset/smart-navigation-log/` — Flowpad's temp
folder, which the OS clears now and then, so copy rows worth keeping into a kept dataset; spec `navigator.dataset` —
the same row kind as the SmartNavigator eval set). A row is `train`, carries what was typed and where,
what was offered and decided, and what was done (`data.address` or `data.prompt`) — and no gold
until someone reviews it.

```python
from flow_sdk import evals
from flow_sdk.core import navigation_log
from flow_sdk.navigation import call
from flow_sdk.preferences import PREF_SMART_NAVIGATION_LOG, write_instance_pref

write_instance_pref(PREF_SMART_NAVIGATION_LOG, True)
request = {"utterance": "summarize the README", "here": {"view": "home"}}
answer = await call(request)       # the smart-navigator block -- what the navigation-decision action runs
await navigation_log.drain()       # its FlowCall log writes the row after answering

log = await navigation_log.dataset()               # SmartNavigationLog
row = log.read_rows()[-1]
logged = (row.input.utterance, row.output.route, row.data["prompt"])  # (..., 'agentic', ...)
await log.annotate(row.id, {"route": "agentic"})   # reviewed: asking was right
run, _ = await evals.run(log, kinds=["train"], out_dir=runs)   # only labelled rows are judged
write_instance_pref(PREF_SMART_NAVIGATION_LOG, False)
```

In the dataset editor the same review is one click: **Correct** labels a row with what the run
did, and the **needs label** filter lists what is left.

## 7. Keep records by key

A row's **key** is its row folder's name. Give one on `append`, then address the row by it —
never compute an id: a row's id is stored in the row (a rename keeps it), and every read hands back
both `key` and `id`.

```python
from flow_sdk.builtin.dataset import Dataset

mine = Dataset.at(folder)
await mine.append([{"key": "open-sources", "input": {"utterance": "open data sources"}}])
await mine.put("open-sources", {"input": {"utterance": "open my data sources"}})  # replace; gold kept
problems = mine.check({"input": {"utterance": 7}})        # what is wrong -- nothing is written
same_id = mine.rename_row("open-sources", "sources")      # a new key; the id (and every link) stays
keys = [row.key for row in mine.read_rows()]              # ['sources']
mine.delete_row("sources")
```

`put` creates or replaces one row and checks it first; slots it leaves out (gold, output, context)
and the row's metadata are kept. Over HTTP: `POST dataset/<id>/put-row {key, row}`,
`POST delete-row {key}`, `POST rename-row {key, new_key}`, `POST check-row {row}`; one value
against a kind, outside any dataset: `POST /api/v1/kinds/<kind>/check {value}` (an unknown kind is a
404, never "fits"). TypeScript: `dataset.put / deleteRow / rename / check` and `checkKind(kind, value)`.

## 8. Links between rows

A field typed by a kind holds a value of it — or a **reference** to one row, `<kind>.id.<uuid>`.
Every row hands out its own (`row.ref`); its id is stored in the row, so a rename keeps it.

```python
from flow_sdk.builtin.dataset import Dataset, LinkError

companies, leads = Dataset.at(project / "agentic-assets/dataset/companies"), Dataset.at(project / "agentic-assets/dataset/leads")
(acme,) = await companies.append([{"key": "acme", "input": {"name": "Acme"}}])
await leads.append([{"key": "dana", "input": {"name": "Dana", "company": companies.ref_of(acme)}}])
companies.rename_row("acme", "acme_inc")                  # the reference still resolves
try:
    companies.delete_row("acme_inc")                      # Dana still works there
except LinkError as refused:
    reason = str(refused)                                 # "used by --demo--.crm.lead dana"
problems = leads.check({"input": {"name": "Eli", "company": companies.ref_of("0b7c8a2e-1f0d-4e5a-9c3b-2d4e6f8a1b3c")}})
```

`check`, `append` and `put` refuse a reference to a row no dataset beside it holds; `delete_row`
refuses while one points at the row. Rows carry `ref` and `version` over HTTP too — pass the version
back as `put-row {key, row, expected}` and a row changed since answers 409. The datasets holding a
kind: `GET /api/v1/kinds/<kind>/datasets?project=<id>` (TypeScript `Dataset.forKind(kind, projectId)`).

## 9. Mirror an outside system, and read only what you show

A system of record reached through a data source is mirrored by DECLARING it on the source
(`"mirror": {dataset, map, by?}` in its `data_source.json`): every sync keeps the dataset so, and a
row's outside-owned fields write back through the source. The map turns ids into links
(`{"link": <kind>, "by": <unique field>, "path": "data.deal_ids.*"}`). See
[mirroring a system of record](../data-management/mirroring-a-system-of-record.md). What follows is
the same mirror done by hand, from rows your own code builds.

An app that keeps real records — a mirror of a CRM, a log of outreach — writes many rows per run and
shows a few of them. `sync` makes the dataset hold exactly the rows given, in one step; `query` and
`count` answer the rows that match, so a number on a dashboard and the list behind it are one question.

```python
from flow_sdk.builtin.dataset import Dataset

companies = Dataset.at(project / "agentic-assets/dataset/companies")
await companies.put_many([{"key": k, "input": {"name": n}} for k, n in [("acme", "Acme"), ("bolt", "Bolt"), ("core", "Core")]])
done = await companies.sync([                              # what the outside system holds NOW
    {"key": "acme", "input": {"name": "Acme"}},            # reads the same: left untouched
    {"key": "bolt", "input": {"name": "Bolt Ltd"}},        # changed: replaced
    {"key": "dyne", "input": {"name": "Dyne"}},            # new: created -- and `core`, not listed, is removed
])
found = companies.query({"op": "$LIKE", "operands": ["input.name", "ltd"]}, order_by={"key": "asc"}, limit=10)
names = [row["input"]["name"] for row in found["rows"]]   # ['Bolt Ltd'] -- found["total"] counts before paging
tally = companies.count(group_by=["kind"])                 # {"total": 3, "groups": [{"by": {"kind": "train"}, "count": 3}]}
gone = companies.delete_rows(["acme", "dyne"])             # all of them, or none
```

`put_many`, `delete_rows` and `sync` are each ONE step — every row is checked first, and one that
does not fit, changed since (`expected={key: version}`) or is still linked to writes nothing; the
refusal names every such row by key. `sync(rows, match=…)` prunes only the rows `match` selects, so
a writer that owns one slice of a dataset never removes another's. A match is the entity query
expression (`{op, operands}`: `$EQ $NE $GT $GE $LT $LE $IN $NIN $LIKE $IS_NULL $IS_NOT_NULL`, under
`$AND` / `$OR`) or a plain `{path: value}` map; a field is a path into the row as it travels —
`key`, `input.stage`, `input.stage_dates.won` — and a date compares as its ISO string.

Over HTTP: `GET dataset/<id>/rows?filter={match, order_by, limit, offset}` → `{rows, total, problems, version}`,
`GET rows-version` → `{version}`, `GET count?filter=…&group_by=a,b` → `{total, groups}`, `POST put-rows {rows, expected?}`,
`POST delete-rows {keys, expected?}`, `POST sync-rows {rows, prune?, match?}`. TypeScript:
`dataset.query(query)`, `count`, `putMany`, `deleteRows`, `sync` — and `dataset.onRowsChanged(handler)`:
every row write says `dataset.rows.changed` once (the keys that moved, never their values), so a page
re-reads when told instead of on a timer — or on focus: a write made while the socket was down is told
on reconnect as one `{op: "sync", keys: []}` (`docs/flow-events.md`). A script outside the server is
heard too (the write tells the running instance). An app opens an outside page — the record in the CRM — with
`openExternal(url)` (http/https only; the host opens it in the person's browser).

## 10. Ask across links, count by week, find by text

A path follows a link, `count` buckets dates and measures more than rows, and `q` reads a row's
text — so a dashboard number, its trend and the list behind it are the same question asked three ways.

```python
from flow_sdk.datasets import Dataset

companies, leads = Dataset.at(project / "agentic-assets/dataset/companies"), Dataset.at(project / "agentic-assets/dataset/leads")
acme, bolt = await companies.put_many([{"key": "acme", "input": {"name": "Acme"}}, {"key": "bolt", "input": {"name": "Bolt"}}])
await leads.put_many([
    {"key": "dana", "input": {"name": "Dana Levi", "company": companies.ref_of(acme)}},
    {"key": "eli", "input": {"name": "Eli Stone", "company": companies.ref_of(acme)}},
    {"key": "fay", "input": {"name": "Fay Levi", "company": companies.ref_of(bolt)}},
])
at_acme = [r["key"] for r in leads.query({"input.company.name": "Acme"}, order_by={"key": "asc"})["rows"]]   # follows the link
per_company = leads.count(group_by=["input.company.key"], metrics={"people": "distinct:input.name"}, order_by={"count": "desc"})
found = leads.query(q="levi", expand=["input.company"])                    # text anywhere in the row; linked rows beside
names = sorted(v["row"]["input"]["name"] for v in found["linked"].values())
unused = [key for key, by in leads.used_by().items() if not by]           # rows nothing links to
levis = {"op": "$PROP", "operands": ["input.company", {"op": "$LIKE", "operands": ["input.name", "levi"]}]}
colleagues = leads.query({"op": "$IN", "operands": ["input.company", levis]}, order_by={"key": "asc"})   # a join: one question
```

A date bucket is written `week:input.day` (also `day:` / `month:` / `quarter:`; `week_start="sunday"`
when your week begins there), a metric `distinct:` / `min:` / `max:` / `sum:` and a path. Over HTTP:
`GET rows?filter={match, expand}&q=…`, `GET count?group_by=week:input.day&metrics={…}&order_by={…}`,
`GET used-by`. A join on a value is a sub-query — `$IN [field, {$PROP: [path, match, kind?]}]`: "among the
values `path` takes in the rows that match". TypeScript: `rows({match, q, expand})` → `linked`, `count({group_by, metrics, order_by,
week_start})`, `usedBy(keys)`, and `bucketOf(day, 'week', 'sunday')` for the key of a period.

## 11. Change a field the outside system owns

In a dataset a data source mirrors (§9, the declared `mirror`), every field the map names is the
outside system's: the schema marks it `"owned_by": "crm"`. You still edit it like any field — the
change is sent to that system first, through the source's driver, and the row is then written as
the system answered. The app's own fields (`notes`) are written as given. There is no merge to write
and no client of your own to keep.

```python
from flow_sdk.datasets import LinkError

row = tasks.query({"key": "t-1"})["rows"][0]                   # status is the CRM's; notes is ours
await tasks.put("t-1", {"input": {**row["input"], "status": "DONE", "notes": "called twice"}}, expected=row["version"])
now = tasks.query({"key": "t-1"})["rows"][0]["input"]         # status 'DONE' as the CRM answered, notes kept
try:
    await tasks.put("t-1", {"input": {**now, "seen": "today"}})   # mirrored from a path nothing can write
except LinkError as refused:
    code = refused.details[0]["code"]                        # 'not_writable' -- nothing was sent
```

The refusals, by `details[].code`: `not_writable` (the map reads the field from a path it cannot
write), `source_refused` (the system said no — its words follow), `unlinked` (a list of links holds
ids no row here resolves yet), `owned` (the source is read-only, or this process holds no driver). A
record the system made but could not finish is written, with `warnings: [{error_code:
"source_partial", message, key}]` in the answer — show them.

Only the server holds a driver. Over HTTP — what an app and a script use — it is the same write:
`POST dataset/<id>/put-row {key, row, expected?}`, `put-rows`, `append`, and `delete-row` /
`delete-rows` to delete the record outside too. TypeScript: `dataset.put(key, {input}, {expected})`.
A script calls the action (`flow_sdk.local_client.graph_post(f"dataset/{ds.id}/put-row", {...})`);
`Dataset.put` in a script is refused `owned`. A mirror whose map names a field the schema does not
mark `owned_by` its `by` is refused as a whole (`mirror_failed`, `not_owned`): such a field would
take an edit and lose it at the next sweep.

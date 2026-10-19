# Mode: dataset — keep values as rows, by key

> **Ground rules (inline by design):**
> **1. Prove it in a probe first** (`references/probe.md`) — nothing lands in the
> user's project until the same files passed there; report the exit codes and read-backs.
> **2. An unknown kind is silently `Any`** — send one deliberately bad value; it MUST be refused.
> **3. Address rows by key; never compute an id.**
> **4. Never write a dataset's files by hand** — `dm_ctl` / the SDK, or tell the user the SDK cannot.
> **5. Schemas apply live** with `flow schema apply`; never ask for a restart.
> **6. Never widen a wait, a timeout or a retry to make something pass.**

`DM` is the shell function `DM() { "${FLOWPAD_PYTHON:-$(flow instance python)}" "<this skill>/scripts/dm_ctl.py" "$@"; }`. A dataset of a source's
items with gold labels is `connect-data-source define`, not this mode.


## FlowCall integration

ComputeOp input/output use this same ShapeForm grammar; registered kinds must resolve before execution. A list is one value, not an implicit dataset write or item loop. Named list entries may be ValueRefs; resolution is explicit. Follow the [FlowCall block recipe](../../../../docs/Getting%20Started/FlowCall.md) for call.py, typed results and chaining, while preserving dataset ownership, write and reference rules here.

## Gate 1 — the row kind exists

`DM kind "--<ns>--.<kind>"` answers the fields. If not, run `modes/schema.md` first.
Is there already a dataset of this kind? `DM ds-find "--<ns>--.<kind>"` — one dataset
per kind; reuse it rather than starting a second.

## Gate 2 — the dataset folder

`<project>/agentic-assets/dataset/<slug>/dataset.json` — the one file you write by
hand (example in `references/examples.md`): `data_layout: "io_folder"`, `spec` with
the kind in FULL (`--ns--.kind`), a title and a one-line description. Then:

```bash
flow record index "<dataset folder>" --types dataset     # total_indexed: 1
```

## Gate 3 — rows

Choose the keys: short, stable slugs of what the row is (`dana_levi`, `icp_ai_orgs`)
— `a-z 0-9 _ -`, starting with a letter or digit. The key is the row's readable name; links
to the row use its stored id, so a `ds-rename` breaks nothing inside Flowpad. A key copied
OUTSIDE (a CRM field, a URL, a doc) does not follow — store the row's `ref` there instead
of its key. A value that must live BOTH here and in an outside system is that system's field:
mirrored in, marked `owned_by`, and an edit here is sent there first (`references/mirroring.md`).
Never keep it in step yourself — no state file, no merge, no "agreed value".
A key that names no row in YOUR checkout may be a row another machine added that you have not
pulled — report it, never overwrite it.

| To… | Run | Notes |
| --- | --- | --- |
| add rows | `DM ds-append <ds> '[{"key": "dana", "input": {…}}, …]'` | all checked first; one bad row writes nothing; a taken key is refused |
| find the row a reference names | `DM ref '<kind>.id.<uuid>' --project <id>` | its dataset, key and value |
| create or replace one | `DM ds-put <ds> dana '{"input": {…}}'` | gold / output / context and metadata are kept unless given |
| check without writing | `DM ds-check <ds> '{"input": {…}}'` | `ok`, `errors` |
| read | `DM ds-rows <ds>` / `DM ds-row <ds> dana` | every row has `key` and `id` |
| read SOME rows | `DM ds-rows <ds> --match '{"op": "$GE", "operands": ["input.day", "2026-09-01"]}' --order '{"input.day": "desc"}' --limit 50` | a field is a path into the row (`key`, `input.stage`); `total` counts the matches before paging; `problems` is still every broken row |
| count | `DM ds-count <ds> --match '{"input.stage": "won"}' --group-by input.owner` | `{total, groups: [{by, count}]}` |
| count per week / people, not rows | `DM ds-count <ds> --group-by week:input.day --week-start sunday --metrics '{"people": "distinct:input.email"}' --order '{"week:input.day": "asc"}'` | buckets `day:` `week:` `month:` `quarter:`; metrics `distinct:` `min:` `max:` `sum:` |
| read across a link | `DM ds-rows <ds> --match '{"input.persona.icp.key": "fintech"}' --expand input.persona` | a path follows links; `linked` holds the rows `--expand` named |
| find by text | `DM ds-rows <ds> --q 'pricing objection'` | every word, anywhere in the row |
| who links to a row | `DM ds-used-by <ds> [key …]` | `[]` = nothing links to it (safe to delete) |
| create or replace MANY | `DM ds-put-many <ds> '[{"key": "dana", "input": {…}}, …]'` | one step: one row that does not fit writes nothing, named by key |
| mirror an outside system | `DM ds-sync <ds> '[{"key": …, "input": {…}}, …]' [--match '{…}'] [--no-prune]` | the dataset made to hold exactly these rows → `created / updated / unchanged / deleted`; `--match` prunes only the slice it selects |
| mirror a data source's items | `DM ds-mirror <ds> <source id> '{"key": "external_id", "input": {"name": "name", "stage": "data.stage"}}'` | each item one typed row; a sync underneath (`--by`, `--no-prune`) |
| delete MANY | `DM ds-delete <ds> dana eli fay` | one step, all or none; rows deleted together do not hold each other back |
| rename | `DM ds-rename <ds> dana dana_levi [--expected <version>]` | the id (stored in the row) stays, so links to it hold |
| delete | `DM ds-delete <ds> dana [--expected <version>]` | refused (409) while another row links to it — re-point or delete that one first; with `--expected`, also when it changed since. A row already gone is 404 (`LookupError`), not 409 — a script that removes rows treats it as done |
| repair a row that no longer fits | `DM ds-put <ds> <key> '{…}' --expected <version from ds-rows problems>` | a broken row is reported WITH its version |
| check everything | `DM ds-validate <ds>` | `problems: []` — each with every error of that row |
| link to another row | put the target row's `ref` (from `ds-rows`) in the field typed by its kind | a missing target is refused; deleting a referenced row answers 409 `used by …` |
| refuse a stale write | `DM ds-put <ds> dana '{…}' --expected <version from ds-rows>` | 409 when the row changed since |

`<ds>` is the dataset's folder path, id, or exact name. Bulk data (a CSV, a JSON
export): turn it into rows in a script and `ds-append` them in one call (`ds-sync` when the
script runs again and again) — never copy files into `rows/`, and never loop `ds-put` /
`ds-delete` over hundreds of rows: the bulk verbs take the lock and read the links once.

## Gate 4 — probe, then for real

Probe (`references/probe.md`): copy the schema folders and the dataset with
`probe-copy` (`--no-rows` if the existing rows hold real people and are not needed),
then run the exact verbs above with two or three real rows, plus one broken row that
must be refused. `ds-rows` shows what you meant. `probe-drop`. Then run the same verbs
on the user's dataset and finish with `ds-validate` → `problems: []`.

Show the dataset with the `flowpad-navigation` skill: `flow show entity <typeid>` — the
`typeid` that `flow record index` printed (`dataset-<id>`).

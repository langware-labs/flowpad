# Mirroring a system outside Flowpad — the rules

The system outside (a CRM, a tracker) is the truth for what it holds. Flowpad keeps a typed copy
you can link to, count and show. Everything here ships with the SDK; nothing is yours to build.


## FlowCall integration

ComputeOp input/output use this same ShapeForm grammar; registered kinds must resolve before execution. A list is one value, not an implicit dataset write or item loop. Named list entries may be ValueRefs; resolution is explicit. Follow the [FlowCall block recipe](../../../../docs/Getting%20Started/FlowCall.md) for call.py, typed results and chaining, while preserving dataset ownership, write and reference rules here.

## The parts, and whose each is

| Part | Where | Says |
| --- | --- | --- |
| the driver | `agentic-assets/data_driver/<name>/` (`connect-data-source author`) | how to read the system, and how to write it back (`Mutable`) |
| the source | `agentic-assets/data_source/<name>/data_source.json` | which account, how often, and the `mirror` |
| the schema | `agentic-assets/data_schema/<kind>/` | which fields are the system's: `"owned_by": "crm"`, each an OPEN shape (`?string`) |
| the dataset | `agentic-assets/dataset/<name>/` | the rows — one per record |

```json
"mirror": {"dataset": "tasks", "by": "crm",
           "map": {"key": "external_id",
                   "input": {"title": "data.title", "status": "data.status", "crm_id": "external_id",
                             "deals": {"link": "crm.deal", "by": "crm_id", "path": "data.deal_ids.*"}}}}
```

A link is `{"link": <kind>, "by": <a unique field of that kind>, "path": …}`: the system holds an id,
the row holds a reference. When the system holds the KEY of a row that is yours (a tag: your ICP's
key in a CRM text field), say `"by": "key"`. That key is then held OUTSIDE: renaming the row here
does not reach the system, and the next sweep leaves the link out (`unlinked`). Do not offer a rename
for such rows, or fix the key in the system with it; record the choice in `docs/data-decisions.md`.

After every sync of the source, the dataset IS the mirror. A row keeps its key and id for as long
as its record lives (found again by the mapped key field, which the schema makes `unique`).

## The four laws

1. **A mapped field is the system's.** Every field the map names MUST be `owned_by` the mirror's
   `by` in the schema, or the mirror is refused (`mirror_failed`, code `not_owned`): a field the
   app could also write would take an edit and lose it at the next sweep. A field the map does
   NOT name is the app's own and the mirror never touches it.
2. **An edit to the system's field goes to the system first.** Write the row as usual —
   `ds.put(key, {input}, {expected})`, `append`, `put-row` — and Flowpad sends what changed through
   the source's driver, then writes the row as the system answered. There is ONE way in. Never a
   client, a key, a state file, a merge or a "push later" list of your own.
3. **So a field your users edit that the system must also have is the system's field.** Add it to
   the system (a custom field), to the map, and mark it `owned_by`. It is edited here and lands
   there at once; an edit made there arrives at the next sync. No merge exists, so none can go wrong.
4. **Only the server holds a driver.** An app (TypeScript) and the row actions are served. A
   script is not: `Dataset.put` of an owned field in a script is refused `owned`. A script sends
   that edit with the row action — `local_client.graph_post(f"dataset/{ds.id}/put-row", {"key", "row", "expected"})`.

## What a write answers

| Code (`details[].code`) | Means | Do |
| --- | --- | --- |
| `owned` | not the owner, and no driver here (a script, a read-only source) | use the row action; or the field is not editable |
| `not_writable` | the map reads this field from a path it cannot write (`name`, a computed path) | show it read-only |
| `source_refused` | the system said no (its words follow) | show the message; nothing was written |
| `unlinked` | a list of links holds ids no row here resolves yet | mirror the linked kind first |
| `misfit` | the system made the record, and it does not fit the row kind | see `rows().problems`; fix the schema |
| warning `source_partial` | the record was made, one part was not set (`warnings: [{error_code, message, key}]`) | SHOW it — the row is saved, something is missing |

## What a sweep answers, and the source card

`{created, updated, unchanged, deleted, misfit?, unlinked?, referenced?}` — each a list.

| On the card (`error_code`) | Means |
| --- | --- |
| `mirror_failed` | the sweep was refused (no such dataset, `not_owned`, a link target that is not unique). Nothing was written |
| `mirror_misfit` | the sweep worked; some records did not fit (they are `problems` rows, input intact), or some rows gone outside are still linked from another row here (`referenced`: kept until the link goes) |

An app shows this: `DataSource.isMirrorBroken` (TypeScript), or `error_code` on the source row.
One bad record never stops the others; a record gone outside removes its row — an EMPTY listing
from a source that lists everything removes every row, so a driver raises when it got no answer.

## More than one machine

Rows of a mirrored dataset are usually out of git: each clone mirrors for itself, and that is
correct — the system is the shared truth. What is NOT shared: anything else you keep out of git
(a "told already" ledger, a date you stamped). Either the system holds it (law 3), or the rule
that writes it says where it runs (`"runs_on"` in `trigger.json`), or repeating it per clone is harmless.

## `three_way` is not for this

`flow_sdk.datasets.three_way(here, there, agreed)` decides one field between two stores that BOTH
accept edits offline and have no source between them (a file copied to a drive). A mirrored row
never needs it: law 2 leaves nothing to merge. If you are storing an "agreed" value for a row of
a mirrored dataset, stop — make the field the system's.

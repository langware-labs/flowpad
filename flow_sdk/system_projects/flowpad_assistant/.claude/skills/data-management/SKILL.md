---
id: c86c357c-dd02-45f5-99c0-0f868a76a8b4
name: data-management
description: >-
  Typed data in Flowpad, end to end — "define a schema for X", "store my leads /
  ICPs / products as records", "make a dataset", "add, edit, rename or delete rows",
  "check this value against its schema", "link one kind to another", "build an app
  or script over my data", "why does my dataset say Any / FolderSpec", "move my
  data_spec folders to data_schema". Writes data_schema folders and datasets, applies
  them with `flow schema apply`, works rows by key through the SDK, and PROVES every
  change in a throwaway probe project before it touches the user's project.
  Subcommands: `schema`, `dataset`, `app`, `migrate`. NOT for pulling an external
  system in (connect-data-source), an agent's own input/output (agent-builder), or
  Flowpad entities such as tasks, skills and agents (flowpad-assistance).
version: 1
---

# data-management

Typed data in Flowpad is three words, never mixed up:

- a **kind** is a NAME — a dot path (`crm.lead`); a project's own kinds carry its
  namespace: `--acme--.crm.lead`;
- a **schema** is the DEFINITION registered under a kind — a folder
  `agentic-assets/data_schema/<kind>/` (`data_schema.json` + `description.md`);
- a **value** is an INSTANCE of a schema. A **dataset** holds many values as rows,
  one folder per row; a row's **key** is its folder's name.

> **Ground rules (inline by design, repeated in every mode file):**
> **1. Prove it in a probe first.** Nothing lands in the user's project until the
> same files passed in a throwaway probe (`references/probe.md`). The report quotes
> the probe's exit codes and read-backs — never "it should work".
> **2. An unknown kind is silently `Any`.** Every probe sends one deliberately bad
> value and it MUST be refused. A value that "fits" an unknown kind proves nothing.
> **3. Address rows by key; never compute an id.** No uuid5 in your code, no
> `data.key` copies — every read returns `key` and `id`.
> **4. Never write a dataset's files by hand.** Rows go through `dm_ctl` / the SDK
> (`append`, `put`, `delete`, `rename`). If the SDK cannot do something, say so to
> the user — never route around it with file writes.
> **5. Schemas apply live:** `flow schema apply <folder>`. Never ask for a restart.
> **6. Never widen a wait, a timeout or a retry to make something pass.**

## Modes (from the skill arg)

The FIRST token, if it is exactly `schema`, `dataset`, `app` or `migrate`, selects
the mode. Anything else is a natural request: pick the mode it needs (a request
that needs a schema AND rows runs `schema`, then `dataset`).

| Skill arg | Load | What it does |
| --- | --- | --- |
| `schema` — "define / change / link kinds" | `modes/schema.md` | Write or change data_schema folders, apply, read the kind back |
| `dataset` — "store records", "add rows" | `modes/dataset.md` | Create a dataset, append / put / delete / rename rows by key, check, validate |
| `app` — "build an app or script over my data" | `modes/app.md` | The SDK calls an app or script makes, and the anti-patterns that broke a real one |
| `migrate` — "data_spec → data_schema" | `modes/migrate.md` | Move a project off the retired `data_spec` family, prove it, apply it |

## The probe gate (every mode)

`references/probe.md` is the recipe. In short:

1. `dm_ctl probe-new` → a project in `$TMPDIR/dm-probe-<id>/` with its own namespace.
2. `dm_ctl probe-copy <root> <schema or dataset folders>` → the SAME files, re-namespaced.
3. `flow schema apply <root>/agentic-assets/data_schema` → exit 0, every `status: ok`.
4. `dm_ctl kind <--ns--.kind>` → the fields you meant. `dm_ctl check` → a good value
   fits, a bad one is refused (rule 2).
5. For rows: `flow record index <dataset folder> --types dataset`, then the row verbs
   you will use for real, read back with `ds-rows`.
6. `dm_ctl probe-drop <project_id>` — ALWAYS, also when a step failed.
   `row_gone`, `folder_gone` true and `rows_swept_after` empty.

Then do it in the user's project and read it back the same way.

## Reference

| When you need to… | Load |
| --- | --- |
| the shape grammar — primitives, `?`, `enum:`, lists, maps, kinds by name | `references/shape-forms.md` |
| a complete schema folder, a grouping folder, a dataset, a row on disk | `references/examples.md` |
| the probe, step by step, and what each failure means | `references/probe.md` |
| run any mechanic — probes, kinds, values, dataset rows | `scripts/dm_ctl.py` |
| how the SDK models schemas (repo checkout only) | `docs/data-management/data-spec.md`, `docs/snippets/data-spec.md` |
| the dataset layout and row verbs (repo checkout only) | `docs/data-management/datasets.md`, `docs/snippets/datasets.md` |
| show the user a dataset, a schema or a snippet | the `flowpad-navigation` skill |

Run `dm_ctl` with the worker's interpreter, through a shell FUNCTION (a command kept in a
quoted variable does not split into words):

```bash
DM() { "$FLOWPAD_PYTHON" "<this skill>/scripts/dm_ctl.py" "$@"; }
DM probe-new
```

Never a bare `python3` for anything that imports `flow_sdk` (it may lack it), and never read Flowpad's database
(`flowpad.db`) yourself — everything you need is a `dm` verb or a `flow` command. Every call prints one JSON
object: `{"ok": true, ...}`, or `{"ok": false, "error", "data"}` with the server's
reasons (a 400 carries the validation `errors`).

## What the SDK does not do yet — say so, do not work around it

| Missing | Honest answer today |
| --- | --- |
| change events for dataset rows | re-read on focus or on a timer; say it is polling |
| one schema including another (shared `status`/`owner` fields) | repeat the fields; keep them identical |
| a map whose keys are a closed set | `{"*": shape}` and check the keys yourself |
| a rule across fields or rows (a tag chain, "this campaign's messages belong to its persona") | check it in every writer — the app AND any script — with the same rule, and report breaks |

Two writers at once (an app's server and a sync script) are safe: row writes in one project take
one lock, and `put` / `delete` with `expected` refuse a row changed since it was read — a row that
no longer fits included (it is reported with its version).

Links between rows ARE supported: a field typed by the target kind holds `<kind>.id.<uuid>`, the
SDK refuses a reference to a missing row and a delete that would leave one dangling
(`references/shape-forms.md`). Never model a link as a `{type, key}` kind, and never link a
dataset in git to rows kept out of git (their ids differ per machine).

# Mode: migrate — off the retired `data_spec` family

> **Ground rules (inline by design):**
> **1. Prove it in a probe first** (`references/probe.md`) — nothing lands in the
> user's project until the same files passed there; report the exit codes and read-backs.
> **2. An unknown kind is silently `Any`** — send one deliberately bad value; it MUST be refused.
> **3. Address rows by key; never compute an id.**
> **4. Never write a dataset's files by hand** — `dm_ctl` / the SDK, or tell the user the SDK cannot.
> **5. Schemas apply live** with `flow schema apply`; never ask for a restart.
> **6. Never widen a wait, a timeout or a retry to make something pass.**

`DM` is the shell function `DM() { "${FLOWPAD_PYTHON:-$(flow instance python)}" "<this skill>/scripts/dm_ctl.py" "$@"; }`.

Schemas were `agentic-assets/data_spec/<kind>/data_spec.json` until 2026-10-07. A
build after that reads only `data_schema`; a `data_spec` folder is reported by the
asset scan and registers NOTHING — every dataset over those kinds then refuses its
rows. There is no automatic migration; this mode is it.

## Gate 1 — find everything

```bash
find "<project>" -path "*/agentic-assets/data_spec" -not -path "*/node_modules/*"
grep -rln "data_spec" "<project>" --include="*.sh" --include="*.py" --include="*.js" --include="*.md" | grep -v node_modules
```

List for the user: the folders, and the scripts and docs that name `data_spec`
(e.g. `flow record index … --types data_spec`). Their files are theirs: say what will
change and get a yes before Gate 3.

## Gate 2 — migrate a COPY and probe it

Copy the project's `agentic-assets/data_spec` tree (and the datasets over it) to a
scratch folder, migrate the copy, and prove it:

1. Rename every `data_spec` FOLDER to `data_schema` (deepest first).
2. Rename every `data_spec.json` to `data_schema.json` and set `"type": "data_schema"`.
3. A folder that holds `agentic-assets/data_schema/` but has no doc of its own (a
   grouping folder) gets `{"type": "data_schema", "ns": "<ns>"}`.
4. `references/probe.md`: `probe-copy` the migrated schema tree and the datasets,
   `flow schema apply` → every kind `status: ok`, `DM ds-validate` each dataset →
   `problems: []`, `DM ds-rows` shows real rows with their keys, one broken value
   refused. `probe-drop`.

## Gate 3 — migrate the project

Same three steps on the real tree — `git mv` in a git project so history follows —
then update the scripts and docs from Gate 1 (`--types data_spec` →
`--types data_schema`, paths). Then:

```bash
flow schema apply "<project>/agentic-assets/data_schema"
```

and `DM ds-validate` every dataset over those kinds. Then `DM ds-store-ids <ds>` for each dataset:
rows written before ids were stored get theirs stamped, so their id (and every link to them) no
longer depends on the dataset's id in `.flow/` (not in git — a fresh clone mints a new one).

**Passes when** apply exited 0, every dataset validates, and nothing in the project
still says `data_spec` except history. Do not commit for the user; show `git status`.

## While you are there

If the project's app does any of the GTM Studio workarounds (`modes/app.md`), list
them for the user as follow-ups — row keys, `put`/`check`, ref enums. Do not rewrite
their app unasked.

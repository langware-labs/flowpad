# Action: records

CRUD on Flowpad records (entities backed by on-disk files: tasks, skills, agents, workflows, …). Use this whenever the user asks to **create**, **make**, or **add** a Flowpad record.

The pipeline is the same for every record type:

1. **Discover** the type with `flow schema info <type>`.
2. **Materialize** the record on disk at the location the schema's `creation.location` points to.
3. **Index** that path with `flow record index <path>` so the indexer parses + persists it.
4. (Optional) **Open** the new record: in standard assistant mode use
   [`navigate.md`](navigate.md); in Vibe mode use `flow show entity <typeid>`
   so the result appears in the active display pane.

Never call backend APIs directly, never edit the SQLite DB, never write outside the documented `creation.location` — the indexer is the single chokepoint.

Every `flow` command here acts on **your own instance** — the backend pins `FLOW_INSTANCE` for you, so `flow schema/record/navigate/context` already target the right backend. You normally never set it; only prefix `FLOW_INSTANCE=<name> flow …` if a user explicitly asks you to operate on a *different* instance.

## Creating a doc from a web page (URL → markdown)

When the body of a markdown doc comes from a web page, you are **converting**, not summarizing. The doc must reproduce the article's content faithfully — every heading, paragraph, list, quote, and link — at (near) the source's full length.

- **Fetch the RAW page, not a summary.** `curl -sL "<url>"` and convert the HTML to markdown yourself. **Do NOT use `WebFetch` for the body** — it returns a model-condensed rendering that silently halves the content and drops tables/structured blocks. A summary is a failed conversion.
- **Convert verbatim.** Keep the author's exact wording and voice (first/second person). Do not paraphrase, compress, re-order, or "tighten". Section headings → markdown headings, lists → lists, tables → markdown tables, inline links preserved.
- **Strip only chrome** — nav, header/footer, share buttons, cookie banners, "related posts". Keep all article body content.
- **Acceptance check, before you index:** count words in your doc body and in the source article; they must be within ~10%. If your draft is much shorter, you summarized — redo it from the raw HTML. If a block is client-side-rendered and genuinely absent from the raw HTML, note its absence; never use that as licence to compress the prose.

## Step 1 — discover the type

```bash
flow schema list
```

Returns every registered type. Filter visually for the one the user asked for. Then:

```bash
flow schema info <type>
```

Returns:

```json
{
  "ok": true,
  "type": {
    "type_name": "task",
    "uid_field": "id",
    "index_fields": ["description", "objective"],
    "defaults": {},
    "creatable": true,
    "browseable": true,
    "json_schema": { "...pydantic-derived..." },
    "creation": {
      "location": "<project_cwd>/tasks/<safe-title>/manifest.json",
      "manifest_fields": { "task_id": "...", "name": "...", "status": "..." },
      "example": { "task_id": "...", "name": "...", "status": "to_do" },
      "after_index": "Resulting TypeId is `task-<task_id>` — pass it to `flow navigate entity`."
    }
  }
}
```

If `creatable` is `false` or the `creation` block has no real recipe, stop and tell the user this type isn't supported for agent-driven creation.

## Step 2 — materialize on disk

Read `creation.location` literally. Tokens like `<project_cwd>`, `<safe-title>` are placeholders — substitute them:

- `<project_cwd>` — the user's **current project** directory. Resolve it from `flow context list` → `CurrentProjectPath`, and write the record there. Do NOT assume your shell's `pwd` is the right place: as the Flowpad Assistant you run from the system assistant project, not the project the user is looking at, so `pwd` would put the record in the wrong project. Only fall back to `pwd` when `CurrentProjectPath` is absent (no active project). The indexer associates the record with whichever project's directory the file lives under, so writing under `CurrentProjectPath` is what puts it in the right project — no extra index flag needed.
- `<safe-title>` — slugify the user's title (lowercase, hyphens, ascii-only).

For any UUID-shaped field (`task_id`, `id`, …) generate a fresh v4 UUID yourself and remember it — that becomes the entity id, and you'll use it to navigate. Use `python3 -c "import uuid; print(uuid.uuid4())"` if you do not have one mentally.

Use the `Write` tool to create the manifest. Match the example shape from `creation.example`. Required fields come from `manifest_fields`.

## Step 3 — run the indexer

```bash
flow record index <absolute-path-to-the-file-or-its-parent-dir> --types <type>
```

Always pass `--types` when you know the type — it scopes parsing/upsert to your target and keeps the call fast. The output reports `total_indexed`. If `total_indexed == 0` for your type, something about the manifest didn't parse: re-read `flow schema info <type>` and fix the file.

| Exit | Meaning |
| ---- | ------- |
| `0`  | Indexed. Move on. |
| `2`  | Bad arguments (unknown type). |
| `4`  | Path doesn't exist. |
| `5`  | Server unreachable. |
| `6`  | Indexer raised internally. |

## Step 4 — open the result (optional)

The new TypeId is `<type>-<uid_field_value>` — for tasks that's `task-<task_id>`, for skills it's `skill-<skill_id>`, etc. The `after_index` hint in `flow schema info` tells you the exact form. Pass it to `flow navigate entity <typeid>` per [`navigate.md`](navigate.md).

When you are running as the Vibe agent, do not use `flow navigate`; use
`flow show entity <typeid>` instead so the entity opens in the display pane.

## Worked example — create a task and open it

```bash
# 1. Confirm the type is creatable + read the recipe.
flow schema info task

# 2. Generate a uuid and write the manifest.
TASK_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
mkdir -p "tasks/release-notes-0.2.9"
cat > "tasks/release-notes-0.2.9/manifest.json" <<JSON
{
  "task_id": "$TASK_ID",
  "name": "Write 0.2.9 release notes",
  "status": "to_do",
  "task_type": "Task",
  "description": "Draft from merged PRs."
}
JSON

# 3. Index. Scope to the type.
flow record index "$(pwd)/tasks/release-notes-0.2.9/manifest.json" --types task

# 4. Open it — Vibe/Display session uses `flow show`; standard mode uses `flow navigate`.
flow show entity "task-$TASK_ID"        # vibe/creator: into the active display pane
# flow navigate entity "task-$TASK_ID"  # standard assistant: moves the user's browser tab
```

Do not write a long-form summary at the end — a one-line confirmation ("Created task `task-…` and opened it") is enough.

## Creating a record from a metadata object

For types that carry a Pydantic **metadata model** (`TypeInfo.meta_model` — most CRUD entities: `prompt`, `dataset`, `group`, `shell`, `flowpad_diagnosis`, …), create the record directly in Python: discover the fields, build the metadata object, hand it to `FSRecord`, save. Two `uv run` scripts, below — copy them as-is and only change `TYPE` and the field values. Do **not** route this through `flow schema list` / `flow record index` / the running server.

> **Discover the schema locally, never via the running server.** `flow schema list`/`info` reflects the server that is *already running*, which will NOT know about types added in the current branch until it restarts — and the diagnosis was that the agent burned its whole budget guessing because of this. Always resolve the model with `register_all()` + `SchemaRegistry` as in Step 1.

### Step 1 — identify the type & dump its schema (always run first, every type)

```bash
uv run python - <<'PY'
import json
from flow_sdk.schema.type_info import register_all
from flow_sdk.fs_store.schema_registry import SchemaRegistry
register_all()
TYPE = "flowpad_diagnosis"     # <-- your record type
info = SchemaRegistry.get(TYPE)
assert info, f"{TYPE} is not a registered type"
Model = info.meta_model
assert Model, f"{TYPE} has no meta_model — use the file-index pipeline above instead"
# JSON-dump the full schema: every field's type, description, and the `required` list.
print(json.dumps(Model.model_json_schema(), indent=2))
PY
```

This prints the type's **JSON schema** — `properties` (each field's `type`, `description`, default) and the top-level `required` array — so the exact, current fields are unambiguous. The body fields are type-specific (`flowpad_diagnosis` → `title/symptoms/rca/fix`; `shell` → `status/workdir/...`; etc.). You fill `name` (the label — present on *every* type) plus whichever schema fields you have data for. **Match each field's schema `type` exactly** — a `"type": "string"` field needs a quoted value even if it looks numeric (`pty_pid="4123"`, not `4123`); a wrong type raises a clear `ValidationError`, so iterating is safe.

### Step 2 — create + save + validate

Take the field list from Step 1 and fill the `Model(...)` call. The fields shown here are `flowpad_diagnosis`'s example values — **replace them with your TYPE's fields.**

```bash
uv run python - <<'PY'
import asyncio
from flow_sdk.schema.type_info import register_all
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.fs_record import FSRecord
register_all()
TYPE = "flowpad_diagnosis"     # <-- same type as Step 1

async def main():
    Model = SchemaRegistry.get(TYPE).meta_model
    # name is universal; the rest are this type's fields from Step 1 — SWAP for yours.
    meta = Model(
        name="Backend stuck on Starting",
        title="Backend stuck on Starting",
        symptoms="App shows 'Starting…' forever; console: failed to respond on :9007.",
        rca="Stale server.lock blocked the singleton bind.",
        fix="Clear the stale server.lock when the recorded PID is dead.",
    )
    rec = FSRecord(TYPE, id=None, **meta.model_dump(exclude_none=True))  # id=None ⇒ UUID minted
    rec.save()                 # metadata.json on disk
    await rec.sync_to_db()     # DB + search index (drop this line if you only want the file)

    back = FSRecord.find_by_id(rec.id)          # validate by id
    assert back is not None and back.type == TYPE, "record not found after save"
    print(f"OK created+verified {rec.type}-{rec.id}")

asyncio.run(main())
PY
```

Fixed rules — do not deviate:

- **Run Step 1 first, always.** The `Model(...)` body in Step 2 is a `flowpad_diagnosis` example; for any other type, replace those kwargs with the fields Step 1 printed. Only `name` is universal — do **not** assume `title` (or any other field) exists on every type.
- **Discover locally, never via the server** (`SchemaRegistry.get(TYPE).meta_model` after `register_all()`). If it's `None`, the type has no metadata model — use the file-materialize → `flow record index` pipeline above instead.
- **Never pass your own `id`.** Leave `id=None`; `save()` mints a policy-valid UUID. It is **deterministic (v5)** when derivable from the fields, so re-running with identical values upserts the **same** record (same TypeId) rather than creating a new one — change a field if you want a distinct record.
- **Set only fields the model declares.** Unknown kwargs are silently dropped, never persisted — so a typo'd or wrong-type-for-this-type field won't error, it just won't save.
- **`save()` writes the file; `await sync_to_db()` writes the DB.** Run both so the app's lists/search see it; run only `save()` if you just need `metadata.json`.
- **Done = the Step-2 assert printed `OK created+verified …`.** The TypeId is `<TYPE>-<rec.id>`; open it only if the user asked — into a Vibe/Display session use `flow show entity <typeid>`, in standard mode use `flow navigate entity <typeid>` per [`navigate.md`](navigate.md).
- **Ignore the benign `VIRTUAL_ENV … does not match … will be ignored` uv warning** — `uv run` uses the project's `.venv` regardless; it is not an error.

### Step 3 — link the record to the current process (optional)

When you are an agentic process and the record you just made belongs to *this*
run (e.g. a diagnosis you produced), mutually cross-link them so the record
shows up in the process's context and vice-versa. Same single primitive used
everywhere: `cross_link_entities(a, b)`. Self-identify with
`resolve_process_id(None)` (reads `FLOWPAD_EXECUTION_SCOPE`). Fold this into the
Step 2 `main()` right after `await rec.sync_to_db()`:

```python
    import flow_sdk.models.entities  # noqa: F401 — registers entity classes so get_entity_cls works
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.cli.commands._common import resolve_process_id
    from flow_sdk.core.entity.cross_link import cross_link_entities

    proc = await AgenticProcess.get_by_id(resolve_process_id(None))   # this process
    diag = await SchemaRegistry.get_entity_cls(TYPE).get_by_id(rec.id)  # the record's entity
    await cross_link_entities(proc, diag)                              # mutual private-context link
    print(f"OK cross-linked {proc.typeid} <-> {diag.typeid}")
```

Notes: `cross_link_entities` is idempotent (re-runs are no-ops) and saves both
sides. `import flow_sdk.models.entities` is required — entity classes register on
import, and without it `get_entity_cls(TYPE)` returns `None` in a fresh worker
process (`register_all()` only loads the FS metadata schema, not the entity
classes).

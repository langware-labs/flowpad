# Action: records

CRUD on Flowpad records (entities backed by on-disk files: tasks, skills, agents, workflows, …). Use this whenever the user asks to **create**, **make**, or **add** a Flowpad record.

The pipeline is the same for every record type:

1. **Discover** the type with `flow schema info <type>`.
2. **Materialize** the record on disk at the location the schema's `creation.location` points to.
3. **Index** that path with `flow record index <path>` so the indexer parses + persists it.
4. (Optional) **Navigate** to the new record via [`navigate.md`](navigate.md).

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

# 4. Open it.
flow navigate entity "task-$TASK_ID"
```

Do not write a long-form summary at the end — a one-line confirmation ("Created task `task-…` and navigated") is enough.
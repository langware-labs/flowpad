---
id: 9f458fc8-9238-5749-a383-1cca3d2a5a22
---

# The LLM Folder-Index Pipeline

This document describes the **`index.md` folder-index** subsystem — a second, self-contained pipeline that is easy to confuse with the `FSIndexer` scan/discovery walk (`docs/data-management/scan-and-discovery.md`) but shares almost nothing with it. It builds a Merkle tree of one `index.md` per folder, each summarising the files and subfolders beneath it, so a docs tree becomes a navigable, LLM-summarised map (consumed by the `docs-browse` skill and the docs "Atlas" graph).

There are three components people conflate:

1. **`LLMIndexer`** (`flow_sdk/llm_index/indexer.py`) — the deterministic library engine: walk, hash, cache summaries, assemble `index.md` files, diff, and emit a graph.
2. **`index.md` / `index.md.json`** — the on-disk artifacts the engine produces (the rendered markdown plus its canonical JSON sidecar).
3. **The `MarkdownIndex` entity type** (`flow_sdk/builtin/markdown_index.py`) — an `index.md` file *is* an entity; the ordinary `FSIndexer` discovers and indexes it like any other markdown record.

> **This pipeline is not the scan walk.** `FSIndexer` discovers records of many types from disk into the Entity/DB index. The `LLMIndexer` builds one artifact type (`index.md`) from a docs tree using LLM summaries. They meet at exactly one seam: once an `index.md` exists on disk, `FSIndexer` treats it as a `MARKDOWN_INDEX` record. Everything else is separate code, separate hashing, separate invocation.

---

## `flow_sdk/llm_index` is a standalone library

**Source:** `flow_sdk/llm_index/__init__.py`, `core.py`

The package is deliberately independent of the entity/DB layer: no async, no server, no DB imports. Its docstring states it walks a docs tree, summarises files, and assembles a Merkle tree of `index.md` files "with the LLM injected as two pure functions, so every deterministic step (walk, hash, cache, render) is plain Python."

The one shared dependency is the **walk**. `core.scan_tree` delegates to `flow_sdk.fs_store.indexer.walk.gitignore_walk` — the same gitignore-aware engine the `FSIndexer` uses — so scan scope matches every other walker: dot-directories are walked, `.claude/` is force-included (except `.claude/worktrees`), nested `.gitignore` files are honored, and a hardcoded denylist (`node_modules`, `.git`, and the flowpad state dirs `.llm_index` / `.flowpad` / `.markdown_index`) is always skipped even with `gitignore=False`. Symlinked dirs are never followed. Only `.md` / `.mdx` files are treated as summarisable source (`core.SOURCE_EXTS`); the generated `index.md` and the folder note (`<dir>/<dir>.md`) are excluded from a folder's leaves.

### The Merkle tree (`core.py`)

`scan_tree(root)` folds the tree into `FolderNode`s, computing three hashes per folder:

| Hash | Definition |
|---|---|
| `content_hash` (per file) | `sha256` of the file's bytes |
| `own_hash` (per folder) | `sha256` of `template_version` + `prompt_version` + this folder's sorted `(name, content_hash)` pairs — **direct files only** |
| `inputs_hash` (per folder) | `sha256` fold of `own_hash` + each child folder's `inputs_hash` — the Merkle node |

The Merkle hash is **content-derived only** — it never hashes a rendered `index.md` (which carries a timestamp), so re-running with no content change yields identical hashes and nothing is spuriously stale. `own_hash` (files only) is what lets a driver reuse a folder's self-summary when only a *descendant* changed. A folder is stale when its on-disk `existing_hash` (read from `index.md` frontmatter `inputs_hash`) is missing or differs from the freshly computed `inputs_hash`.

---

## `LLMIndexer` — the engine

**Source:** `flow_sdk/llm_index/indexer.py`

`LLMIndexer(path)` scans a root into a tree of `IndexItem` (folders) and `DocItem` (files). It exposes iteration views — `.indexes()` (folders, post-order: leaves before parents), `.docs()` (file leaves), and their `stale_*` variants — plus these operations:

| Method | LLM? | What it does |
|---|---|---|
| `stamp()` | No | Persist the current scan snapshot as the **baseline** (data-dir JSON sidecars + content blobs). Real hashes and titles; summaries only from the existing cache. Idempotent — folders whose baseline already matches are skipped. `manual: true` folders are never stamped. |
| `rebuild(summarize_file, summarize_folder)` | Yes | Full incremental rebuild. The two `summarize_*` callables are the **only** LLM touch-points; `summarize_folder` is skipped (prior reused) when a folder's own files are unchanged. Writes `index.md` + `index.md.json` per stale folder. |
| `diff_since_baseline()` | No | Manifest of what changed since the last `stamp()`: `{added, removed, modified, renamed, stale_folders, unindexed_folders}`. Renames pair strictly 1:1 by `content_hash`. |
| `to_graph()` | No | The scanned tree as `{nodes, edges, counts}` in the dep-graph format — folders → `markdown_index` nodes, files → `markdown` nodes, edges for the parent→child spine (`kind="child"`) and resolved `[[wiki]]` cross-links (`kind="context_shared"`). Powers the docs Atlas. |
| `print_index()` | No | ASCII tree of the scan for debugging. |

**The LLM is injected, never imported.** `rebuild()`'s signature takes `summarize_file: Callable[[DocItem, str], str]` and `summarize_folder: Callable[[IndexItem], str]`. The library ships no model client. In the running system nothing calls `rebuild()` server-side; the LLM rebuild is performed by an AgenticProcess skill (below), and the server only ever drives the no-LLM operations (`stamp`, `diff`, `to_graph`).

### The summary cache and baseline layout

- **File-summary cache** — content-addressed. Each `DocItem`'s one-liner is stored at `<summaries_dir>/<content_hash>.summary.md`. Because the key is the content hash, a summary is reused across renames and re-scans and only regenerated when a file's bytes change. `summaries_dir` defaults to `<root>/.llm_index/summaries` (which the walk ignores), but the server overrides it — see below.
- **Baseline** — `stamp()` writes `index.md.json` sidecars under a caller-supplied `baseline_dir` that lives **outside** the vault, plus content blobs under `blobs_dir` keyed by `sha256` (size- and binary-guarded, with orphan GC). The baseline is what `diff_since_baseline()` and the per-file line `diff` compare against.

---

## The on-disk artifacts: `index.md` + `index.md.json`

**Source:** `flow_sdk/llm_index/index_document.py`

Each indexed folder gets two files written into the folder itself:

- **`index.md`** — the human-readable, rendered index (frontmatter + body).
- **`index.md.json`** — the canonical structured form (`IndexData`), the source of truth. The `.md` is rendered deterministically from it, so identical data always yields identical bytes (stable Merkle hashing).

`index.md` frontmatter carries the entity fields: `type: markdown_index`, `id` (the `markdown_index-<uuid5(path)>` TypeId), `inputs_hash`, `template_version`, `prompt_version`, `parent_ref` (the parent folder's TypeId, empty at root), `vault_root`, `generated_at`, `latest_process_ref`, `file_count`, `subfolder_count`. The body is `# <folder>` → `## Self-Summary` → `## Files` (each `- [[stem]] — <one-line summary>`) → `## Subfolders` (each `- [[name]] — <child self-summary>`).

> **Two JSON schemas exist for the same `index.md.json`, and this is a real gotcha.** The library engine uses the stdlib-`dataclass` `IndexData` (`index_document.py`). The AgenticProcess rebuild skill and the server's read route use the pydantic `IndexMdJson` (`flow_sdk/fs_store/operations/markdown_index_render.py`). They overlap on identity/Merkle fields but differ in per-file shape (`IndexMdJson.FileEntry` adds `rel_path`/`size_bytes`) and in link rendering (`IndexData` renders `[[stem]]` wiki-links; `render_index_md` renders `[title](rel_path)` markdown links). `IndexDocument.load_file` deliberately treats a sidecar with unknown/extra keys as "no baseline" rather than crashing. Know which writer produced a given sidecar before parsing it.

---

## The `MarkdownIndex` entity — where `FSIndexer` re-enters

**Source:** `flow_sdk/builtin/markdown_index.py`, `flow_sdk/fs_store/indexer/functions/markdown_index.py`, `flow_sdk/schema/type_info/markdown_index_type_info.py`

An `index.md` file **is** a `MarkdownIndex` entity (a subclass of `Markdown`). Its YAML frontmatter holds the entity metadata — `inputs_hash`, `template_version`, `prompt_version`, `parent_ref`, `file_count`, `subfolder_count`, `latest_process_ref`. The Merkle property means a leaf-file change invalidates exactly the chain from that leaf to the root and nothing else.

This is the one place the ordinary scan walk touches the pipeline. `MARKDOWN_INDEX` registers a `TypeMetadata` with:

- `from_disk_fn = extract_markdown_index` — reads an `index.md` and parses it into a `MARKDOWN_INDEX` record via `flow_sdk.fs_store.operations.markdown_index.from_markdown`. This lets `FSIndexer` re-parse an already-existing `index.md` (e.g. after a restart).
- a derived identity backend plus `id_stable_key_fn = markdown_index_identity_key` — `TypeInfo.mint_entity_id()` derives `uuid5(NAMESPACE_URL, resolved_path)`, the same formula `LLMIndexer.typeid_for` uses. `extract_markdown_index(ref, resolved_id)` receives that authoritative id; payload/frontmatter values cannot override it.
- `indexed_by_default=False`, `browseable=False` — a **system entity**. It is not crawled by the default indexer sweep and does not appear in the records browser; the rebuild AgenticProcess is the only writer, and callers parse via the operations module.

Because the id is a deterministic `uuid5` of the folder path, re-indexing a rebuilt `index.md` updates the original entity row instead of allocating a duplicate.

### Per-entity data dir

**Source:** `flow_sdk/fs_store/operations/markdown_index.py`

The LLM summary cache and (future) sidecars for a given index entity live under flowpad's records-data root, never inside the user's docs: `entity_data_dir(entity_id)` → `<records_data>/markdown_index/<entity_id>/`, with `file_summaries_dir()` → `.../file_summaries/` and `file_summary_path(entity_id, content_hash)` → `.../file_summaries/<content_hash>.summary.md`. The operations module also provides `from_markdown`, `default_body` (the stub `index.md` written when a `MarkdownIndex` is first created), `write_frontmatter_fields`, and `read_inputs_hash`.

---

## How a rebuild actually runs — the AgenticProcess

**Source:** `flow_sdk/system_projects/flowpad_assistant/.claude/skills/markdown_index/` (`SKILL.md`, `plan.py`), `flow_sdk/server/routes/agent_records.py`

The LLM rebuild is **not** a Python call to `LLMIndexer.rebuild()` in the server. It is an **AgenticProcess tagged `context_data.kind = "markdown_index_rebuild"`**, targeted at a `MarkdownIndex` TypeId. `agent_records.py`'s creation hint for the type says exactly this: after an `index.md` is indexed, "Trigger a rebuild via the LLM Indexers panel or by spawning an AgenticProcess with `context_data.kind='markdown_index_rebuild'` targeted at this TypeId." The linked process id is stored on the entity's `latest_process_ref`.

That AgenticProcess runs the **`markdown_index` skill**, whose contract (`SKILL.md`) is:

1. Resolve the entity's `file_summaries_dir` (strip the `markdown_index-` prefix from the TypeId to get the entity id).
2. Run the deterministic planner — `plan.py build <root> --summaries-dir <dir> [--force]` — a **thin, no-LLM CLI over `LLMIndexer`** (`plan.py` lines 33, 42-105) that emits JSON: `stale_files` and `stale_folders_post_order`. If both are empty it prints `INDEX FRESH` and stops with zero LLM calls.
3. For each stale file, generate a ≤25-word one-liner and write it to the reported `summary_path` (content-addressed cache).
4. For each stale folder, **leaves first**, assemble an `IndexMdJson` object (reusing children's `self_summary` verbatim from their sidecars, and the planner's `inputs_hash` verbatim — the agent never recomputes hashes), write `index.md.json`, then run the **deterministic renderer** `python -m flow_sdk.fs_store.operations.markdown_index_render <json> <md>` to materialize `index.md`. The agent never hand-writes the `.md`.

`plan.py` is the CLI seam. `flow_sdk/llm_index` itself ships **no** top-level `flow` verb; you invoke the library either through this skill's `plan.py` or through the server's docs-graph HTTP routes. The `markdown_index_render` module also has a small `__main__` used as the renderer in step 4.

---

## Server routes

### Read the parsed sidecar

**Source:** `flow_sdk/server/routes/markdown_index.py` (mounted at `/api/v1`, `flow_sdk/server/app.py`)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/markdown-index/json?folder=<path>` | Parse `<folder>/index.md.json` (as `IndexMdJson`) and return it in the `{status, data}` envelope; 404 if the sidecar is missing/unparseable. |
| `GET` | `/api/v1/markdown-index/{entity_id}/json` | Resolve the `MarkdownIndex` entity, then serve the sidecar next to its `asset_ref`. |

### The docs Atlas (native `LLMIndexer`, no LLM)

**Source:** `flow_sdk/server/routes/docs_graph.py`

These routes wire `LLMIndexer` to the vault's per-entity data dir (`_indexer()` resolves `entity_data_dir` from `typeid_for(root)`, sharing the same content-addressed summaries cache the LLM rebuild fills). Every route here is **structural — no LLM**:

| Method | Endpoint | Backing call |
|---|---|---|
| `GET` | `/api/v1/docs-graph?root=<path>` | `scan(...).to_graph()` → `{nodes, edges, counts, duration_ms}`; streams `progress_report` ticks via the shared envelope |
| `POST` | `/api/v1/docs-graph/stamp?root=<path>` | `scan(...).stamp()` — explicit user action; serialized per root by an in-process lock |
| `GET` | `/api/v1/docs-graph/changes?root=<path>` | `scan(...).diff_since_baseline()` |
| `GET` | `/api/v1/docs-graph/diff?root=&rel=` | Per-file git-style unified diff vs the stamped baseline (CAS blob → `git show HEAD:./<rel>` → empty) |
| `GET` | `/api/v1/docs-graph/doc?root=&rel=` | Read one markdown doc under the root (path-escape guarded) for the Atlas reading drawer |

---

## How this differs from `FSIndexer` (disambiguation)

| | `FSIndexer` (scan & discovery) | `LLMIndexer` (this pipeline) |
|---|---|---|
| **Purpose** | Discover records of many types from disk into the Entity/DB index | Build one `index.md` per folder summarising its contents |
| **Source** | `flow_sdk/fs_store/indexer/index_function.py` | `flow_sdk/llm_index/indexer.py` |
| **Output** | `FSRecord`s persisted to the DB + FTS | `index.md` + `index.md.json` files on disk |
| **Types handled** | All registered walker types (skill, agent, markdown, plan, …) | Folders → `index.md`; the resulting file is a `MARKDOWN_INDEX` record |
| **Hashing** | Per-record `.hash` sentinel (skip-fresh) | Merkle `inputs_hash` folded over content hashes |
| **LLM** | None | Two injected `summarize_*` functions (rebuild only) |
| **Async / DB** | Async, DB-bound | Pure sync library, no DB imports |
| **Invocation** | `POST /fs-records/index`, scan actions | `markdown_index` skill (AgenticProcess) for LLM rebuild; `docs-graph` routes for structural ops |
| **Walk** | `gitignore_walk` | **Same** `gitignore_walk` — the single shared seam |

The two also connect one-directionally: after the `LLMIndexer` (or the rebuild skill) writes an `index.md`, a normal `FSIndexer` pass discovers it as a `MARKDOWN_INDEX` record through `extract_markdown_index`. Nothing flows the other way — `FSIndexer` never triggers a summary or a rebuild.

---
id: 477fc513-ac33-4716-b921-196fec3981c5
type: workflow
name: markdown_index_smoke
description: MarkdownIndex E2E — seed docs, run LLM indexer from UI, validate generated index + UI panel
tags: [markdown_index, llm_indexers, smoke]
---

# MarkdownIndex — Smoke (S1–S11)

End-to-end regression for the `MarkdownIndex` entity and its LLM Indexers UI
panel. Seeds a small docs tree, triggers a rebuild from the UI, validates the
generated `index.md` files and structural invariants, then asserts
incrementality.

Pins the post-correction invariants:

* `index.md.json` lives **inside the entity's record folder**, never in user docs.
* User docs contain **only** `index.md` files (no sidecars, no cache dirs).
* Folder click follows Obsidian convention: `<folder>.md` wins over `index.md`.

## Prerequisites

* Backend running at `${API_URL}` (default `http://localhost:9008`).
* Frontend running at `${APP_URL}` (default `http://localhost:4098` — the one paired with the flowpad-oss backend on 9008).
* `ANTHROPIC_API_KEY` is set in the backend env — the rebuild `AgenticProcess`
  calls Claude.
* `TMP_DOCS` defaults to `/tmp/mdindex_smoke_docs`.

> **Scope note:** S7, S9, S10 are marked **DEFERRED** — they assert features
> that aren't yet implemented (sidecar `index.md.json` in the record folder; a
> folder-tree docs viewer with Obsidian-style folder-note routing + Index side
> panel). Run S1–S6, S8, S11 for the current pipeline.

## Steps

### S1: Backend reachable + entity type registered
* `GET ${API_URL}/api/v1/graph/bootstrap` → HTTP 200 with `"status":"SUCCESS"` in the body.
* `GET ${API_URL}/api/v1/agent/schema/markdown_index` → HTTP 200.
* Response body must contain: `has_record_cls: true`, `has_entity_cls: true`.
* Response body must contain: `indexed_by_default: false`, `browseable: false`. (System entity — not crawled, not in records browser.)
* Note: `parent_type` may or may not be populated — self-referential parent_type registration is best-effort and not required for smoke.

### S2: Seed a small docs tree
* `rm -rf ${TMP_DOCS}` then `mkdir -p ${TMP_DOCS}/auth/oauth ${TMP_DOCS}/billing`.
* Write each file ≤ 1 KB:
  * `${TMP_DOCS}/README.md` → `# Project intro\n\nSmoke fixture for MarkdownIndex.\n`
  * `${TMP_DOCS}/auth/auth.md` → `# Auth\n\nFolder note authored by user (Obsidian convention).\n`
  * `${TMP_DOCS}/auth/config.md` → `# Auth config\n\nJWT lifetimes, refresh policy.\n`
  * `${TMP_DOCS}/auth/oauth/pkce.md` → `# PKCE flow\n\nProof Key for Code Exchange — sketch only.\n`
  * `${TMP_DOCS}/billing/invoices.md` → `# Invoice schema\n\nLine items, tax rules.\n`
* `find ${TMP_DOCS} -type f` should print exactly 5 paths.

### S3: Open LLM Indexers panel
* Navigate browser to `${APP_URL}/dock/lens/fs-records/scan/`.
* Wait for the scan page; click `[data-testid="toolbar-llm-indexers"]`.
* Assert URL is now `${APP_URL}/dock/lens/fs-records/llm-indexers/`.
* Assert `[data-testid="llm-indexers-lens"]` is in the DOM.
* Assert `[data-testid="llm-indexers-table"]` is present (even if empty).

### S4: Register the seeded docs root as a MarkdownIndex
* `POST ${API_URL}/api/v1/graph/markdown_index` body `{"vault_root":"${TMP_DOCS}","asset_ref":"${TMP_DOCS}/index.md","name":"smoke"}` → capture returned `id` (full TypeId: `markdown_index-<uuid>`). (The panel doesn't expose an "Add" button — direct POST is the only path today.)
* Click "Refresh" in the panel; assert the new row appears in `[data-testid="llm-indexers-table"]` whose `Vault root` column shows `${TMP_DOCS}`.
* Row status pill MUST read "never run".

### S5: Cold build — click Run
* Click the Run button on the smoke row.
* Toast/notification confirms rebuild started.
* Row status pill transitions to "running" within 3 s.
* Capture `latest_process_ref` from the row (or via `GET /api/v1/graph/markdown_index/<id>`).
* Poll `GET ${API_URL}/api/v1/graph/agentic_process/<latest_process_ref>` until `status == "STOPPED"`. Cap 120 s — real LLM calls take real time. If the cap is hit, FAIL with the last status + transcript tail.

### S6: Every folder got an `index.md` with correct frontmatter
* Files must exist:
  * `${TMP_DOCS}/index.md`
  * `${TMP_DOCS}/auth/index.md`
  * `${TMP_DOCS}/auth/oauth/index.md`
  * `${TMP_DOCS}/billing/index.md`
* For each: parse YAML frontmatter; assert:
  * `type: markdown_index`
  * `inputs_hash` is non-empty (`sha256:...` or hex of length 64).
  * `generated_at` is a valid ISO timestamp within the last 130 s.
  * `parent_ref` chains correctly: root has `parent_ref: ""`; every other points to its parent folder's MarkdownIndex TypeId.
  * `file_count` + `subfolder_count` match what's on disk.

### S7: `index.md.json` is INTERNAL — in record folder, NOT in user docs  **[DEFERRED]**
* Not yet implemented. The rebuild agent currently writes only `index.md` (the rendered file in user docs). The structured sidecar `index.md.json` in the record folder is a planned follow-up.
* When implemented:
  * `find ${TMP_DOCS} -name 'index.md.json'` MUST return **nothing**.
  * Sidecar lives at `<records_data_root>/markdown_index/<entity_id>/index.md.json` and parses as valid JSON matching the entity's fields.

### S8: User docs stay clean — no sidecars, no cache dirs
* `find ${TMP_DOCS} -type f -name '*.json'` → MUST return **nothing**.
* `find ${TMP_DOCS} -type d -name '.markdown_index'` → MUST return **nothing**. (Regression guard against the deleted cache invention.)
* `find ${TMP_DOCS} -type d -name '.cache'` → MUST return **nothing**.
* `find ${TMP_DOCS} -type d -name '.flowpad'` → MUST return **nothing**.
* Per-entity summary cache lives at `<records_data_root>/markdown_index/<entity_id>/file_summaries/` — assert that path contains ≥ 1 summary file after S5.
* The only files under `${TMP_DOCS}/` must be the 5 user-authored `.md` from S2 + the 4 generated `index.md` from S6 = 9 total.

### S9: Obsidian-style folder click — folder note wins, side panel renders  **[DEFERRED]**
* Not yet implemented. The current `DocsViewer.tsx` is a flat per-process `.md` lister scoped to a single AgenticProcess — no folder tree, no Obsidian routing, no side panel mount point.
* When a docs-tree viewer ships:
  * Folder click on `auth/` opens `auth/auth.md` (folder note), side panel `[data-testid="folder-index-panel"]` mounts and renders the MarkdownIndex entity (Self-Summary, Files, Subfolders).

### S10: Folder click without folder note — `index.md` opens directly  **[DEFERRED]**
* Same dependency as S9. When the tree viewer ships:
  * Folder click on `billing/` opens `billing/index.md` directly; no side panel mounts (the file IS the index).

### S11: Incremental rebuild — only the changed chain regenerates
* Capture `generated_at` from all 4 `index.md` files (`t_root`, `t_auth`, `t_oauth`, `t_billing`).
* Sleep 2 s to guarantee timestamp distinctness.
* Append a line to `${TMP_DOCS}/auth/oauth/pkce.md`: `\nAdditional context for incrementality test.\n`.
* Click Run on the smoke row again; wait for `STOPPED` (cap 120 s).
* Re-read `generated_at` from all 4 files:
  * `t_oauth'` MUST be newer than `t_oauth`.
  * `t_auth'` MUST be newer than `t_auth`.
  * `t_root'` MUST be newer than `t_root`.
  * `t_billing'` MUST equal `t_billing` exactly (sibling subtree untouched).
* Also assert: at most 1 per-file LLM summary cache entry was added under the entity's record folder (`<record_dir>/file_summaries/`) — only the edited file should have produced a new summary; sibling files reused cached summaries.

## Pass criteria

S1 through S11 all pass.

## Cleanup

* `DELETE ${API_URL}/api/v1/graph/markdown_index/<id>` (best-effort).
* `rm -rf ${TMP_DOCS}`.
* `rm -rf <record_dir>` from S7 (best-effort; framework may handle on entity delete).

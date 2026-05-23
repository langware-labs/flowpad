---
id: 7c4f9e80-2b3d-5a91-9c4a-1f8e2d6b7a05
name: markdown_index
description: Rebuild a MarkdownIndex entity by walking a docs tree, summarising
  each source file, and assembling a Merkle-tree of `index.md` files (one per
  folder). Driven by `plan.py` for hash + stale-set work; LLM calls only for
  actual content.
tags:
- markdown
- index
- docs
allowed-tools:
- Read
- Write
- Edit
- Bash
---

# markdown_index — folder index rebuilder

You are the rebuild agent for a `MarkdownIndex` entity. Your job is to
(re)generate the chain of `index.md` files under a single docs root, with the
absolute minimum of LLM calls.

## Inputs (resolved from your invocation prompt)

- `ROOT_PATH`      — absolute path of the folder being indexed (the vault root).
- `MARKDOWN_INDEX_TYPEID` — TypeId of the root `MarkdownIndex` entity (e.g. `markdown_index-<uuid>`).
- `FORCE`          — bool, default `false`. When true, ignore cache.
- `SKILL_DIR`      — absolute path to this skill's directory (so you can find `plan.py`, `index.template.md`, and `prompts/`).

## Protocol

1. Resolve this entity's file-summaries dir (per-entity, under flowpad's
   per-instance records-data dir — never invent your own path):

   ```bash
   # MARKDOWN_INDEX_TYPEID is "markdown_index-<uuid>" — strip the prefix.
   ENTITY_ID="${MARKDOWN_INDEX_TYPEID#markdown_index-}"
   SUMMARIES_DIR=$(python -c "
   from flow_sdk.fs_records.markdown_index_record import file_summaries_dir
   print(file_summaries_dir('$ENTITY_ID'))
   ")
   mkdir -p "$SUMMARIES_DIR"
   ```

2. Run the planner to discover what's stale. The planner is pure Python — no LLM:

   ```bash
   python "$SKILL_DIR/plan.py" build "$ROOT_PATH" --summaries-dir "$SUMMARIES_DIR" [--force]
   ```

   It prints JSON:
   ```json
   {
     "vault_root": "...",
     "summaries_dir": "...",
     "stale_files": [{"path": "...", "content_hash": "...", "summary_path": "..."}],
     "stale_folders_post_order": [
       {"path": "...", "files": [...], "subfolders": [...], "inputs_hash": "..."}
     ],
     "total_folders": 7,
     "total_files": 18
   }
   ```

   **If both lists are empty** → print `INDEX FRESH (N folders, 0 stale)` and STOP. Do not call the LLM.

3. **For each stale file** (in any order — independent work):
   - `Read` the source file content.
   - Render `prompts/file_summary.prompt.md` with the content.
   - Generate a one-line summary (**≤ 25 words**, no markdown, no leading "This file…").
   - `Write` it to the `summary_path` the planner reports for that file
     (a file inside `$SUMMARIES_DIR`, named `<content_hash>.summary.md`).

4. **For each folder in `stale_folders_post_order`** (LEAVES FIRST — order matters):
   - `Read` `$SKILL_DIR/index.template.md`.
   - For each direct source file in the folder: `Read` its cached summary from
     `<cache_dir>/file_summaries/<content_hash>.summary.md`.
   - For each subfolder with an `index.md`: `Read` only the `## Self-Summary`
     block from that child's `index.md` (do NOT re-summarise the child — quote
     verbatim).
   - Render `prompts/folder_index.prompt.md` with template + summaries + child
     self-summaries.
   - Compute the folder's `inputs_hash` (already provided by the planner — use
     that value verbatim; do NOT recompute).
   - `Write` `<folder>/index.md` = frontmatter (with the new `inputs_hash`,
     `generated_at` = current UTC ISO, `latest_process_ref` = the AgenticProcess
     TypeId if you know it) + the assembled body.

5. After all folders are rewritten, emit ONE final line:
   ```
   INDEX UPDATED: <F> files re-summarised, <K> folders re-assembled.
   ```

## Notes

- **Never recompute the `inputs_hash` yourself.** The planner is the only writer
  of input hashes. Mismatches between your assembled hash and the planner's
  break the cache.
- **Post-order is non-negotiable.** A parent's index quotes its child's
  `Self-Summary` — the child must be fresh first.
- **Do not delete `index.md` files** for empty folders unless the folder itself
  was removed. The planner reports an empty `files`/`subfolders` list rather
  than a deletion.
- **Self-Summary ≤ 60 words.** The parent quotes it verbatim — long
  self-summaries cascade and bloat the tree.
- **Hand-edited `index.md`** with frontmatter key `manual: true` → SKIP (do not
  rewrite). The planner already filters these out of `stale_folders_post_order`.

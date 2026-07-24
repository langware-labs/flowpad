---
id: 72621c37-45ba-5d74-a639-70bb5ccf9054
name: docs-browse
description: Use this skill to do fast and efficient browsing in the project documents.
  Whenever you need to find information, answer a question, or locate a tag inside
  a project's docs/markdown tree, use this skill FIRST — it navigates the pre-built
  `index.md` chain instead of grepping or reading files blindly.
tags:
- markdown
- index
- docs
- search
allowed-tools:
- Read
- Glob
- Bash(flow record search:*)
---

# docs-browse — navigate the docs index instead of grepping

The `markdown_index` skill (the WRITE side of this pair) maintains a Merkle
chain of `index.md` files, one per folder, under any indexed docs root. This
skill is the READ side: descend that chain to reach the right document in
O(depth) reads instead of scanning the whole tree.

## Protocol

1. **Locate the entry index.** Look for `index.md` in, in order: the working
   directory, `./docs/`, then parent directories up to the project root. If
   none found, `Glob **/index.md` and pick the shallowest hit. An index built
   by the chain has YAML frontmatter with `inputs_hash`, `file_count`,
   `subfolder_count`; a hand-written `index.md` without that frontmatter is
   still usable for orientation but skip the freshness reasoning below.

2. **Read and orient.** Each `index.md` contains:
   - `## Self-Summary` — what this folder covers.
   - `## Files` — a one-line summary per direct file.
   - `## Subfolders` — each child folder's own self-summary.

   Match your question against these entries.

3. **Descend, don't grep.** If a `## Files` entry matches, `Read` that file —
   done. If a `## Subfolders` entry matches, `Read` `<subfolder>/index.md`
   and repeat: root → subfolder → … → target document. Never fall back to
   grep/search while a matching index entry exists at the current level.

4. **Answer from the target file(s).** `Read` the full target document. The
   index summaries are navigation aids, not authoritative content — quote and
   cite the document, never the summary.

## Freshness caveat

The index can lag the files. Staleness signals: a summary that contradicts
the file you just read, or a file present on disk but missing from
`## Files`. When in doubt, trust the source files over the index and re-read
the actual document. Do NOT rebuild the index yourself — rebuilding is the
`markdown_index` skill's job (spawned from the LLM Indexers panel).

## Fallback: no index exists

If no `index.md` chain exists under the docs root, use full-text search:

```bash
flow record search "<query>" 1y 20
```

Each result carries an `asset_ref` — `Read` that file directly rather than
issuing more CLI calls. Only grep the tree directly as a last resort.

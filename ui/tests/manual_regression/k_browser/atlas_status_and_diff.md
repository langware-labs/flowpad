---
id: 9356e4ac-5016-5ba2-8932-584ab6acf99e
---

# Knowledge Atlas — index status, real-fs change detection, line diffs

End-to-end contract for the Atlas baseline/status/diff layer. The Atlas
(`/dock/k-browser/vfs/<docs-root>`) renders a docs vault from a native
`LLMIndexer.scan()`. A **Stamp baseline** action persists the scan snapshot
(per-folder `index.md.json` + content blobs) into the instance data dir —
never into the vault. Subsequent rescans compare the live tree against that
baseline and overlay per-node status: hollow badge = unindexed, amber ● =
modified, emerald + = added, dashed − + ghost card = removed. A topbar
"N changed" chip toggles a changes-highlight mode; the reading drawer gains a
**Changes** tab rendering a Monaco line diff (old text from the CAS blob).

The whole flow is structural — no LLM, no `ANTHROPIC_API_KEY` needed.

## Prerequisites

- Backend + frontend running (oss dev pair: vite `:4098` → api `:9008`;
  override with `VITE_PORT` / `API_URL`).
- Writable `/tmp` (the test seeds and mutates a real vault at
  `/tmp/qa_atlas_docs`, override with `TMP_DOCS`).

## Steps

### T1 — seed a real vault; everything reads `unindexed`
- Seed on disk: `alpha.md`, `beta.md` (root) + `sub/gamma.md`, `sub/delta.md`,
  with one `[[gamma]]` wiki link inside `alpha.md`.
- Open `/dock/k-browser/vfs//tmp/qa_atlas_docs`.
- Expect: root card + `sub` pill + 4 doc cards; every doc carries the hollow
  `unindexed` badge (`[data-testid="kb-status-badge"]` × 4); no changed chip.

### T2 — stamp the baseline (explicit click, vault untouched)
- Click `[data-testid="kb-stamp"]` ("Stamp baseline") and wait for the rescan.
- Expect: zero status badges (all fresh); the vault directory contains **no**
  `index.md.json` (the baseline lives in the instance data dir); a second
  stamp via the API reports `folders_stamped: 0` (idempotent).

### T3 — real filesystem mutations are detected on rescan
- Mutate the vault with plain `fs`: append a line to `alpha.md` (modify),
  create `epsilon.md` (add), delete `beta.md` (remove), rename
  `sub/gamma.md` → `sub/gamma2.md` (rename = add+remove pair).
- Click the zoomer Rescan button (`button[title="Rescan docs"]`).
- Expect: amber ● on `alpha.md`; + badges on `epsilon.md` and `sub/gamma2.md`;
  **ghost cards** (dashed, struck-through) for `beta.md` and `sub/gamma.md`;
  chip reads **"5 changed"**; clicking the chip fades the untouched nodes
  (changes-highlight mode).

### T4 — line diff in the drawer
- Click the modified `alpha.md` card → drawer opens → click
  `[data-testid="kb-changes-tab"]`.
- Expect `[data-testid="kb-diff-panel"]` to render the Monaco diff containing
  the appended line.
- Click the `beta.md` ghost → drawer opens directly on Changes; the diff shows
  the removed content (old vs nothing).

### T5 — no false positives; stamp clears
- Click Rescan again with no fs changes → chip still "5 changed" (stable).
- Click Stamp → badges drop to zero, chip disappears.

## Failure modes & first-pass debugging

| Symptom | Likely cause | First check |
|---|---|---|
| All nodes stay `unindexed` after stamp | stamp wrote nowhere / data-dir resolution failed | `POST /api/v1/docs-graph/stamp?root=…` response; `entity_data_dir` perms |
| Everything flips `modified` after stamp | baseline hashes don't match scan (schema drift) | `GET /api/v1/docs-graph/changes?root=…` |
| Diff panel empty for a modified file | blob missing + vault not a git repo | blobs dir beside the baseline; `skipped` field in `/diff` response |
| Ghosts not rendered | removed nodes lack the synthesized child edge | `is_ghost` nodes + their `child` edges in `/docs-graph` payload |

## Teardown

- `rm -rf /tmp/qa_atlas_docs`; baselines for the temp vault are keyed by its
  path-uuid and are inert (re-stamping a recreated vault overwrites them).

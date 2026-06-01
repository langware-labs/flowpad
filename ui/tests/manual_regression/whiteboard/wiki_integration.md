---
id: e7b2c4a9-1f86-4d23-bc05-9a3e1f7c0d28
---

# Whiteboard participates in the wiki graph
# Corrected 2026-05-31: the wiki edge table is `links` (cols: src_type, src_id,
# src_name, target_name, target_type, target_id, resolved) in
# ~/.flow/instances/oss/flowpad.db. A whiteboard's wiki body is its WHITE_BOARD.md
# (see indexer extract_whiteboard -> rec.body = WHITE_BOARD.md). Wiki edges are
# (re)extracted during fs-records index, not on autosave, so an explicit index is
# required before asserting.

test 1: a whiteboard whose WHITE_BOARD.md has a [[wiki-link]] creates a links-table edge
- [bash] run: create target — curl -s -X POST {API_URL}/api/v1/graph/markdown -H 'Content-Type: application/json' -d '{"name":"wiki-target-q2","body":"# target\n"}'
- [bash] run: create source whiteboard — curl -s -X POST {API_URL}/api/v1/graph/whiteboard -H 'Content-Type: application/json' -d '{"name":"wiki-src-q2"}' ; capture asset_ref
- [bash] run: append a prose wiki link to the board's markdown — printf '\nSee [[wiki-target-q2]] for details.\n' >> "<asset_ref>/WHITE_BOARD.md"
- [bash] run: validate the link is in the file — grep -c 'wiki-target-q2' "<asset_ref>/WHITE_BOARD.md" (>=1)
- [bash] run: index whiteboards — curl -s -X POST "{API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=whiteboard" ; wait ~3s
- [bash] run: query the wiki graph — sqlite3 ~/.flow/instances/oss/flowpad.db "SELECT count(*) FROM links WHERE src_type='whiteboard' AND target_name='wiki-target-q2';"
- validate the count is >= 1 (an edge from the whiteboard to the target name)

# Cleanup: rm -rf <asset_ref>; DELETE the markdown + whiteboard entities (best-effort).

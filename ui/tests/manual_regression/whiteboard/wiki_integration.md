---
id: 9d2a4c0e-1f8b-4e5a-9c11-440044004400
type: workflow
name: whiteboard_wiki_integration
description: Whiteboard wiki integration W1-W5 — search, wikilink dispatch, missing-link picker, backlinks, rename safety
tags: [whiteboard, wiki]
---

# Whiteboard — Wiki Integration (W1–W5)

## Steps

### W1: Wiki resolve endpoint hits the whiteboard
* Create a whiteboard named `wiki-target-<random>` via POST.
* GET `${API_URL}/api/v1/wiki/resolve?name=wiki-target-<random>`.
* Expect HTTP 200 with body `{ type: "whiteboard", id: <uuid>, asset_ref: ".../<name>" }`. Body MUST NOT be `null`.

### W2: Wikilink from markdown dispatches to whiteboard editor
* Create a markdown doc named `wiki-source-<random>` via POST `${API_URL}/api/v1/graph/markdown` with body `{"name":"...","description":"..."}`.
* Write into its body the text `[[wiki-target-<random>]]` (use the FS API or write directly to its `asset_ref`).
* Navigate to the markdown doc's editor.
* Find the rendered wikilink (text content `[[wiki-target-...]]` or an `<a>` whose href matches `/dock/assets/wiki/wiki-target-...`).
* Click it.
* Wait up to 5s; URL must end up at `/dock/assets/editor/whiteboard/<asset_ref>` (NOT the WikiResolveView fallback).
* Validate `[data-testid="whiteboard-editor"]` mounted.

### W3: Missing wikilink → type picker offers Whiteboard
* Navigate to `${APP_URL}/dock/assets/wiki/non-existent-name-<random>`.
* Wait for the WikiResolveView "not found" card. Validate `[data-testid="wiki-not-found"]` present.
* Validate `[data-testid="wiki-create-as"]` radio group present with two options (`#wiki-create-markdown` selected by default, `#wiki-create-whiteboard` selectable).
* Click `#wiki-create-whiteboard`, then click "Create it".
* Wait up to 8s for a whiteboard editor to mount at `non-existent-name-<random>`.
* Validate `${API_URL}/api/v1/wiki/resolve?name=non-existent-name-<random>` now returns `type: "whiteboard"`.

### W4: Backlinks panel includes the source markdown
* Open the whiteboard from W2 (the one named `wiki-target-...`).
* Find and open the Backlinks side tab (look for `[data-testid*="backlink"]` or similar).
* Validate the source markdown doc appears in the backlinks list.

### W5: Rename safety — id survives folder rename
* Capture the id of the whiteboard from W2.
* Rename the folder on disk: `mv .../wiki-target-X .../wiki-target-X-renamed`.
* Force a re-index: `POST ${API_URL}/api/v1/search/reindex/whiteboard`.
* Wait 2s.
* GET `${API_URL}/api/v1/graph/whiteboard/<id>` → expect HTTP 200 with `asset_ref` now ending in `wiki-target-X-renamed`.
* GET `${API_URL}/api/v1/wiki/resolve?name=wiki-target-X-renamed` → expect HTTP 200 with the same id as before.
* GET `${API_URL}/api/v1/wiki/resolve?name=wiki-target-X` (the OLD name) → expect null (rename invalidates the old name).

## Pass criteria

W1, W2, W3, W4, W5 all pass. W5's "old name resolves to null" is expected behavior, not a failure.

## Cleanup

* Remove all created whiteboards + markdown docs.

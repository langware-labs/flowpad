# Wiki link layer — manual regression

Scenarios collected from the validation runs that shipped Phase 1–3 of the
wiki feature (backend `links` table + `Entity.reindex` + frontend toolbar
+ search modal + parser support for `/dock/assets/wiki/<name>` URLs).

## Setup

- Backend running: `uv run -m flow_sdk.server.run` on `LOCAL_SERVER_PORT` (defaults to 9008 in `.env.local`).
- UI dev server: `cd ui && npm run dev` (defaults to 4098).
- A project with at least one named entity (skill / agent / workflow / plan / markdown) — needed for search-result scenarios.

---

## Backend

### test 1: wiki action lives at /api/v1/graph/{type}/{id}/wiki/{links|backlinks}

- `curl -s "http://localhost:9008/api/v1/graph/skill/00000000-0000-0000-0000-000000000000/wiki/links"`
- expected: `{"status":"SUCCESS","message":"success","data":[]}` for an unknown id.
- repeat with `/wiki/backlinks` — same response shape.
- request to `/wiki/garbage` (unknown sub-path) returns `{"status":"FAIL","message":"Unknown wiki ..."}` with status 404.

### test 2: POST reindex with body extracts edges

- ```bash
  curl -s -X POST -H "Content-Type: application/json" \
    -d '{"body":"hello [[world]]"}' \
    "http://localhost:9008/api/v1/graph/skill/00000000-0000-0000-0000-000000000000/wiki/reindex"
  ```
- expected: `{"status":"SUCCESS","data":[{"src_type":"skill","src_id":"...","raw":"world","target_type":null,"target_id":null,"line":1, ...}]}`.
- `target_type` / `target_id` are `null` because `world` doesn't resolve to any entity — that's correct for a ghost target.
- following GET `/wiki/links` now returns the same row.

### test 3: parser recognizes /dock/assets/wiki/&lt;name&gt; URLs as edges

- POST reindex with body `'{"body":"See [my-process](/dock/assets/wiki/my-process) for details."}'`.
- expected: returned edges have `raw="my-process"` (the URL was decoded into a wiki link, not just stored as a markdown path).
- repeat with percent-encoding: body `'{"body":"[my proc](/dock/assets/wiki/my%20proc)"}'` — `raw` should be `"my proc"` (decoded).

### test 4: source path of system docs returns FAIL on bare resolve

- `curl -s "http://localhost:9008/api/v1/graph/skill/dummy/wiki/links"` returns 404 / Invalid request — `dummy` doesn't validate as an id.
- this confirms the route requires a real id format; not a free path.

---

## Frontend — toolbar visibility

### test 5: wiki toolbar appears in editor mode at the right end of the existing toolbar

- open any markdown asset (e.g. `/dock/assets/editor/markdown/<some-md-path>`).
- switch to `editor` mode via the mode toggle.
- expected: a button with `data-testid="wiki-toolbar-add-link"` appears AT THE RIGHT END of the existing Bold/Italic/Heading/List toolbar, separated by the standard `mx-1.5 h-4 w-px bg-border` divider.
- inspector check (browser console):
  ```js
  const btn = document.querySelector('[data-testid="wiki-toolbar-add-link"]');
  console.assert(btn && !btn.disabled, 'wiki button should be present and enabled');
  ```

### test 6: wiki toolbar is hidden in non-editor modes

- on the same doc, switch to `view` → button is gone.
- switch to `review` → button is gone.
- switch to `markdown` (Monaco raw) → button is gone (Milkdown isn't rendered).
- expected: `document.querySelector('[data-testid="wiki-toolbar-add-link"]')` returns `null` in all three modes.

### test 7: toolbar uses identical FormatButton styling as Bold/Italic/etc

- in editor mode, inspect the wiki button's CSS class list.
- expected substring: `flex h-7 w-7 items-center justify-center rounded hover:bg-muted` — same shape as Bold/Italic.
- visual: the icon (Link2) is the same 14px size, same hover behavior.

---

## Frontend — search modal

### test 8: clicking the wiki button opens the search dialog

- editor mode + click `wiki-toolbar-add-link`.
- expected: a Dialog opens; `[data-testid="wiki-link-search-input"]` is visible and focused.
- expected: a type-filter Select with `[data-testid="wiki-link-type-filter"]` appears next to the input, default value "All types".

### test 9: typing in the search input returns matching entities

- type `echo` (or any 2+ char query that matches existing entities).
- wait ~600ms.
- expected: ≥1 result rendered as buttons with `data-testid="wiki-link-search-result"`.
- each result shows the entity name (or "(unnamed)") + a small `record_type` label.

### test 10: type filter narrows results

- with the same query, change the type-filter select to e.g. `skill`.
- expected: results refresh, only `skill` rows remain.
- change to `agentic_process` — only agentic_process rows.
- change back to "All types" — full set returns.

### test 11: clicking a named result inserts a real `<a>` link

- in search modal with results visible, click a named result (one not labeled "(unnamed)").
- expected within ~600ms:
  - dialog closes.
  - the editor's ProseMirror node contains a `<a href="/dock/assets/wiki/<name>"><name></a>` element where `<name>` is the entity's name.
  - **NO literal `[[` or `]]` characters appear in the editor body** (regression check for the original bug where plain text was inserted).
- inspector:
  ```js
  const a = document.querySelector('.ProseMirror a[href^="/dock/assets/wiki/"]');
  console.assert(a, 'expected anchor with /dock/assets/wiki/ href');
  console.assert(!document.querySelector('.ProseMirror').textContent.includes('[['), 'no literal [[ allowed');
  ```

### test 12: clicking an unnamed entity prompts for a name

- in search results, click a result rendered as `(unnamed)`.
- expected: dialog content swaps to a name-prompt panel with `[data-testid="wiki-link-name-input"]` and a "Save & insert" button (`[data-testid="wiki-link-name-confirm"]`).
- type a name (e.g. `my-orphan`), click Save & insert.
- expected: dialog closes, the entity now has `name="my-orphan"` (verifiable via `GET /api/v1/graph/<type>?name=my-orphan` or by re-opening the modal and searching for it), AND the editor has `<a href="/dock/assets/wiki/my-orphan">my-orphan</a>`.

---

## Frontend — out-of-tree (no source entity) docs

### test 13: toolbar works for system docs that lack a source entity

- navigate to a doc that has NO entity row, e.g.
  `/dock/assets/editor/markdown/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/system_projects/flowpad_assistant/.claude/docs/hello-flowpad.md`.
- switch to `editor` mode.
- expected: `wiki-toolbar-add-link` is still **enabled** (not disabled) — verified by `btn.disabled === false`.
- click → search modal opens, click a result → `<a>` link inserted.
- the source entity reindex is skipped silently (no error in console). The link still lives in the saved file; the next time the source is registered as an entity, sync_to_db will pick it up.

### test 14: tooltip shows "Add entity link" regardless of source state

- hover the wiki button on both an indexed doc and an unindexed doc.
- expected: tooltip says **"Add entity link"** in both cases (no longer the old "No source entity for this doc" message).

---

## End-to-end through the SDK

### test 15: skill body wikilinks resolve via APIEntity.getLinks / getBacklinks

- (this is the python north-star + vitest test scenario, replicated manually.)
- create a process: `await new AgenticProcess({ name: 'wiki-test-proc', ... }).save()`.
- create a skill: `await Skill.create('wiki-test-skill')`.
- write SKILL.md body: `await skill.doc.write('See [[wiki-test-proc]] for details.')`.
- trigger reindex: `await skill.reindex('See [[wiki-test-proc]] for details.')`.
- expected: `await skill.getLinks()` returns one edge with `target_type === 'agentic_process'`, `target_id === process.id`, `raw === 'wiki-test-proc'`, `line === 1`.
- expected: `await process.getBacklinks()` returns the same edge with `src_id === skill.id`.

### test 16: APIEntity.reindex without body re-reads from disk

- after test 15, edit SKILL.md externally (or via `skill.doc.write(...)`) to remove the wikilink.
- call `await skill.reindex()` (no body argument).
- expected: returned edge list is empty; `await skill.getLinks()` returns `[]`.

### test 17: getLinks on a target-only entity (Task) returns empty

- create a `TaskResource(id=..., title=..., status='To Do')` and `await task.save()`.
- expected: `task.get_links()` (python) and `await taskEntity.getLinks()` (TS) both return `[]`. Tasks have no body to extract links from.
- backlinks remain queryable: another doc linking to a task name should show up via `task.get_backlinks()`.

---

## Regression alarms

If any of the following appear in the editor after using the toolbar, it's
the original bug returning:
- Literal `[[` or `]]` text in the editor body.
- A markdown link with extension `.md` (`[name](/dock/assets/wiki/name.md)`) — the URL must NOT have `.md`.
- `target_type=null` for a name that *does* exist as an entity (resolver miss).
- Wiki toolbar button missing or always-disabled in editor mode.

## How to run the python + vitest counterparts

- `cd flowpad-oss && uv run pytest tests/wiki/ -q` — 53 tests pass.
- `cd ui && npm run test:vitest:api -- tests/api/wiki.test.ts` — 4 tests pass.
- `cd ui && npm run test:vitest:unit` — 916 tests pass (no wiki regressions).

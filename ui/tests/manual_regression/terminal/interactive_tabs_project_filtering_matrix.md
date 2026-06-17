---
id: c107bc99-a521-595d-98f3-4fd5353da021
---

# Interactive tabs / project filtering — regression matrix

Users have reported tab close, restore, and project-filter regressions. This file holds 52 scenarios across 9 areas: refresh & browse, open by id / from history, close-all, project-counter chip, footer selections, restart & CLI, Codex/Claude/terminal mix, navigation in/out of dock, and the kind-agnostic project chip (content tabs count + select-switches-project).

## Selectors

| Element | Selector |
|---|---|
| Tab bar | `[data-testid="terminal-tab-bar"]` |
| Tab strip scroller | `[data-testid="terminal-tabs-scroll-container"]` |
| Single tab | `[data-testid^="tab-shell-"]` (id form: `tab-shell-shell-<uuid>` or `tab-shell-agentic_process-<uuid>`) |
| Close-all button | `[data-testid="close-all-tabs-button"]` |
| Projects chip | `[data-testid="projects-counter-chip"]` |
| Projects popover | `[data-testid="projects-counter-popover"]` |
| Active terminal panel | `[data-testid="terminal-panel"]` |
| All panels container | `[data-testid="terminal-panels"]` |
| Footer | `[data-testid="footer"]` (StatusBar inside) |
| Opener menu rows | `[data-testid="opener-menu-row-terminal"]`, `opener-menu-row-claude`, `opener-menu-row-codex`, `opener-menu-row-claude-resume-by-id`, `opener-menu-row-history` |

## URL pattern

The canonical dock URL is `/agent/<localAgentId>/dock/shell/<targetTypeId>`, where:
- `<localAgentId>` comes from `GET /api/v1/graph/bootstrap` (single-agent app — there is only one local agent).
- `<targetTypeId>` is `shell-<uuid>` for a plain shell or `agentic_process-<uuid>` for a Claude/Codex tab.

When the matrix says "navigate to `/dock/shell/<id>`", that's the short form — accept either short or canonical form in the URL bar.

## Common validation block (apply at the END of every scenario)

After scenario-specific steps, verify ALL FIVE:

1. **Tabs alive** — every tab in the tab bar is clickable; the active tab has a mounted `terminal-panel`. No `CLOSING` zombies. xterm cursor blinks (plain shell) or process status badge shows ready/running (Claude/Codex).
2. **Expected content** — active panel shows only the content this scenario produced. Switching tabs never shows another tab's scrollback.
3. **Counts correct** — `close-all-tabs-button` badge equals visible-tab count for the current project (and the button is hidden when count < 2). `projects-counter-chip` button shows the distinct project count (one per project with ≥1 open tab of ANY kind — terminal AND content); tooltip says `"<N> active project[s] with <M> open tab[s]"` (note the `chip` correctly singularizes per `projectTotal === 1 ? '' : 's'`).
4. **Project + workdir correct** — footer (`[data-testid="footer"]`) shows the active tab's project displayName/workdir; this matches `dataContext.project.id` for the active tab.
5. **URL correct** — URL ends with `/dock/shell/<targetTypeId>`; agent segment if present matches the local agent.

## Setup helpers (REST fixtures — use these instead of UI clicks)

All examples below use shell variables: `API="http://localhost:${LOCAL_SERVER_PORT}"`, `APP="http://localhost:${VITE_PORT}"`. POST bodies are JSON.

```bash
# Reset DB to clean bootstrap state (now self-rehydrates @local — safe to call between tests)
curl -s -X POST "$API/api/v1/graph/compute_node/@local/desktop-db/clear" >/dev/null

# Re-bootstrap to get fresh ids (clear already does this, but call explicitly if you skipped clear)
curl -s "$API/api/v1/graph/bootstrap" | jq -r '.data.user.id, .data.project.id, .data.agent.id'

# Create a project (id is uuid5-derived from the mount path — idempotent across runs)
curl -s -X POST "$API/api/v1/graph/project" -H 'Content-Type: application/json' \
  -d '{"name":"Proj-A","fs_storage_mount_path":"/tmp/regression/proj-a"}' | jq -r '.data.id'

# Create a plain shell bound to a project
curl -s -X POST "$API/api/v1/graph/shell" -H 'Content-Type: application/json' \
  -d '{"project_id":"<project-uuid>"}' | jq -r '.data.id'

# Create an orphan shell (no project_id — appears in every project's strip)
curl -s -X POST "$API/api/v1/graph/shell" -H 'Content-Type: application/json' -d '{}' | jq -r '.data.id'

# Create an AgenticProcess fixture (Claude tab) without waiting on the live SDK.
# IMPORTANT: AgenticProcess defaults to visible=False (agentic_process.py:498); the
# backend's terminals/list filters out non-visible APs (compute_node.py:507), so
# without an explicit visible=true the AP never surfaces in the strip. PATCH it
# immediately after creation:
AP_ID=$(curl -s -X POST "$API/api/v1/graph/agentic_process" -H 'Content-Type: application/json' \
  -d '{"project_id":"<project-uuid>","worker_type":"claude_code"}' | jq -r '.data.id')
curl -s -X PATCH "$API/api/v1/graph/agentic_process/$AP_ID" \
  -H 'Content-Type: application/json' -d '{"visible":true}' >/dev/null
echo "$AP_ID"

# Same, Codex variant — same visible=true follow-up required.
AP_ID=$(curl -s -X POST "$API/api/v1/graph/agentic_process" -H 'Content-Type: application/json' \
  -d '{"project_id":"<project-uuid>","worker_type":"codex"}' | jq -r '.data.id')
curl -s -X PATCH "$API/api/v1/graph/agentic_process/$AP_ID" \
  -H 'Content-Type: application/json' -d '{"visible":true}' >/dev/null
echo "$AP_ID"

# Close a shell (removes from tab strip)
curl -s -X POST "$API/api/v1/graph/shell/<id>/close" >/dev/null

# Restart backend (used in Section F)
pkill -f flow_sdk.server.run; sleep 1
(LOCAL_SERVER_PORT="$LOCAL_SERVER_PORT" nohup uv run -m flow_sdk.server.run >/tmp/flowpad-server.log 2>&1 &)
until curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/graph/bootstrap" | grep -q 200; do sleep 0.5; done
```

## Skip rules

When a test cannot be automated headlessly, mark it `[skip:<reason>]` in the title. The only valid reasons:

- `[skip:platform]` — needs OS file manager / native dialog we cannot inspect.
- `[skip:live-claude]` — needs Claude/Codex to actively *respond* (multi-minute, non-deterministic). Banner-only checks do NOT qualify.
- `[skip:clipboard]` — needs OS clipboard read/write.
- `[skip:harness]` — requires infrastructure the QA harness does not provide: an isolated test backend (so backend restart doesn't disrupt other agents/sessions), two genuinely separate browser sessions (the MCP shared Chrome session can't simulate this safely), or fabrication of files outside the API surface (e.g. writing to `~/.claude/projects/...` to populate disk-based history). Use only after confirming there is no API/REST/`browser_evaluate` path that achieves the test's intent.

Anything else (selector mismatch, missing fixture) is a `test-issue` to fix in the matrix or app, not a skip.

---

## A. Refresh & browse

test 1: Refresh keeps a single shell tab alive
- navigate to `{APP_URL}/dock/shell/new_terminal` (resolves to a fresh shell)
- wait for URL to become `/dock/shell/shell-<uuid>` and `terminal-panel` to mount
- record `targetTypeId` = `shell-<uuid>` from the URL
- hard refresh the browser (Cmd-R / Ctrl-R)
- validate URL still ends with the same `targetTypeId`
- validate `terminal-panel` is mounted and the same single tab is in the strip
- run common validation block

test 2: Refresh with 5 tabs preserves order and selection
- via REST: bootstrap, then create 5 plain shells in the bootstrap project (`for i in 1 2 3 4 5; do curl ... /api/v1/graph/shell -d '{"project_id":"<bootstrap-pid>"}'; done`)
- navigate to `{APP_URL}/dock/shell` and let it resolve to a default tab
- click the 3rd tab in `terminal-tab-bar`
- record the active `targetTypeId`
- hard refresh
- validate 5 tabs visible in the same left-to-right order (compare ids)
- validate the recorded 3rd tab is still active
- run common validation block

test 3: Refresh on Claude tab keeps process bound
- via REST: create an AgenticProcess fixture with `worker_type=claude_code` in the bootstrap project; record its `agentic_process-<uuid>` id
- navigate to `{APP_URL}/dock/shell/agentic_process-<uuid>`
- validate the Claude tab activates (orange ClaudeIcon)
- hard refresh
- validate the same Claude tab is active
- validate process status badge is NOT `starting` indefinitely
- run common validation block

test 4: Refresh on Codex tab keeps process bound
- same as test 3 but with `worker_type=codex`
- validate green CodexIcon and the same `agentic_process-<uuid>` re-binds after refresh
- run common validation block

test 5: Refresh on `/dock/shell` (no pointer) resolves a default tab
- navigate to `{APP_URL}/dock/shell` (no id segment)
- wait up to 5s for URL to be replaced to `/dock/shell/shell-<uuid>` (resolveDefaultTab)
- validate that shell is the active tab and `terminal-panel` is mounted
- hard refresh
- validate URL is still a concrete `/dock/shell/shell-<uuid>` (not the bare path)
- run common validation block

test 6: Sidebar away-and-back keeps tabs alive
- via REST: create 3 plain shells in the bootstrap project
- navigate to `{APP_URL}/dock/shell` and click the 2nd tab
- click the Home button in the sidebar
- validate URL is `{APP_URL}/`
- click the Shell button in the sidebar
- validate the same 3 tabs are visible
- validate the same `targetTypeId` (the 2nd tab) is the active one
- run common validation block

test 7: Refresh after rename preserves rename
- via REST: create 2 plain shells in the bootstrap project
- navigate to `{APP_URL}/dock/shell`, double-click the 2nd tab name, type `build-server`, press Enter
- validate the tab now shows `build-server`
- simulate a PTY-driven title update via the dedicated action that the watcher uses (`POST $API/api/v1/graph/shell/<id>/update-display` with body `{"name":"pty-title-from-pty","is_pty":true}`). NOTE: a generic `PATCH /shell/<id>` body does NOT trigger the `user_renamed` guard — the guard lives only in the `update-display` action's `is_pty=true` branch (`flow_sdk/builtin/shell.py:836-845`). The matrix used to instruct PATCH; that was wrong.
- validate the tab name remains `build-server` (Shell.user_renamed=true honored)
- hard refresh
- validate the tab name is still `build-server`
- run common validation block

## B. Open from history or by id

test 8: Open shell tab by direct URL
- via REST: create 2 plain shells in the bootstrap project
- navigate to `{APP_URL}/dock/shell` and let it resolve to one of them
- copy the URL of the 2nd tab
- click sidebar Home; validate URL is `/`
- paste the copied URL into the address bar and press Enter
- validate the 2nd tab is active in the strip without spawning a new one
- validate `projects-counter-chip` count is unchanged
- run common validation block

test 9: Open process tab by direct URL
- via REST: create an AgenticProcess fixture (`worker_type=claude_code`) in the bootstrap project; record its id and the linked `shell_id`
- navigate to `{APP_URL}/dock/shell/agentic_process-<id>`
- validate the Claude tab activates and the linked shell's `terminal-panel` is mounted
- run common validation block

test 10: Open invalid shell id (graceful fallback)
- navigate to `{APP_URL}/dock/shell/shell-deadbeef-deadbeef-deadbeef-deadbeefdead`
- validate the page does NOT white-screen
- validate UI shows ONE of: explicit error page, default-tab redirect, or empty-state — record which one
- run common validation block (the URL check applies to whatever resolves)

test 11: Open Claude tab via history record [skip:harness]
- (rationale: the History modal at `ui/src/components/terminal/HistoryModal.tsx` is fed by `useWorkerHistory` which calls the backend `worker-history` action on the compute_node — the source is the disk-based session log under `~/.claude/projects/...`, populated only when a real Claude/Codex session has actually run. REST POST to `/api/v1/graph/agentic_process` does NOT enroll a row in this disk log; nothing from the QA harness can fabricate it without writing files outside the API surface. Mark `status:"skip"` with `skip_reason:"harness"` and `skip_challenge_required:true`.)

test 12: Open shell-by-id whose project differs from current
- via REST: create `Proj-A` and `Proj-B`. Create a shell in `Proj-B` and record its id.
- navigate so that current project = `Proj-A` (open `projects-counter-chip` and select it)
- copy the URL `{APP_URL}/dock/shell/shell-<proj-b-shell-id>` and navigate to it
- validate `dataContext.project` auto-switches to `Proj-B` (chip current row, footer label, tab strip)
- validate URL is preserved (the `Proj-B` shell id stays)
- run common validation block

test 13: Re-open closed tab via stale URL
- via REST: create 2 plain shells in the bootstrap project
- navigate to `{APP_URL}/dock/shell`; note the URL of the 2nd tab; click X on the 2nd tab
- validate the 2nd tab is removed from the strip
- paste the noted URL; validate sensible state (default-tab redirect OR explicit "session closed" empty state) and no zombie tab
- validate `projects-counter-chip` count is unaffected
- run common validation block

## C. Close all

test 14: Close-all closes only the current project's tabs
- via REST: create `Proj-A` and `Proj-B`. Create 3 shells in `Proj-A` and 2 in `Proj-B`.
- navigate to `{APP_URL}/dock/shell` and switch via chip to `Proj-A`
- validate `close-all-tabs-button` badge shows 3
- click `close-all-tabs-button`
- validate `Proj-A` strip is now empty
- via chip, switch to `Proj-B`; validate the 2 tabs are intact
- run common validation block

test 15: Close-all badge tracks visible count live
- via REST: create 4 shells in the bootstrap project
- navigate to `{APP_URL}/dock/shell`
- validate `close-all-tabs-button` badge shows 4
- click X on one tab; validate badge shows 3
- click `+` (or `opener-menu-row-terminal`) to spawn one more; validate badge shows 4 again
- run common validation block

test 16: Close-all then refresh — no zombies
- via REST: create 4 shells in the bootstrap project
- navigate to `{APP_URL}/dock/shell`; click `close-all-tabs-button`
- hard refresh; validate either zero tabs (empty-state) OR a single fresh default tab; none of the prior 4 return
- run common validation block

test 17: Close All But This (context menu)
- via REST: create 5 shells in the bootstrap project
- navigate to `{APP_URL}/dock/shell`; right-click the 3rd tab; choose "Close All But This"
- validate only the 3rd tab remains; URL = its id; `close-all-tabs-button` is hidden
- run common validation block

test 18: Close to the Right
- via REST: create 5 shells in the bootstrap project
- navigate to `{APP_URL}/dock/shell`; click the 1st tab to activate it
- right-click the 2nd tab; choose "Close to the Right"
- validate tabs 1 & 2 remain, tabs 3–5 are gone, badge = 2, the 1st tab stays active
- run common validation block

test 19: Close single tab via X — strip self-heals to first by tab_order
- via REST: create 4 shells in the bootstrap project (record their `tab_order` values)
- navigate to `{APP_URL}/dock/shell`; click the 2nd tab; click its X
- validate the 1st tab (lowest `tab_order`, equivalent to `tabs[0]` in `useActiveTerminals.byTabOrder`) becomes active. NOTE: the matrix used to specify "the 3rd tab (right-adjacent)" — that's wrong. The code falls back to `tabs.find(isPickable) === tabs[0]` (`load-shell.ts:138-166` via `useStandardTabNav.ts:34-48`); there is no documented "right-adjacent" or "left-adjacent" intent.
- validate URL updates to the 1st tab's id; badge = 3
- run common validation block

test 20: Close-all button hides at < 2 tabs
- start with exactly 1 shell in the bootstrap project; navigate to `{APP_URL}/dock/shell`
- validate `close-all-tabs-button` is NOT in the DOM (or aria-hidden)
- click `+` to spawn a 2nd; validate it appears with badge 2
- click X on the 2nd; validate it hides again
- run common validation block

## D. Projects count chips selection

test 21: Chip selects project, swaps tab strip + URL
- via REST: create `Proj-A` (2 shells) and `Proj-B` (3 shells)
- navigate to `{APP_URL}/dock/shell` (lands in one of them); click `projects-counter-chip` and select the OTHER one
- validate strip switches; first tab of new project activates; URL points at it; footer/workdir match
- run common validation block

test 22: Chip badge equals distinct project count
- via REST: create 3 projects with shells in each — `A`(2), `B`(1), `C`(4)
- navigate to `{APP_URL}/dock/shell`
- validate badge shows 3; tooltip reads `"3 active projects with 7 terminals"`
- run common validation block

test 23: Selecting current project = no-op
- via REST: ensure the bootstrap project has 1 shell
- navigate to `{APP_URL}/dock/shell`; click chip; click the current project's row (aria-current="true")
- validate URL unchanged, no flicker, no `terminal-panel` re-mount
- run common validation block

test 24: Popover ordering — current first, count desc, alpha tiebreak
- via REST: create `Proj-A`(5), `Proj-B`(3), `Proj-C`(5), `Proj-D`(1); set current = `Proj-B` via chip
- click chip
- validate row order: `Proj-B` (current), `Proj-A`, `Proj-C` (count tie, alpha), `Proj-D`
- validate `Proj-B` row has aria-current="true"
- run common validation block

test 25: Project with zero tabs after close-all
- via REST: create `Proj-A` (3 shells), `Proj-B` (2 shells); set current = `Proj-A`
- click `close-all-tabs-button` (closes A's 3 tabs)
- click chip; record observed: `Proj-A` row gone OR shows 0 (write to result JSON `notes`)
- validate `Proj-B` row still listed with count 2
- validate footer still shows `Proj-A` as current project + workdir
- run common validation block

test 26: Switching project auto-selects first tab by `tab_order`
- via REST: create `Proj-A`(3) and `Proj-B`(2). Note both projects' shell ids in `tab_order` order.
- navigate to `{APP_URL}/dock/shell`; click the 2nd `Proj-A` tab to activate it
- via chip, switch to `Proj-B`
- validate the lowest-`tab_order` `Proj-B` shell is active; URL = its id
- run common validation block

test 27: Every shell carries a real project_id (no orphans by design)
- (rationale: the "orphan tab" concept the matrix originally tested was DELIBERATELY REMOVED on 2026-05-09 as part of "Project consolidation (Path A)" — see `useActiveTerminals.ts:343-347` which explicitly states *"The historical orphan-include rule — || t.projectId == null — is gone; the strict per-project filter below is now safe because no tab's projectId is ever null in normal flows"*. Backend `Shell.save()` at `flow_sdk/builtin/shell.py:256-279` auto-assigns the bootstrap `@local` project to any shell created without an explicit `project_id`. So there is NO null-projectId state to test for orphans — the test is rewritten to validate the consolidated invariant.)
- via REST: create `Proj-A`(1) and `Proj-B`(1).
- via REST: `POST $API/api/v1/graph/shell -d '{}'` (no project_id in body).
- via REST: GET the resulting shell — validate `project_id` is **non-null** (auto-assigned to the bootstrap `@local` project per Shell.save).
- navigate to `{APP_URL}/dock/shell`; via chip, switch to `Proj-A` and validate the empty-body shell does NOT appear (it belongs to bootstrap `@local`, not `Proj-A`).
- via chip, switch to bootstrap `@local`; validate the empty-body shell DOES appear.
- via chip, switch to `Proj-B`; validate the empty-body shell does NOT appear.
- run common validation block

## E. Footer selections

test 28: Footer "Switch Project" modal switches end-to-end
- via REST: create `Proj-B` with 2 shells (mount path `/tmp/regression/proj-b` — note macOS resolves to `/private/tmp/regression/proj-b` via canonical-path normalization, both forms work)
- navigate to `{APP_URL}/dock/shell` (lands in bootstrap project)
- click the "Switch Project" button inside `[data-testid="footer"]` (button title: "Switch project")
- in the modal, click the **"All"** tab/filter (modal defaults to "Today" / "This week" subset views; freshly-created REST projects with no Claude session history are still listed under "Today" via timestamp, but explicitly clicking "All" guarantees the full project list is rendered)
- find and click the `proj-b` row (text matches `proj-b/private/tmp/regression/proj-b`)
- validate footer label updates to `Proj-B` (or its fs_storage_mount_path basename); chip current row = `Proj-B`; tab strip shows `Proj-B`'s 2 tabs; URL is a `Proj-B` tab URL
- run common validation block

test 29: Footer label fallback chain
- (rationale: previous wording assumed `displayName` and `workdir` are persisted fields on Project. They are not. Project's actual schema (`flow_sdk/builtin/project.py:53,59`) exposes `name: str | None` and `fs_storage_mount_path: str | None` — nothing else label-relevant. `displayName` is a TS-only computed getter on `APIEntity` (`ts_sdk/src/APIEntity.ts:149-151`) deriving from `getDisplayName()` (not persisted). `workdir` is a `dataContext` runtime override (`status-bar.tsx:31,40`), not a Project field. The footer's actual fallback is documented in `status-bar.tsx:38-50` — first `dataContext.workdir`, then `project.fs_storage_mount_path`, then computed paths.)
- via REST: ensure the bootstrap project has `name` set. Validate footer label = the computed displayName (typically `project.name`).
- via `browser_evaluate`: `await window.dataContext.setWorkdir('/tmp/regression/override-workdir')`. Validate footer label switches to the explicit workdir path.
- via `browser_evaluate`: `await window.dataContext.setWorkdir(null)`. Validate footer label reverts to the project path (`project.fs_storage_mount_path`).
- via `browser_evaluate`: `await window.dataContext.setContextEntityTypeId('CurrentProjectTypeId', null)`. Validate footer shows the red "Select Project" pill.
- run common validation block

test 30: "Select Project" red pill — tab spawn flow
- land at `{APP_URL}/dock/shell` (loader does not touch `project` for this URL — confirmed in `main-loader.ts:141-149`).
- force `dataContext.project = null` from MCP browser via `browser_evaluate`:
  ```js
  await window.dataContext.setContextEntityTypeId('CurrentProjectTypeId', null);
  ```
  `dataContext` is window-exposed via `defineGlobal` (`ts_sdk/src/FlowSync/context.ts:1058-1060`). The matrix used to say "from devtools" — wrong; no devtools required, plain `browser_evaluate` works. State is not reload-persistent; do not navigate after the call (any navigation re-resolves project context via the loaders).
- validate red "Select Project" pill is visible in `[data-testid="footer"]`
- click `+` in the tab bar; record observed: blocked-with-prompt OR orphan-tab-created. Write result JSON `notes`.
- if orphan tab: validate it appears in every project's view (cross-check test 27)
- run common validation block

test 31: "Open folder" launches at workdir [skip:platform]
- mark `status:"skip"` with `skip_reason:"platform"` and `skip_challenge_required:true`. The OS file manager opens outside the browser; we cannot verify it headlessly.

test 32: Footer repo/branch reflects active project's Git artifact
- (rationale: the matrix originally referenced a `gitRepo` entity. There is NO such graph entity — `flow_sdk/builtin/faas/git_repo.py:69` defines a `class GitRepo` that is a CLI helper, not an APIEntity. The footer at `ui/src/components/footer.tsx:33-61` reads from the project's **artifacts** via `useCurrentArtifacts()` (filtering for `artifact_type === ArtifactType.GIT_REPO`). The correct fixture is an Artifact entity with `artifact_type='GIT_REPO'`.)
- via REST: create `Proj-B` (record `<proj-b-id>`). Create a GIT_REPO artifact scoped to that project:
  ```bash
  curl -X POST "$API/api/v1/graph/artifact" -H 'Content-Type: application/json' \
    -d '{"artifact_type":"GIT_REPO","metadata":{"url":"git@example.com:org/repo.git","branch":"feat/x"},"context_entities":[{"type_id":"project-<proj-b-id>"}]}'
  ```
  (NOTE: artifact-to-project scoping convention may need verification per the codebase — `useCurrentArtifacts` queries `type:'artifact'` with `scope:[projectTypeId]`. If `context_entities` doesn't bind it correctly, try setting a `parent_id` or `project_id` field on the body. Record the working shape in `notes`.)
- with current = bootstrap project, validate footer center shows the bootstrap project's repo/branch (or empty)
- via chip, switch to `Proj-B`
- validate footer center shows the artifact's url + `:feat/x`
- via chip, switch back; validate footer updates
- run common validation block

## F. Restart & CLI changes

> **Important:** F33 and F34 restart the backend. In a CI/dedicated-test backend they would run as full live tests; in a shared dev backend (the typical QA harness) the restart would disrupt the user's CLI session and other agents. Both tests are marked `[skip:harness]` for shared-backend runs. To run them: spin up an isolated backend instance and re-classify these as live tests.

test 33: Backend restart preserves tabs [skip:harness]
- (rationale: Shell hydration via `fetchActiveTerminals` against a restarted backend is the assertion. Restarting `flow_sdk.server.run` on the shared dev backend would terminate every other live agent's WS connection. Mark `status:"skip"` with `skip_reason:"harness"` and `skip_challenge_required:true` for shared-backend runs. Live test only viable in an isolated backend instance.)
- (preserved spec for isolated-backend runs:)
  - via REST: create 4 shells split across 2 projects (`Proj-A`:3, `Proj-B`:1)
  - navigate to `{APP_URL}/dock/shell`; record the 4 `targetTypeId`s and their project assignments
  - run the backend-restart helper from "Setup helpers"
  - hard refresh the browser
  - validate `fetchActiveTerminals` rehydrates the same 4 tabs (same ids, same names, same project assignments, no duplicates)
  - run common validation block

test 34: Backend restart with an AgenticProcess in the strip [skip:harness]
- (rationale: same harness limit as test 33. Mark `status:"skip"` with `skip_reason:"harness"` for shared-backend runs.)
- (preserved spec for isolated-backend runs:)
  - via REST: create an AgenticProcess (`worker_type=claude_code`) in the bootstrap project
  - navigate to `{APP_URL}/dock/shell/agentic_process-<id>`; validate it activates
  - run the backend-restart helper
  - hard refresh
  - validate the Claude tab is rebound (process resolved via `get-by-worker-id`); no duplicate tab; `agentic_process-<id>` is the active tab
  - run common validation block

test 35: External REST POST creates a new shell (CLI-equivalent)
- (rationale: the `flow` CLI has no shell subcommand; the matrix uses REST as the CLI-equivalent operation a developer would run from a terminal)
- via REST: create `Proj-B`
- navigate to `{APP_URL}/dock/shell`
- from a separate process: `curl -X POST $API/api/v1/graph/shell -d '{"project_id":"<proj-b-id>"}'`
- without manual refresh, wait up to 5s
- validate a new tab appears in the strip; chip count for `Proj-B` increments; new tab is owned by `Proj-B`
- run common validation block

test 36: External REST POST creates a Claude AgenticProcess
- via REST: create `Proj-B`
- navigate to `{APP_URL}/dock/shell`
- from a separate process: `curl -X POST $API/api/v1/graph/agentic_process -d '{"project_id":"<proj-b-id>","worker_type":"claude_code"}'`
- without refresh, wait up to 5s
- validate a new Claude tab appears with orange ClaudeIcon; project = `Proj-B`
- run common validation block

test 37: External REST DELETE/close removes a session
- via REST: create 3 shells in the bootstrap project; pick one non-active and one active id
- navigate to `{APP_URL}/dock/shell` (lands on the 1st)
- from a separate process: `curl -X POST $API/api/v1/graph/shell/<non-active-id>/close`
- without refresh, wait up to 5s
- validate the deleted tab is removed; badge decrements
- now close the active shell the same way
- validate active selection self-heals to an adjacent tab; URL updates
- run common validation block

test 38: Two browser windows in sync [skip:harness]
- (rationale: validating cross-window WS sync requires two genuinely independent browser sessions with separate WS connections. The MCP harness shares one Chrome instance / one tab pool — `mcp__debugMcp__browser_tabs` adds a Chrome tab to the SAME session, so creating "window 2" doesn't simulate two clients. Cross-tab tab-index churn after close also disrupts state. Mark `status:"skip"` with `skip_reason:"harness"` and `skip_challenge_required:true`. Live test viable only with two separate Playwright contexts or two real browser windows driven independently — not the current MCP setup. The underlying mechanism (cross-session WS sync) is already validated by tests 35/36/37 which use REST POSTs from outside the browser as the "second client".)

## G. Codex / Claude / terminal mix

test 39: Mixed strip renders correct icons
- via REST: in the bootstrap project create one plain shell, one Claude AgenticProcess, one Codex AgenticProcess (record all 3 ids)
- navigate to `{APP_URL}/dock/shell`
- validate the strip contains 3 tabs with icons: SquareTerminal (plain), ClaudeIcon orange (Claude), CodexIcon green (Codex)
- run common validation block

test 40: Switching between mixed types — no cross-talk
- with the test 39 setup, click each tab in turn
- validate each `terminal-panel` shows only its own scrollback (no leftover content)
- validate inactive xterm canvases stay mounted (no destroy/remount on switch)
- run common validation block

test 41: Spawn each type from `+` / opener menu
- start with empty strip (close all)
- click `+` (CSS selector: `button[aria-label="Open new tab menu"]` — accessibility-ref clicks via `mcp__debugMcp__browser_click` may fail with element-not-stable; use the aria-label CSS selector. Verified working live during the 2026-05-09 RCA cycle.)
- click `[data-testid="opener-menu-row-terminal"]`; validate a plain shell tab appears
- click `+` again, then `[data-testid="opener-menu-row-claude"]`; validate a Claude tab appears
- click `+` again, then `[data-testid="opener-menu-row-codex"]`; validate a Codex tab appears (if absent in this build, mark this sub-step `[skip:platform]` and continue)
- validate all three are assigned to the bootstrap project; chip count increments by 3
- run common validation block

test 42: Close Claude tab — underlying shell behavior
- via REST: create one Claude AgenticProcess in the bootstrap project; note its id and `shell_id`
- navigate to `{APP_URL}/dock/shell/agentic_process-<id>`
- click X on the tab
- record observed (write to result `notes`): underlying Shell closed too OR remained as a plain shell tab
- validate badge reflects whatever path is taken; no orphan zombie panels in `terminal-panels`
- run common validation block

test 43: Rename Claude tab survives switch + refresh + PTY title
- via REST: create one Claude AgenticProcess (set `visible=true` if needed so the tab surfaces)
- navigate to its tab; double-click the tab name; rename to `claude-fix`; press Enter
- click another tab and back; validate name still `claude-fix`
- hard refresh; validate name still `claude-fix`
- simulate a PTY-driven title update on the underlying Shell: `POST $API/api/v1/graph/shell/<linked-shell-id>/update-display` with body `{"name":"pty-title","is_pty":true}`. Same rationale as test 7 — generic PATCH bypasses the `user_renamed` guard.
- validate tab name remains `claude-fix` (Shell.user_renamed=true honored)
- run common validation block

test 44: Rename rejects TypeId-format strings (real v4 UUID)
- (rationale: the previous example string `shell-abcd1234-ef56-7890-1234-567890abcdef` is NOT a valid RFC4122 v4 UUID — segment 3 must start with `4` and segment 4 must start with `[89ab]`. The guard at `TabbedTerminal.tsx:581` correctly enforces real v4 UUID shape: `^[a-z][a-z0-9-]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`. Use a valid v4 UUID to actually exercise the guard.)
- with any tab open (spawn via `+` button using `button[aria-label="Open new tab menu"]` → `[data-testid="opener-menu-row-terminal"]` if needed — see test 41), double-click the tab name
- type a string matching the real TypeId v4 format: `shell-abcd1234-ef56-4789-9abc-567890abcdef` (segment 3 starts with `4`, segment 4 starts with `9` — a real v4 UUID)
- press Enter
- validate the input is rejected/sanitized — tab still shows its previous name (the guard early-returns on match, suppressing the rename)
- (note: the backend `update_display` action has NO equivalent guard — `flow_sdk/builtin/shell.py:847-897` writes `name` raw. Defense-in-depth gap; out of scope for this test but worth flagging for future hardening.)
- run common validation block

## H. Navigation back/forward in/out of dock

test 45: Sidebar Home → Shell → Home preserves dock state
- via REST: create 3 shells in the bootstrap project
- navigate to `{APP_URL}/dock/shell`; click the 2nd tab
- click sidebar Home, then sidebar Shell — validate same 3 tabs, 2nd active
- repeat once more — validate state preserved a second time
- run common validation block

test 46: Browser back/forward across tab clicks
- via REST: create 3 shells (note the 3 ids in tab_order)
- navigate to `{APP_URL}/dock/shell`; click tab A, then B, then C in sequence
- press browser Back twice
- validate URL and active tab roll back: C → B → A; each panel mounts on activate
- press browser Forward twice — validate sequence A → B → C
- run common validation block

test 47: Browser back/forward across `/dock/shell/<id>` and `/`
- (rationale: previous wording said "Home, then Forward" expecting Forward to restore the dock URL — that's structurally invalid: Forward only does anything if you've pressed Back at least once. A push from `/dock/shell/<id>` to `/` adds a BACK entry, not a forward entry. Verified live via `history.pushState`+`history.back()`+`history.forward()`. Test rewritten to exercise the actual Back+Forward round-trip.)
- via REST: create 2 shells; click the 2nd tab; record its `targetTypeId`
- navigate sidebar Home (URL becomes `/` — sidebar uses `navigate('/')`, a PUSH per `collapsed-sidebar.tsx:77`)
- press browser BACK
- validate URL returns to `/dock/shell/<recorded-id>`; the 2nd tab is active; `terminal-panel` mounted
- press browser FORWARD
- validate URL is `/`
- press browser BACK again
- validate URL is `/dock/shell/<recorded-id>` again (round-trip stable)
- validate `close-all-tabs-button` badge = 2 throughout
- run common validation block

test 48: Wrong agentId in URL falls back gracefully
- (rationale: this app has only ONE local agent — multi-agent isolation is not a real surface; this rephrases the original test 48 to exercise the agent segment)
- record local `<agentId>` from `GET /api/v1/graph/bootstrap`
- via REST: create 2 shells
- navigate to `{APP_URL}/agent/00000000-0000-0000-0000-000000000000/dock/shell` (wrong agentId)
- record observed: redirect to local agent's dock OR error page OR empty-state. Write to result `notes`.
- run common validation block (with whatever resolves)

test 49: Process-pointer dock URL activates the AP tab
- (rationale: the matrix originally specified `/agent/<agentId>/flow/<processId>/dock/shell` and expected per-process strip filtering. The router does define that nested path under `agent/:agentId` (`router.tsx:90,92`), but there is no per-process strip filter in code — `useActiveTerminals` and `useProjectTerminals` filter by project, not by process. Test rewritten to validate the actually-implemented surface: the canonical `/dock/shell/agentic_process-<id>` URL form activates the corresponding AP tab.)
- via REST: create one Claude AgenticProcess in the bootstrap project; record its id (`agentic_process-<uuid>`) and `shell_id`
- navigate to `{APP_URL}/dock/shell/agentic_process-<id>`
- validate the AP tab activates (orange ClaudeIcon)
- validate `terminal-panel` mounts for the linked shell
- validate URL stays at `/dock/shell/agentic_process-<id>` (not bare /dock/shell — B1 coverage)
- click sidebar Home; URL becomes `/`
- press browser Forward (or click sidebar Shell, then click the AP tab) — validate the AP tab reactivates
- run common validation block
- (NOTE: do NOT validate "strip filtered to that process's shells only" — that's not an implemented behavior. If/when per-process filtering is added, restore that assertion.)

test 50: Deep link `/dock/shell/new_terminal` redirects to a real shell
- navigate to `{APP_URL}/dock/shell/new_terminal`
- validate URL is REPLACED (not pushed) to `/dock/shell/shell-<uuid>`
- validate that shell is active and `terminal-panel` is mounted
- press browser Back; validate Back goes to whatever was before the deep link, NOT to `/dock/shell/new_terminal`
- run common validation block

## I. Project chip is kind-agnostic (content tabs count; select switches project)

The chip lists one row per project that owns ≥1 open tab of ANY kind, and
selecting a row is a current-project context switch (footer parity), NOT a
navigate-to-first-terminal-tab. These two scenarios guard the fix for "the chip
showed the wrong number of projects": a project whose only open tab is content
(markdown/skill/doc) used to be dropped because the chip bucketed terminal tabs
only. A content `Tab` is seeded directly via REST (`POST $API/api/v1/graph/tab`
with `target_type: 'markdown'`, a real `project_id`, and `visible: true`) — the
chip's source is the `visible=true` Tab query, target-type-agnostic.

test 51: Chip counts a project whose ONLY open tab is a content (markdown) tab
- via REST: create `Proj-A` (2 shells). Create `Proj-C` (NO shells).
- via REST: `POST $API/api/v1/graph/tab` `{pointer, target_type: 'markdown', target_id: <uuid>, project_id: Proj-C, visible: true}`
- navigate to `{APP_URL}/dock/shell` (lands in `Proj-A`); click `projects-counter-chip`
- validate the chip count is **2** (both `Proj-A` and `Proj-C` listed) — `Proj-C` appears even though it has zero terminal tabs and is NOT in the terminal strip
- validate the `Proj-C` row badge shows `1` (its single content tab)
- run common validation block (on `Proj-A`)

test 52: Selecting a content-only project switches the current project (footer parity)
- same setup as test 51 (`Proj-A` with 2 shells, `Proj-C` with 1 content tab)
- navigate to `{APP_URL}/dock/shell` (lands in `Proj-A`); click `projects-counter-chip`; click the `Proj-C` row
- validate the footer (`[data-testid="footer"]`) updates to `Proj-C` — the current project switched even though `Proj-C` has no terminal tab to navigate to (the OLD navigate-to-first-tab chip could NOT switch to such a project)
- validate the terminal strip is now empty (0 `tab-shell-*` — `Proj-C` owns no terminal tab)
- (NOTE: no `commonValidation` here — it asserts a mounted terminal panel + concrete shell URL, which a content-only project intentionally does not have)

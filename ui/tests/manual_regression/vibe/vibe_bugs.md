---
id: 16974625-5bb5-4e42-b8cf-2f88f01f3f5a
---

# Vibe Workspace Bugs

Browser QA date: 2026-07-10

Matrix: `vibe_workspace_matrix.md`

Only independently reproduced product failures belong here. Environment failures, Claude quota/auth failures, and harness/test mistakes are recorded in the cycle results, not as Vibe bugs.

Evidence-path convention: when one bullet gives a complete attempt-directory path followed by bare filenames, every trailing filename is a sibling in that exact directory. This keeps the log readable without making any artifact location ambiguous.

## Confirmed Bugs

### VIBE-001 - `Open existing file` bypasses the Vibe Display target and leaves Display empty

- Severity: High
- Matrix scenario: VW-02
- Reproduction: 2/2 clean runs (attempts 2 and 3)
- Worker: Claude Code, headless chat, embedded `vibe` agent
- Instance: cycle-owned `vibe-12`, reset before each attempt

#### User impact

The file is temporarily visible in the right-hand workspace as a child tab, but it was not opened as the Vibe Display's shown target. Returning to the fixed Display loses the file and shows the empty starter state. Display history and reload restoration therefore have no record of what Claude claimed it opened.

#### Preconditions

1. Create a fresh project with a real temporary workdir outside the Vite source tree.
2. Add `docs/open-me.md` containing the unique marker `VW02_MARKDOWN_READY`.
3. Reset the owned instance with:

   ```bash
   uv run flow instance reset vibe-12 --backend-only --keep-keychain --json
   ```

4. Require reset `ready: true`, successful bootstrap with `data.types`, and the exact project id/workdir in `window.dataContext.project`.
5. Use a new DebugMCP tab, clear origin local/session storage, IndexedDB, and CacheStorage, then enter Vibe through the visible view-mode control.

#### Full reproduction

1. From the selected project, open Vibe Home.
2. Submit exactly:

   ```text
   Open the existing file docs/open-me.md in the active display. Do not modify it.
   ```

3. Wait until Claude finishes and the Markdown marker is visible.
4. Observe that the browser URL is `/dock/assets/editor/markdown/...`, representing a workspace child tab.
5. Click the fixed `Display` control (`data-testid="workspace-display-tab"`).
6. Inspect the process entity and transcript.

#### Expected

- Claude uses the Vibe presentation contract: `flow show file <path>` or `flow show entity <typeid>`.
- The process Display remains the active target and renders `VW02_MARKDOWN_READY`.
- `context_data.last_shown` and `context_data.display_stack` contain the file target.
- Returning to Display, hard reload, and Display history restore the same target.

#### Actual

- Claude selected a navigation-oriented system skill and ran `flow navigate entity ...`.
- The file opened as a child asset tab and changed the route away from the process Display.
- The process `context_data` contained only `env_vars` and `max_thinking_tokens`; it had no `last_shown` or `display_stack`.
- Clicking Display produced `Nothing to display yet - try one to get started`.
- Attempt 2 repeated the failure for source code with `flow navigate file ...`.

#### Independent reproduction evidence

Attempt 2:

- Reset/bootstrap/project proof: `../_results/2026-07-10T21-00-21Z/evidence/VW-02/attempt-2/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`
- Real transcript: `../_results/2026-07-10T21-00-21Z/evidence/VW-02/attempt-2/transcript-final.json`
- Process/console: `../_results/2026-07-10T21-00-21Z/evidence/VW-02/attempt-2/process-final.json`, `console.txt`
- Source visible as child: `../_results/2026-07-10T21-00-21Z/evidence/VW-02/attempt-2/source.png`
- Empty fixed Display: `../_results/2026-07-10T21-00-21Z/evidence/VW-02/attempt-2/display-empty.png`

Attempt 3:

- Reset/bootstrap/project proof: `../_results/2026-07-10T21-00-21Z/evidence/VW-02/attempt-3/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`
- Real transcript: `../_results/2026-07-10T21-00-21Z/evidence/VW-02/attempt-3/transcript-final.json`
- Process/console: `../_results/2026-07-10T21-00-21Z/evidence/VW-02/attempt-3/process-final.json`, `console.txt`
- Reproduced empty Display: `../_results/2026-07-10T21-00-21Z/evidence/VW-02/attempt-3/display-empty.png`

#### Technical boundary observed

The embedded Vibe agent requires `flow show` and forbids `flow navigate` for presentation (`flow_sdk/system_projects/flowpad_assistant/.claude/agents/vibe.md`). The general navigation skills selected by Claude apply the opposite rule to an existing file request and direct Claude to `flow navigate`. This is a real instruction/routing conflict in the live Claude session, not a mocked failure or a missing fixture.

### VIBE-002 - Existing HTML is opened as raw source outside the Vibe Display

- Severity: High
- Matrix scenarios: VW-03 and VW-07
- Reproduction: 2/2 matching raw-child runs (VW-03 attempt 3 and VW-07 attempt 1)
- Worker: Claude Code, headless chat, embedded `vibe` agent
- Instance: cycle-owned `vibe-12`, reset before each run

#### User impact

Claude reports that the HTML is shown, but the browser opens its source in a child Markdown/code editor instead of rendering the page. The real page controls never exist in the rendered DOM, the process records no shown target, and returning to the fixed Display yields its empty starter state.

#### Preconditions

1. Create a fresh project outside the Vite source tree with `public/open-me.html`.
2. Include visible marker `VW03_HTML_READY`, button `#activate`, and JavaScript that changes the marker to `VW03_HTML_CLICKED`.
3. Reset `vibe-12`, require `ready: true` and bootstrap `data.types`, then create/select the exact temp project.
4. Use a fresh cleared DebugMCP tab and enter Vibe through the visible mode/Home controls.

#### Full reproduction

Run either matching route after the clean setup:

1. VW-03 direct request:

   ```text
   Open the existing file public/open-me.html in the active display. Do not start a server and do not modify it.
   ```

2. Or the VW-07 completed follow-up after opening Markdown:

   ```text
   Now open the existing file public/open-me.html in the active display. Do not start a server and do not modify it.
   ```

3. Wait for idle, inspect the active route/content, look for `#activate` and an HTML preview iframe, then click the fixed Display control.
4. Inspect the process `context_data` and full transcript.

#### Expected

- The `.html` target uses Vibe's `HtmlPreview` in the active Display.
- `VW03_HTML_READY` renders as the page heading, not source text.
- Clicking `#activate` changes the page to `VW03_HTML_CLICKED`.
- `last_shown` and `display_stack` persist the HTML target.

#### Actual

In both matching runs:

- Claude selected general navigation instructions and used `flow navigate`, not `flow show`;
- the route changed to a child asset editor containing raw HTML source;
- browser inspection found no interactive `#activate` element and no live HTML preview;
- the process recorded no `last_shown` or `display_stack`; and
- clicking fixed Display returned to `Nothing to display yet`.

VW-03 attempt 3 indexed the HTML as Markdown and used `flow navigate entity markdown-...`. VW-07 used `flow navigate file` and opened a raw code/VFS child. Those are two variants of the same boundary signature: navigation to raw source outside Display, with no persisted presentation target.

#### Independent reproduction evidence

VW-03 attempt 3:

- Reset/bootstrap/project: `../_results/2026-07-10T21-00-21Z/evidence/VW-03/attempt-3/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`
- Process/transcript: `../_results/2026-07-10T21-00-21Z/evidence/VW-03/attempt-3/process-final.json`, `transcript-final.json`
- Raw source child: `../_results/2026-07-10T21-00-21Z/evidence/VW-03/attempt-3/raw-html-child.md`

VW-07 attempt 1:

- Reset/bootstrap/project: `../_results/2026-07-10T21-00-21Z/evidence/VW-07/attempt-1/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`
- Process/transcript/tabs: `../_results/2026-07-10T21-00-21Z/evidence/VW-07/attempt-1/process-final.json`, `transcript-final.json`, `tabs.json`
- Empty final Display: `../_results/2026-07-10T21-00-21Z/evidence/VW-07/attempt-1/final-empty-display.md`, `final-browser.json`

#### Related unconfirmed finding

VW-03 attempt 1 followed a different mechanism: relative `flow show file public/open-me.html` resolved against the repo root, produced an `HtmlPreview` 404, and reload returned to empty Display. That valid failure has only one exact occurrence and is not counted in VIBE-002's confirmation total. Evidence: `../_results/2026-07-10T21-00-21Z/evidence/VW-03/attempt-1/reset.json`, `bootstrap.json`, `project.json`, `process-final.json`, `transcript-final.json`, `shown-html.png`, `console-errors.txt`, and `after-reload-empty.png`.

VW-03 attempt 2 has no verdict because a concurrent live-backend module edit caused process creation to fail before Claude started.

#### Technical boundary observed

The embedded Vibe agent requires `flow show` for presentation, while the selected global navigation instructions direct Claude to `flow navigate`. For HTML, that conflict turns an interactive page request into raw-source navigation and bypasses Display persistence entirely.

### VIBE-003 - Skill creation uses a stale default project instead of the selected Vibe project

- Severity: Critical
- Matrix scenario: VW-08
- Reproduction: 2/2 clean runs
- Worker: Claude Code, headless chat, embedded `vibe` agent
- Instance: cycle-owned `vibe-12`, reset before each attempt

#### User impact

Creating a project skill from Vibe can write into a different real project on disk while Claude claims it used the selected project. The requested temp project remains empty, the indexed skill belongs to the wrong project, and the active Display either remains empty or tries to open the wrong project's skill. This is a cross-project write/isolation failure, not only a presentation defect.

#### Preconditions

1. Reset `vibe-12` with `--backend-only --keep-keychain --json` and require `ready: true`.
2. Create a new empty project mounted under a unique `/tmp/flowpad-vibe-vw08-*` directory.
3. In a fresh cleared DebugMCP tab, select that exact project and verify `window.dataContext.project.id` and `fs_storage_mount_path`.
4. Enter Vibe through the visible mode and Home controls.

#### Full reproduction

1. Submit exactly:

   ```text
   Create a project skill named vibe-qa-greeter. It must write the exact text VIBE_GREETER_RAN to output/greeting.txt when run. Open the skill when ready.
   ```

2. Wait for the real process API to report `busy: false` and `ready_for_input: true`.
3. Inspect the selected project tree, the process entity, the full transcript, and the indexed skill entity.
4. Inspect the active Display, then hard reload the process URL.
5. Repeat all steps after another backend reset with a different empty project and new browser tab.

#### Expected

- `flow context list` resolves the selected project id/path and current process.
- Claude creates `/tmp/flowpad-vibe-vw08-*/.claude/skills/vibe-qa-greeter/SKILL.md`.
- The indexed skill belongs to that temporary project.
- `flow show entity` opens a nonblank project-local skill editor.
- Hard reload restores the same project-local skill target.

#### Actual

In both independent attempts:

- the browser and process entities had the correct new project id and `/private/tmp/flowpad-vibe-vw08-*` workdir;
- the system skill ran `flow context list`, which instead returned `CurrentProjectTypeId: project-@local`, `CurrentProcessTypeId: null`, `CurrentPathname: /`, and `CurrentProjectPath: /Users/shlom/Flowpad workspace/my_first_project`;
- Claude used that stale path and indexed `vibe-qa-greeter` as project `c82a1115-2f20-52e0-aa2a-4658898b5873`;
- the selected temporary project remained empty; and
- reload restored an empty Display.

Attempt 1 used `flow navigate entity` and never populated Display state. Attempt 2 used `flow show entity`, but the wrong-project skill entity's file-valued `asset_ref` caused the editor to request `.../SKILL.md/SKILL.md` and return 404. VW-12 independently reproduced that editor failure; it is recorded separately as VIBE-007.

#### Independent reproduction evidence

Attempt 1:

- Reset/bootstrap/project: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-1/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`
- Exact process and transcript: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-1/process-final.json`, `transcript-final.json`
- Wrong-project entity and bytes: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-1/skill-entity.json`, `wrong-path-SKILL.md`
- Empty selected project and Display: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-1/selected-project-tree.txt`, `after-reload-empty.md`

Attempt 2:

- Reset/bootstrap/project: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-2/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`
- Exact process and transcript: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-2/process-final.json`, `transcript-final.json`
- Repeated wrong-project entity/path: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-2/skill-entity.json`, `selected-project-tree.txt`, `wrong-path-SKILL.md`
- Wrong target and reload failure: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-2/wrong-skill-missing.md`, `console.txt`, `after-reload-empty.md`

#### Technical boundary observed

The AgenticProcess launch correctly records the selected `project_id` and `workdir`; the mismatch begins when the `flowpad-assistance` records workflow treats unscoped `flow context list` as authoritative. That command returns a different default connection/project and no current process, so subsequent filesystem writes and indexing cross the selected-project boundary. The real transcript contains the exact context response and absolute wrong-path commands; no mocks or synthetic failure injection are involved.

#### Additional recurrence

VW-09 reproduced the same boundary with a different skill name and three-file bundle. Opening the first support file also changed `window.dataContext.project` from the selected temp project to `my_first_project`; clicking the fixed Display returned the URL/project but left the wrong-project support file rendered.

### VIBE-004 - Distinct skill folders collide on one TypeId and overwrite skill identity

- Severity: High
- Matrix scenarios: VW-09, VW-11, and VW-12; VW-08 establishes the baseline entity
- Reproduction: 3 overwrite events after independent backend resets (VW-09, VW-11, VW-12)
- Worker: Claude Code, headless chat, embedded `vibe` agent
- Instance: cycle-owned `vibe-12`

#### User impact

Creating a second skill can replace the first skill's indexed identity even though both skill folders and `SKILL.md` files remain on disk. Search, Display history, and later skill invocation can therefore resolve the wrong skill or make the earlier skill disappear.

#### Preconditions

Use the normal isolated setup: reset before each scenario, create a fresh selected project, and prove the browser/process project binding. VW-08 first creates the baseline `vibe-qa-greeter` entity. VIBE-003 leaves that real folder/entity in the default project, so later clean browser/process runs expose the persisted cross-session collision that users would encounter.

#### Full reproduction

1. Through VW-08, create `vibe-qa-greeter`, index it as a skill, and capture its TypeId and `asset_ref`.
2. Reset the backend, use a new project/tab, and through VW-09 create the distinct `vibe-qa-bundle` folder with `SKILL.md`, `references/checklist.md`, and `assets/template.md`.
3. Capture the bundle TypeId, fetch that entity, and verify both folders still exist with different file hashes.
4. Reset again and through VW-11 create/index `vibe-qa-persist`; fetch its returned entity.
5. Reset again and through VW-12 create/index `vibe-qa-queue` in a different temporary project; fetch its returned entity.
6. Compare every returned id and `asset_ref`.

#### Expected

- Each skill folder has a unique, stable TypeId.
- Indexing `vibe-qa-bundle` does not change the `vibe-qa-greeter` entity.
- The skill list contains both entities with their respective asset roots.

#### Actual

- `vibe-qa-greeter` initially indexed as `skill-1951da4d-cdef-5ad1-9f69-ebfb0287d7bd` with an `asset_ref` ending in `vibe-qa-greeter/SKILL.md`.
- VW-09 returned that exact TypeId for `vibe-qa-bundle`; fetching it then returned `vibe-qa-bundle/SKILL.md`, while both different folders remained on disk.
- After another reset, VW-11 returned the same TypeId with `vibe-qa-persist/SKILL.md`, replacing the bundle identity.
- After another reset and in a different project, VW-12 returned the same TypeId with `vibe-qa-queue/SKILL.md`, replacing the persisted identity again.
- The changing `asset_ref` on one global id proves three actual overwrite events, not merely a baseline plus one collision.

#### Evidence

- Per-run reset/bootstrap/project proof: `../_results/2026-07-10T21-00-21Z/evidence/VW-09/attempt-1/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`; `../_results/2026-07-10T21-00-21Z/evidence/VW-11/attempt-1/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`; `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-1/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`
- Before/after entity comparison: `../_results/2026-07-10T21-00-21Z/evidence/VW-09/attempt-1/skill-id-collision.json`
- Both folder/file hashes: `../_results/2026-07-10T21-00-21Z/evidence/VW-09/attempt-1/wrong-project-skill-files.txt`
- Final entity, skill list, browser, and console: `../_results/2026-07-10T21-00-21Z/evidence/VW-09/attempt-1/skill-entity-after-bundle.json`, `skills.json`, `final-browser.json`, `console.txt`
- VW-08 pre-collision entity: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-2/skill-entity.json`
- VW-11 reset, replacement entity, files, and transcript: `../_results/2026-07-10T21-00-21Z/evidence/VW-11/attempt-1/reset.json`, `skill-entity.json`, `wrong-path-skill-files.txt`, `transcript-p0-after-create.json`
- VW-12 reset, cross-project replacement entity, and transcript: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-1/reset.json`, `skill-entity.json`, `transcript-before-queue.json`
- Initial creation/index transcripts: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-2/transcript-final.json`, `../_results/2026-07-10T21-00-21Z/evidence/VW-09/attempt-1/transcript-final.json`

#### Technical boundary observed

All four CLI indexing calls succeeded and returned the same deterministic UUID for different `SKILL.md` paths. The failure is observable in captured live entity responses across three reset boundaries, including one different project id; it is not inferred from assistant prose. VW-12's file-valued asset reference also independently reproduced VIBE-007.

### VIBE-005 - Multi-entry headless Prompt Queue drains only the first entry

- Severity: High
- Matrix scenario: VW-12
- Reproduction: 2/2 clean runs
- Worker: Claude Code, same process across Vibe and Advanced modes
- Instance: cycle-owned `vibe-12`, reset before each attempt

#### User impact

A user can queue multiple ordered follow-ups and see all entries accepted, but only the first executes. The process then reports idle and ready while later prompts remain stranded indefinitely. In the tested create/open/run flow this means the skill never runs and the requested report never opens.

#### Preconditions

1. Reset `vibe-12`, create a fresh empty project, and enter Vibe in a cleared tab.
2. Create `vibe-qa-queue`; its run writes `output/vw12-report.md` with `VW12_QUEUE_COMPLETE`.
3. In the confirmation run, explicitly say `Do not run it yet` and prove the report is absent.
4. Use the visible `Advanced` mode control on the same process, open the list-ordered `Queue` ribbon control, and verify the `Prompt Queue` panel.

#### Full reproduction

1. Turn queue draining off with the visible switch.
2. Add these three entries through the UI in this exact order:

   ```text
   Open the skill you just created.
   Run it once.
   Open the generated report.
   ```

3. Verify the panel and process API contain all three entries in order with unique ids and `source: ui`.
4. Turn draining on.
5. Wait until the process should be idle after all turns; inspect the process queue and full transcript.
6. Repeat after a clean reset/new project/new tab.

#### Expected

- All three entries dequeue and become user turns exactly once, in order.
- The middle turn invokes the skill once and creates one report.
- The final turn opens the report, the queue becomes empty, and Vibe reload restores the report target.

#### Actual

In both attempts:

- all three entries were accepted and persisted in the correct order;
- enabling the queue immediately dequeued only `Open the skill you just created.`;
- that turn also navigated the browser from the process terminal to a child skill/Markdown route, but navigation is only correlated and is not established as the cause;
- the process completed the turn and reported `busy: false`, `ready_for_input: true`, and `worker_status: complete`; and
- `Run it once.` plus `Open the generated report.` remained in the enabled queue.

Attempt 1 retained the two entries for the full 360-second bound. Attempt 2 retained them for 90 seconds; its transcript contained only the first queued user turn and its report remained absent. No queue API was called to stage or advance the prompts.

#### Independent reproduction evidence

Attempt 1:

- Reset/bootstrap/project/console: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-1/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`, `console-advanced.txt`
- Ordered staged queue: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-1/process-queue-disabled.json`
- Stalled idle process: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-1/process-drain-timeout.json`, `process-final.json`
- Only first queued turn: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-1/queued-user-turns.json`, `transcript-final.json`
- Browser state: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-1/queue-stuck.md`

Attempt 2:

- Reset/bootstrap/project/console: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-2/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`, `console.txt`
- Clean creation/report precondition: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-2/report-after-create.txt`, `report-before-drain.txt`
- Ordered staged queue: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-2/process-queue-disabled.json`
- Stalled idle process: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-2/process-drain-timeout.json`, `process-final.json`
- Only first queued turn/no report: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-2/queued-user-turns.json`, `report-after-timeout.txt`, `transcript-final.json`
- Child-route browser state: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-2/first-turn-child-queue-stuck.md`

#### Technical boundary observed

The queue accepted all three writes before draining and preserved their order, so this is not the suspected concurrent enqueue overwrite race. One drain call pops the first entry and calls headless `prompt()`, which returns after scheduling the turn rather than after completion. The chained drain is therefore attempted while the first turn is still in flight and cannot pop the next entry; after the turn completes, no later pop/injection occurs in these runs. The artifacts do not include the queue scheduler log, so they do not claim whether a later drain task was scheduled internally. Existing integration coverage exercises a queue of one and cannot catch this multi-entry chain failure.

### VIBE-006 - `New` creates P1 but leaves the Vibe URL/Display bound to P0

- Severity: High
- Matrix scenario: VW-11
- Reproduction: 2/2 clean runs, including an isolated no-file confirmation
- Worker: Claude Code, headless Vibe chat
- Instance: cycle-owned `vibe-12`, reset before each attempt

#### User impact

The user can click `New` and converse with a real new process, but the workspace URL and Display still identify the old process. Reload silently replaces the new chat with the old transcript. The new process also lacks the embedded Vibe agent attachment, so its behavior can differ from the Vibe session the UI claims to provide.

#### Preconditions

1. Reset `vibe-12`, create/select a fresh project, and enter Vibe in a cleared tab.
2. Create P0 with a simple deterministic prompt and wait for idle.
3. Hard reload and verify the P0 response is restored.

#### Full reproduction

1. Click the visible `New` control (`data-testid="entity-execution-new"`).
2. Submit a deterministic P1 prompt from the cleared panel.
3. Query the project processes and prove a second process id exists with the same project/workdir.
4. Verify the panel shows the P1 prompt/response while reading the browser URL.
5. Compare P0 and P1 `embedded_asset_refs`.
6. Hard reload the unchanged URL and inspect which transcript is rendered.
7. Repeat after a reset/new project/new tab.

#### Expected

- The Vibe workspace rebinds to P1 and the canonical URL contains P1's id.
- P1 receives the same embedded Vibe agent attachment as P0.
- The URL-derived Vibe host Display and the panel-local chat both bind to P1.
- Reload preserves the P1 transcript.

#### Actual

In both runs:

- `New` created a distinct P1 with the correct selected project and workdir;
- the chat panel immediately rendered and completed P1;
- the browser URL remained `/dock/display/agentic_process-<P0>?viewMode=vibe`;
- P0 contained `agent-b37c406b-d36d-42a8-92e6-327e84342cbb` in `embedded_asset_refs`, while P1 had an empty list; and
- hard reload followed P0's URL and replaced P1's visible transcript with P0.

The first run used the full persistence scenario and was also affected by VIBE-003. The second run isolated this defect with no files or skills: P0 replied `VW11_P0_READY`, P1 replied `VW11_P1_READY`, the pre-reload browser showed only P1 under a P0 URL, and reload showed only P0.

#### Independent reproduction evidence

Attempt 1:

- Reset/bootstrap/project/console: `../_results/2026-07-10T21-00-21Z/evidence/VW-11/attempt-1/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`, `console-before-reload.txt`, `console-after-reload.txt`
- Process pair: `../_results/2026-07-10T21-00-21Z/evidence/VW-11/attempt-1/project-process-summary.json`
- P1 transcript and entity: `../_results/2026-07-10T21-00-21Z/evidence/VW-11/attempt-1/transcript-p1-final.json`, `process-p1-final.json`
- P1 panel under P0 URL: `../_results/2026-07-10T21-00-21Z/evidence/VW-11/attempt-1/p1-chat-p0-url.md`, `before-reload.json`
- Reload restored P0: `../_results/2026-07-10T21-00-21Z/evidence/VW-11/attempt-1/after-reload-p0.md`

Attempt 2:

- Reset/project/console proof: `../_results/2026-07-10T21-00-21Z/evidence/VW-11/attempt-2/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`, `console.txt`
- P0/P1 API comparison: `../_results/2026-07-10T21-00-21Z/evidence/VW-11/attempt-2/process-summary.json`, `process-p0.json`, `process-p1.json`
- Independent transcripts: `../_results/2026-07-10T21-00-21Z/evidence/VW-11/attempt-2/transcript-p0.json`, `transcript-p1.json`
- P1 panel under P0 URL: `../_results/2026-07-10T21-00-21Z/evidence/VW-11/attempt-2/p1-chat-p0-url.md`, `before-reload.json`
- Reload restored P0: `../_results/2026-07-10T21-00-21Z/evidence/VW-11/attempt-2/after-reload-p0.md`

#### Technical boundary observed

P1 is real and independently retrievable; its transcript proves the new prompt completed. The `EntityExecutionPanel` locally renders P1, while the URL-derived Vibe host Display/focus state remains bound to P0. Generic `New` also enables Flowpad Assistant but does not embed the Vibe persona. The defect is therefore workspace rebinding/attachment parity after local `New`, not process creation or model execution.

### VIBE-007 - Skill editor double-appends `SKILL.md` for records-workflow skill entities

- Severity: High
- Matrix scenarios: VW-08 and VW-12
- Reproduction: 2/2 clean runs with different skill paths/projects
- Worker: Claude Code, headless Vibe chat
- Instance: cycle-owned `vibe-12`, reset before each run

#### User impact

Claude can successfully create and index a valid skill, then the active Skill editor reports that the file is missing. The editor requests a nonexistent `SKILL.md/SKILL.md` path, so users cannot inspect or edit the created skill even though the real file exists.

#### Preconditions

1. Reset/select a fresh project and enter Vibe.
2. Create a skill through the `flowpad-assistance` records workflow.
3. Let that workflow index the main file directly with `flow record index <absolute-SKILL.md> --types skill`.
4. Open/show the returned skill TypeId.

#### Full reproduction

1. Inspect the indexed skill entity and verify its `asset_ref` ends in `/SKILL.md` rather than the folder root.
2. Open the skill through the browser flow.
3. Inspect the Skill editor's displayed path and browser console/network errors.
4. Repeat with another skill under a different project/path after a clean reset.

#### Expected

- A folder-backed skill entity points at the skill root, or the editor recognizes a main-file `asset_ref`.
- The editor downloads the real path exactly once and renders the skill.

#### Actual

In both independent runs:

- the real `SKILL.md` existed and was successfully indexed;
- the returned skill entity's `asset_ref` already ended in `/SKILL.md`;
- the Skill editor appended its own `/SKILL.md` segment;
- the UI rendered `Note: File is missing`; and
- the browser logged download 404s for the double-appended path.

VW-08 requested `/Users/shlom/Flowpad workspace/my_first_project/.claude/skills/vibe-qa-greeter/SKILL.md/SKILL.md`. VW-12 requested `/private/tmp/flowpad-vibe-vw12-a1.../.claude/skills/vibe-qa-queue/SKILL.md/SKILL.md`, proving the failure is not dependent on the wrong-project path from VIBE-003.

#### Independent reproduction evidence

VW-08 attempt 2:

- Reset/bootstrap/project/filesystem: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-2/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`, `selected-project-tree.txt`, `wrong-path-SKILL.md`
- Skill entity: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-2/skill-entity.json`
- Missing editor state: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-2/wrong-skill-missing.md`
- Four 404s: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-2/console.txt`
- Creation/index/show transcript: `../_results/2026-07-10T21-00-21Z/evidence/VW-08/attempt-2/transcript-final.json`

VW-12 attempt 1:

- Reset/bootstrap/project/filesystem: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-1/reset.json`, `bootstrap.json`, `project.json`, `project-path.txt`, `project-files.txt`
- Skill entity: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-1/skill-entity.json`
- Missing editor/double path: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-1/queue-stuck.md`
- Four 404s: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-1/console-advanced.txt`
- Creation/index transcript: `../_results/2026-07-10T21-00-21Z/evidence/VW-12/attempt-1/transcript-before-queue.json`

#### Technical boundary observed

The records workflow and editor disagree on the asset contract: indexing a direct `SKILL.md` produces a file-valued `asset_ref`, while the folder-backed Skill editor treats the ref as a directory and appends the schema's main file name. The real file and API entity prove this is path composition, not a missing write.

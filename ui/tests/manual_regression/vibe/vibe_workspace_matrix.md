# Claude Vibe Workspace Browser Matrix

## Scope

Validate the live Claude-backed Vibe Workspace as an interactive creator surface:

- `Open` presents files, HTML, source code, and apps in the active Display.
- `Run` starts the requested app and presents the running result, without rebuilding an existing app.
- `Create skill` writes a valid project skill and opens it in the active Display.
- `Run skill` executes the skill just created and presents its declared output.

This is a browser/manual matrix. It has no `.md.ts` cache. Run it serially through DebugMCP.

Codex chat/terminal rendering is outside this matrix, including the reported absence of Claude's compact elapsed-time/tool summary line on Codex turns.

## Isolation Contract

Before every scenario:

1. Run `flow instance reset <owned-instance> --backend-only --keep-keychain --json`.
2. Require `ready: true`, then verify frontend HTTP and bootstrap `data.types`.
3. Create a new project entity whose mount is the scenario's dedicated fixture directory.
4. Open a fresh DebugMCP tab and clear origin local/session storage, IndexedDB, and CacheStorage before selecting a project.
5. Navigate to the new project, verify its exact id/mount in `window.dataContext.project`, then enter Vibe through the visible Vibe and Home controls. VW-01 is the explicit direct-link exception: it opens the canonical `?viewMode=vibe` URL to validate that entry path, then uses the visible Home control.
6. Record console warnings/errors after every browser action.

Do not reuse process, project, browser-tab, or display state between scenarios.

## Matrix

| ID | Area | Scenario | Required result | Stress/consistency checks |
| --- | --- | --- | --- | --- |
| VW-01 | Entry | Open a clean fixture project and enter Vibe | Vibe home binds to the fixture project; submit creates a Claude process at `/dock/display/agentic_process-*?viewMode=vibe`; chat and Display are both mounted | No `Project Required`, no shell-route regression, no console error |
| VW-02 | Open | Ask Claude to open a known Markdown file, then a known source file | Markdown renders in the document editor; source renders in the code editor; each replaces the active Display | Process URL and left chat stay stable; Display history contains both targets in order |
| VW-03 | Open | Ask Claude to open a known standalone HTML file | HTML is rendered as a usable preview, not raw source or a download | Its button changes page state; hard reload restores the same shown HTML target |
| VW-04 | Open/Run | Ask Claude to open the existing static app | Claude uses the existing app, starts it, and shows a live iframe | Fixture source marker remains unchanged; iframe interaction works; no duplicate app is created |
| VW-05 | Run | Ask Claude to build and run a new one-page app | Files are created under the fixture project, a service starts, and the app appears in the active Display | Unique marker and interaction are visible; chat reaches idle; running target survives browser reload |
| VW-06 | Run | Change the running app in a follow-up and ask to run/show it again | Existing files are edited in place and the same app target refreshes to the new marker | Old marker disappears; new marker appears without a second workspace/process; same-port cache is not stale |
| VW-07 | Display | In one session open Markdown -> HTML -> source -> running app, then use Display history | Every command changes the active Display to the requested target | History is newest-first, prior file targets open as child tabs, Display chip returns to the live app, chat remains bound |
| VW-08 | Skill create | Ask Claude to create `vibe-qa-greeter` with deterministic frontmatter and output | `.claude/skills/vibe-qa-greeter/SKILL.md` is valid and opens in the skill editor in the active Display | File is project-local; editor is not raw/blank; hard reload restores the skill target |
| VW-09 | Skill assets | Create a skill with `SKILL.md`, `references/checklist.md`, and `assets/template.md` | Skill editor loads the main skill; all declared/supporting files exist with exact markers | Open each supporting file from the workspace and return to the skill without losing chat/process state |
| VW-10 | Skill run | Create a deterministic skill, then say `Run the skill you just created` | Claude resolves that project skill, executes its instructions, creates the expected report, and shows the report in Display | Transcript contains a real skill invocation/reading path; output marker and file content match; skill is not recreated |
| VW-11 | Skill persistence | Create a skill, hard reload, start a new Vibe build in the same project, and run the skill by name | The new Claude process loads the existing project skill and produces/shows its expected output | Skill remains discoverable after reload/new process; no stale previous-process Display or output is reused |
| VW-12 | Queue/stress | Create a skill without running it, then queue `open its SKILL.md`, `run it`, and `open the generated report` as ordered follow-ups | Each request executes once and in order; final Display is the report | No dropped/duplicated user turns, no duplicate skill/report, Display history order is coherent, reload restores the final report |
| VW-13 | Open/Image | `Search for a dog image and show it` | Claude downloads an image file into the project and shows it; Display renders a visible image (`media-viewer-image`), not source bytes | `<img>` src is an fs `download` URL and loads (naturalWidth > 0); hard reload restores the image target |
| VW-14 | Generate/HTML | `generate crm.html` | Claude writes a single standalone `crm.html` and shows the FILE; Display renders the sandboxed live preview (`html-preview`) | No `http.server`/port is started; not raw source in a code editor; hard reload restores the same HTML target |

## Full Scenario Steps

### VW-01 - Clean Vibe entry

1. Reset the owned instance and create a project mounted at the empty `VW-01` fixture.
2. In a fresh browser tab open `/dock/project/<project-id>?viewMode=vibe`.
3. Use the visible Home control, then verify the Vibe prompt and selected project.
4. Submit `Reply with VIBE_ENTRY_READY and do not create files.`
5. Wait for the canonical Display process URL and mounted chat/Display split.
6. Verify the response, idle status, route, process project/workdir, and console.

### VW-02 - Markdown and source opening

Fixture: `docs/open-me.md` and `src/open_me.py`, each with a unique visible marker.

1. Start Vibe with `Open the existing file docs/open-me.md in the active display. Do not modify it.`
2. Verify the rendered Markdown marker and the active Display target.
3. Send `Now open the existing source file src/open_me.py in the active display. Do not modify it.`
4. Verify code-editor content/marker and unchanged process URL.
5. Open Display history and verify both targets, newest first.

### VW-03 - Standalone HTML opening and restore

Fixture: `public/open-me.html` with marker `VW03_HTML_READY` and a button that changes it to `VW03_HTML_CLICKED`.

1. Start Vibe with `Open the existing file public/open-me.html in the active display. Do not start a server and do not modify it.`
2. Verify an HTML preview, the ready marker, and working button interaction.
3. Hard reload the browser.
4. Verify the same HTML target and clicked state semantics after reload (page may reset to READY, but must remain interactive).

### VW-04 - Open and run an existing static app

Fixture: existing `index.html` with marker `VW04_EXISTING_APP`, plus an interaction counter.

1. Start Vibe with `Open the existing app in this project. Do not rebuild or replace it.`
2. Verify a running webapp iframe, marker, and counter interaction.
3. Compare the fixture file to its pre-run hash; source content must be unchanged.
4. Verify a persisted WEBAPP target/artifact and no duplicate app directory.

### VW-05 - Build and run a new app

1. Start Vibe with `Create and run a one-page app titled VW05 Build App. Show VW05_APP_READY and add a button that increments a visible count.`
2. Wait for Claude to create files, start a service, and call `flow show webapp`.
3. Verify marker and counter behavior inside the active Display iframe.
4. Hard reload and verify the app target is restored and remains interactive.

### VW-06 - Edit and refresh a running app

1. Start with the same build request as VW-05, using marker `VW06_VERSION_ONE`.
2. After it is interactive, send `Change the visible marker to VW06_VERSION_TWO and make the button add 2. Keep the same app and show the updated result.`
3. Verify version one disappears, version two appears, and the button increments by two.
4. Verify there is still one process workspace and one app root; inspect Display history for coherent target handling.

### VW-07 - Multi-target Display history and child tabs

Fixture: Markdown, HTML, source, and an existing static app with `VW07_*` markers.

1. Start by opening Markdown; then send one completed turn each to open HTML, source, and finally the app.
2. After every turn verify the requested marker and unchanged process workspace URL.
3. Open Display history and verify newest-first ordering.
4. Open the source history entry as a child tab, verify the side chat remains visible/bound, then click Display and verify the live app returns.

### VW-08 - Create and open a skill

1. Start Vibe with `Create a project skill named vibe-qa-greeter. It must write the exact text VIBE_GREETER_RAN to output/greeting.txt when run. Open the skill when ready.`
2. Verify the skill path, valid YAML frontmatter (`name`, `description`), and deterministic instruction.
3. Verify the active Display is the skill editor with nonblank content.
4. Hard reload and verify the same skill target/editor is restored.

### VW-09 - Skill references and assets

1. Ask Claude to create `vibe-qa-bundle` with `SKILL.md`, `references/checklist.md` containing `VW09_REFERENCE`, and `assets/template.md` containing `VW09_TEMPLATE`; ask it to open the skill.
2. Verify all three files exist under the same project-local skill directory.
3. In the same Vibe chat, send one completed follow-up for each support file: `Open references/checklist.md in the active display.` and then `Open assets/template.md in the active display.` Verify the exact content after each turn.
4. Return to Display/skill and verify chat/process continuity and no missing-asset errors.

### VW-10 - Run the skill just created

1. Ask Claude to create `vibe-qa-runner`; its instructions must create `output/vw10-report.md` containing `VW10_SKILL_EXECUTED`, then show that report.
2. Verify the skill editor is active and the output file does not yet exist.
3. Send exactly `Run the skill you just created.`
4. Verify the existing skill was read/executed, output exists once with the exact marker, and the report is the active Display.

### VW-11 - Skill persistence across process boundaries

1. Create `vibe-qa-persist` whose run output is `output/vw11-report.md` with `VW11_PERSISTED_RUN`; verify its skill editor.
2. Hard reload, use `New` to start a fresh build in the same project, and verify a new process id.
3. Send `Run the project skill vibe-qa-persist.`
4. Verify the new process loads the pre-existing skill and shows the exact report; verify only one skill directory exists.

### VW-12 - Ordered follow-up stress

1. Submit exactly: `Create a project skill named vibe-qa-queue. When run, it must create output/vw12-report.md containing the exact marker VW12_QUEUE_COMPLETE and show the report. Open the skill when ready. Do not run it yet.` While creation is busy, record whether Vibe exposes an enabled composer or queue control. Wait for creation to finish and verify the report is absent.
2. On the same process, disable queue draining and stage the three follow-ups. Use Vibe's queue control if one was available; otherwise use the visible `Advanced` mode control, then the `Queue` ribbon control (list-ordered icon / `Prompt Queue` panel). Add exactly, in order: `Open the skill you just created.`, `Run it once.`, `Open the generated report.` Do not call the queue API directly.
3. Wait until the queue drains, return through the visible `Vibe` mode control, and verify the three exact user turns and one execution/output occurred in order without duplicates.
4. Verify final Display/report, Display history ordering, unique filesystem paths, empty final queue, and final-target restore after hard reload.

### VW-13 - Image deliverable shown in the image viewer

1. Start Vibe with `Search for a dog image and show it.`
2. Wait for the turn to complete; the agent should download an image file (jpg/png/webp/…) into the project and run `flow show file <abs image>`.
3. Verify the Display contains a visible `[data-testid="media-viewer-image"]` `<img>` whose `src` points at the fs `download` action and which actually loaded (`naturalWidth > 0`) — NOT a code editor with binary text.
4. Hard reload; verify the image target restores.

### VW-14 - Generated standalone HTML shown as live preview

1. Start Vibe with `generate crm.html`.
2. Wait for the turn to complete; the agent should write one standalone `crm.html` in the project and run `flow show file <abs>/crm.html` (no server, no port).
3. Verify the Display contains the sandboxed `[data-testid="html-preview"]` iframe rendering the page — NOT the code editor source view and NOT a webapp port iframe.
4. Hard reload; verify the same HTML target restores.

## Bug Gate

A failure becomes a product bug only after:

1. the reset, bootstrap, project binding, and Claude availability are proven;
2. the same failure signature reproduces after a second clean reset in a new tab;
3. browser snapshot/screenshot, console, relevant network/API data, and filesystem evidence are captured; and
4. the complete scenario is added to `vibe_bugs.md` without changing product code.

## Result Artifact Contract

Each `vibe--VW-XX.json` file contains one test block for the matrix scenario and identifies the canonical verdict run in `verdict_attempt`. Stable `scenario_id`, `bug_ids`, and `disposition` fields link the matrix row to cycle findings; the schema's `known_bug` remains the source-file declaration flag. Retries, confirmation runs, harness mistakes, and their evidence windows stay in `cycle-state.md`; they are not encoded as duplicate Markdown test blocks.

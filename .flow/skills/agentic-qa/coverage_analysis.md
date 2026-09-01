# Coverage Analysis — Phase 6 process navigation blocked by loader-owned PTY attach — 2026-07-28

## Failure classification and exact cause

This is a deterministic production architecture failure exposed by the corrected
router observer, not test drift and not a timeout problem.

The focused Phase 6 artifact
`ui/tests/manual_regression/_results/2026-07-28T16-05-04Z/phase6-router-observer-focused.json`
shows `new-agentic-tab-loader-regression.test.tsx` remaining at:

```text
/dock/project/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
```

while the test expects:

```text
/dock/shell/agentic_process-22222222-2222-4222-8222-222222222222
```

The mocked new process's `open` action is deliberately unresolved at that
assertion. The production sequence is:

1. The opener creates the process and calls the normal navigation shortcut.
2. React Router starts `loadAgentApp`; `setupTabAndAdopt` awaits
   `loadDockPointer`.
3. The shell pointer dispatches through `loadShellRoute` to `loadProcess`.
4. `loadProcess` resolves process/project identity, but then awaits
   `process.start({visible:true})` and `process.shell()`.
5. `AgenticProcess.start` awaits the backend `open` action and
   `Shell.attachPty`.
6. React Router cannot commit the new location or mount `TerminalPanel` until
   that parent loader resolves.

Therefore the old project URL persisting while `open` is pending is the actual
product behavior. The test is correctly pinning the repository's
non-negotiable URL-first rule: a loader resolves identity and writes context;
PTY/WS-bound attach work starts from an effect on the mounted view.

The ordering defect is wider than the location alone. In `loadProcess`, all of
these identity/select writes currently occur *after* the runtime await:

- active terminal target;
- process activation;
- `Tab.last_active_at` select stamp;
- workdir;
- current-process context.

That explains why the sibling
`tab-select-stamps-tab-recency.test.tsx` is part of the same contract. It already
expects the router location before releasing the mocked `open`, but its comment
and final recency assertion still assume the select stamp waits for PTY startup.

## Architectural disposition (`slick`)

Flag this for the frontend architecture owner; do not repair the test and do not
put `void process.start()` in the loader.

The required ownership split is:

- `loadProcess` remains the cache-first process identity/project loader. It
  writes URL-owned target, current-process, workdir, process activation, and Tab
  recency before returning. Its return contract no longer promises a newly
  attached Shell.
- `TerminalPanel`, which already hydrates the live process per mounted tab, owns
  one automatic PTY runtime-start effect for a mounted non-headless process.
  The effect calls a shared runtime helper that starts/reopens the process,
  resolves the Shell, classifies failures, and updates runtime-only shell/error
  state. It must not become a second implementation beside the loader; remove
  the loader runtime path.
- While a shell-less process start is pending, the panel renders an explicit
  loading state. It must not flash the current “nothing to display” recovery
  state before startup has actually failed.
- Completion/error writes must be guarded against stale panels: an attach
  finishing after navigation to a different tab must not overwrite the active
  shell or global runtime error for the new URL. Preserve one in-flight start
  per process/mount (including React effect replay); do not add waits, retries,
  sleeps, or timeout budget.
- Headless processes continue to skip PTY startup and render their shell-less
  chat path.
- Existing explicit user recovery (`retryFailedStart` and banner actions)
  remains separate from automatic mount attach, especially because
  `retry:true` is user intent that clears the server latch.

The debugger identified candidate implementation commit `a610df96` on
`fix/x8-loader-attach`. That candidate needs architecture review and the
contracts below before adoption; this coverage audit did not execute or verify
it.

There are two sibling violations that make a process-only patch an incomplete
claim of URL-first terminal loading:

- `loadShellRoute` unconditionally awaits
  `connectionManager.waitForConnected(5000)` before dispatch, so every concrete
  shell/process URL can still be held behind realtime readiness.
- `loadShell` awaits `shell.start()` in the route loader, so plain-terminal
  navigation has the same PTY-bound ownership inversion.

Those branches may be migrated in the same architectural change or tracked as
explicit follow-up work, but they must not be hidden by changing the process
regression expectation. No timeout increase is permitted.

## Existing coverage disposition

| Test / mechanism | Type | Status | Exact disposition |
|---|---|---|---|
| `ui/tests/react/new-agentic-tab-loader-regression.test.tsx` | vitest-react, real data router + production opener/tab/body | keep and strengthen after product fix | This is the owning red regression. Keep `open` unresolved and require the router location and materialized process tab before release. Also require an active process panel/loading state without a premature error. Release `open`, then require the same URL and the hydrated terminal transport. Do not weaken it to release before checking the URL, mock `loadProcess`, observe `window.location`, or add a timeout. |
| `ui/tests/react/tab-select-stamps-tab-recency.test.tsx` | vitest-react, real data router + Tab action boundary | modify expectation ordering/comments | Keep the URL-before-release assertion. Assert the process Tab's select-recency stamp before PTY `open` resolves, because selection is URL/identity state rather than runtime readiness. Then release startup only to settle the mounted runtime effect. The current “let open complete so the loader runs to the select-stamp” comment encodes the broken ordering and must be removed. |
| `ui/tests/unit/agentic-process-start.test.ts` | vitest-unit SDK | keep | Owns the `AgenticProcess.start` open payload and start-failure-latch behavior. It should remain independent of which React lifecycle invokes `start`. |
| `ui/tests/unit/terminal-runtime-error-banner.test.tsx` | vitest-unit/RTL | keep; add no duplicate kind matrix | Already pins all typed soft-error copy/actions and dismissal. The architecture change should reuse its recovery model rather than create new error semantics. |
| Add a focused mounted-runtime-owner test beside the terminal component tests | vitest-unit/RTL | add | Mount a process `TerminalPanel`/`TabbedTerminal` with no Shell, assert one automatic start for mounted non-headless process, an explicit pending state, success hydration, and no stale active-shell/error write after switching away. Include a headless case proving zero start calls. This is the lowest deterministic owner for effect gating and stale completion, which the full router tests cannot isolate clearly. |
| `ui/tests/unit/chats-scope-follows-opened-process.test.ts` | vitest-unit route policy | modify mocks/comments only if the helper signature changes | Keep scope reconciliation before runtime and hard-vs-soft URL policy coverage. Runtime errors will no longer originate synchronously from the route loader after the ownership move, so do not preserve a mocked loader rejection merely to retain the old architecture. Move runtime classification assertions to the mounted runtime-helper test. |
| `ui/tests/api/scope_redirect_preserves_viewmode.test.ts` | vitest API | keep | Owns server-backed scope redirect/query carry before process loading. It should not be expanded into a PTY-start timing test. |
| `ui/tests/api/agentic-process-connection-id.test.ts`, restart/recovery API suites, and Python `test_agentic_open_concurrency.py` / resume tests | SDK/backend/API | keep | These own backend open, connection identity, concurrency, restart, and PTY recovery. They do not own when React Router commits a URL. |
| Manual agentic/terminal matrices (`new_claude_session_no_console_errors`, quick-create URL ordering, restored-visible process, terminal tab switching/persistence) | Playwright/manual | keep; rerun relevant cases after fix | They validate real startup, attach, replay, and switching after the deterministic component/router contracts pass. Do not replace the red React test with an expensive browser timing check. |

## Exact regression pass/fail contract

Precondition:

- start on a project dock;
- the real opener creates a new PTY-mode `AgenticProcess`;
- the backend `open` action exposes a release hook and remains pending;
- observe location through `useLocation` inside the real data router.

Before releasing `open`, pass requires:

- location is the exact new
  `/dock/shell/agentic_process-<processId>` URL;
- the process Tab is present and active;
- its Tab recency activation has been issued;
- the mounted process panel is in a non-error startup state;
- the mocked `open` has not resolved.

After release, pass requires:

- URL and active tab do not change;
- the process receives its linked `shell_id`;
- the terminal transport renders/attaches;
- no duplicate automatic process start is issued.

Fail includes:

- URL remains on the source project while runtime is pending;
- releasing runtime is required for tab selection/recency;
- a shell-less pending process flashes the terminal error state;
- a late completion from an inactive panel overwrites active context/error;
- headless mode starts a PTY;
- the loader fires startup without awaiting it;
- any wait/timeout/retry budget is raised.

## Mandated layer audit

| Layer | Signal and disposition |
|---|---|
| `tests/unit/` | Backend process/open/lifecycle and PTY concurrency are already covered. Keep; frontend effect ownership does not belong in Python unit tests. |
| `tests/api/` and `tests/long_tests/` | Keep restart, resume, PTY process, stream, and recovery coverage. Add no router-order test here. |
| `ui/tests/unit/` | Add one mounted runtime-owner test for start gating, pending/success/failure, headless skip, dedupe, and stale completion. Keep SDK start and error-banner tests. |
| `ui/tests/api/` | Keep process connection-id, backend restart, and scope redirect coverage. They prove real open/recovery behavior, not render lifecycle ordering. |
| `ui/tests/react/` | Keep the exact new-tab router regression red until the product is fixed; modify the recency sibling to assert selection before runtime release. These two are the primary navigation-order coverage. |
| `ui/tests/headless/` and `ui/tests/long/` | No lower-level owner for this ordering. Add none. Headless transport behavior is cheaper and clearer in the mounted unit case. |
| `ui/tests/hub/` | No hub behavior participates in local router commit or PTY attach ownership. Add none. |
| `ui/tests/e2e/` and `ui/tests/manual_regression/` | Rerun the existing quick-create/restored-process/tab-switch/recovery scenarios after deterministic suites pass. Add no new manual timing scenario unless the plain-shell/realtime-wait follow-up needs a separate tracked proof. |
| `ui/tests/manual_regression/_fast_paths/` | No relevant terminal fast path exists. Add none for the bounded process correction. |

## Documentation review

Documentation is currently contradictory and must be reconciled with the
runtime-owner change:

- `docs/tab-management.md:234-237` and
  `docs/shell-claude-session-api.md:160-163` already state the desired design:
  each `TerminalPanel` hydrates and attaches on mount.
- `docs/agent-management/tabs-management.md` still says `loadProcess` and
  `loadShell` start/reattach PTYs before render.
- `docs/agentic-process.md` still calls this the route-loader runtime phase and
  says the loader owns PTY startup.
- Source comments in `load-process.ts`, `load-shell.ts`,
  `TerminalRuntimeErrorBanner.tsx`, and `InteractiveTerminal.tsx` also describe
  loader-owned startup.

Update those references with the product refactor. Do not change the
non-negotiable URL-first guidance; the code must be brought into agreement with
it.

## Summary

- Classification: production architecture violation; PTY/WS work blocks React Router commit
- Keep: exact new-tab red regression, SDK/backend open/recovery coverage, scope redirect tests
- Modify: recency ordering test; route-policy mocks/comments affected by the ownership split
- Add: 1 focused mounted runtime-owner RTL test
- Remove: 0 tests
- Product change required: yes, architecture owner
- Sibling follow-up required: plain-shell `start` and route-level realtime wait
- Documentation changes required: yes, contradictory loader/runtime descriptions
- Timeout/wait changes: prohibited; none recommended
- Confidence: HIGH

# Coverage Analysis — Phase 6 shared markdown navigation harness — 2026-07-28

## Failure classification and exact cause

This is deterministic test-harness drift after the URL-first navigation
implementation was corrected, not a production routing regression.

The machine artifact
`ui/tests/manual_regression/_results/2026-07-28T16-05-04Z/phase6-vitest-react-pass.json`
reports:

```text
conversation-shared-md-opens-doc-editor.test.tsx:83
expected "/" to match /^\/dock\/assets\/editor\/markdown\//
```

The click path in production is correct and URL-first:

1. `AttachmentRow`'s click handler does only
   `navigation.openDock(dockPointerForLocalFile(localPath))`
   (`ui/src/components/conversation/ConversationContextPanel.tsx:539-570`).
2. `dockPointerForLocalFile` qualifies the downloaded absolute path with
   `compute_node-@local`, then delegates to the shared generic file pointer
   (`ui/src/components/conversation/attachment-url.ts:60-75`).
3. `dockPointerForFile` identifies markdown and builds an
   `AssetDocPointer.forVfs(AssetEditor.MARKDOWN, ...)`, whose dock is the Assets
   document editor, not the code editor
   (`ui/src/navigation/local-file-pointer.ts:20-33`).
4. `NavigationActions.openDock` serializes that pointer, preserves URL options,
   and commits through the injected React Router `navigate()` function
   (`ui/src/navigation/NavigationActions.ts:260-377`).
5. In the real browser router this URL transition runs the parent dock loader;
   `loadDockPointer` delegates Assets URLs to `loadAssetRoute`, which parses the
   VFS pointer and resolves URL-owned context
   (`ui/src/routes/loaders/load-dock-pointer.ts:207-229`,
   `load-asset.ts:67-130`).

The test mounts `AttachmentRow` under `<MemoryRouter>` but reads the unrelated
global `window.location` immediately after the click. A MemoryRouter owns an
in-memory history; `useNavigate()` updates that history and `useLocation()`
subscribers, not jsdom's global browser history. Therefore the observed `/` is
the expected state of the wrong probe and says nothing about the destination
the component requested.

The test's comments reveal the stale contract: they say
`NavigationActions` commits via `history.pushState`. Commit `85c09b9c`
(2026-07-27) deliberately removed the jsdom `pushState`/`popstate` side channel
and made every environment enter through `navigate()`. Hand-written history
updates could change the visible URL while bypassing data-router
revalidation—the exact URL/context inversion prohibited by the repo's URL-first
policy. The test was introduced earlier in commit `70ab21eb` and was not
updated when the navigation owner changed.

## Corrective seam (`slick` placement)

Modify the test harness, not `NavigationActions`, the click handler, or the
pointer builder.

Add a tiny `LocationProbe` inside the same `<MemoryRouter>` that reads
`useLocation().pathname` (and search if needed), then assert that router-owned
value after the click. Use the normal async React assertion shape (`waitFor` or
an awaited `findBy*`) because navigation commits a render; do not add or raise a
timeout.

Also correct the test's stale explanatory prose:

- React Router `navigate()` owns the transition; `window.history.pushState`
  does not.
- The current pointer path is
  `dockPointerForLocalFile` → `dockPointerForFile` →
  `AssetDocPointer.forVfs`, not a direct
  `DockPointer.forAssetEditor('markdown', ...)`.

Do not restore the removed jsdom fallback merely to make `window.location`
change. That would create a parallel navigation path, and in production it can
show a new URL without running the loader that writes the corresponding
context.

## Existing coverage disposition

| Test / mechanism | Type | Status | Exact disposition |
|---|---|---|---|
| `ui/tests/react/conversation-shared-md-opens-doc-editor.test.tsx` | vitest-react | modify | Preserve the real `AttachmentRow` click and real `useDockNavigation`, but observe `useLocation` from its MemoryRouter and await that value. Keep both route assertions: reject leading `/dock/editor/` and require `/dock/assets/editor/markdown/`. Remove the irrelevant `window.history` setup and update the stale pushState/direct-forAssetEditor comments. |
| `ui/tests/unit/editor-for-path.test.ts::dockPointerForFile` | vitest-unit | keep | This is the lowest deterministic pointer-policy owner. It already pins `.md` and wider markdown extensions to `editor/markdown/vfs`, media/HTML to their viewers, and code to `ViewType.EDITOR`. No duplicate helper-only test is needed. |
| `ui/tests/unit/explorer-md-opens-assets-viewer.test.tsx` | vitest-unit/RTL | keep behavior; clean stale cause prose separately | It drives another real file-opening surface through the shared pointer chokepoint and already uses the correct `useLocation` probe pattern. Its lines 16-18 still describe an old unconditional `DockPointer.forFile` implementation, but its behavior and assertions remain valid. |
| `ui/src/navigation/NavigationActions.ts` and router revalidation | production mechanism | keep | `navigate()` is the single transition seam that lets React Router run `loadAgentApp`/`loadDockPointer`; `shouldRevalidateDock` explicitly re-runs the parent loader whenever the dock URL changes. No product change is warranted. |
| Asset loader/deep-link tests (`asset-loader-project-context`, `markdown-typeid-deeplink-selection`, VFS tree/manual scenarios) | vitest React/manual/Playwright | keep | These own destination loading, active entity/project context, tree selection, and editor rendering once an Assets markdown URL exists. They are downstream from the attachment click and should not duplicate its routing-source assertion. |
| `tests/unit/test_received_markdown_project_stamping.py` and bundle/install tests | pytest-unit | keep | They own transfer, install, reindex, and destination-project stamping for received markdown. They do not execute browser navigation and correctly remain separate. |
| Hub asset/plan sharing matrices | vitest-hub | keep | They own cross-instance sharing, download/install, and indexing. Adding a browser click to those expensive suites would duplicate a deterministic local UI navigation decision. |

## Regression pass/fail contract

The corrected existing test is sufficient; no new test file is required.

Precondition: render a downloaded FILE attachment whose `local_path` ends in
`.md` under a MemoryRouter starting at `/`, with a router-location probe mounted
inside it.

Action: click the real AttachmentRow “Open” affordance.

Pass:

- the MemoryRouter location changes from `/`;
- the path begins `/dock/assets/editor/markdown/`;
- it does not begin `/dock/editor/`;
- the VFS locator retains `compute_node-@local` and the downloaded file path
  (an exact/contains assertion is useful because this is what makes the raw
  received file readable outside any project mount).

Fail:

- no router transition occurs;
- the destination is the code editor or another viewer;
- the compute-node qualification/file path is lost;
- the assertion reads global `window.location` instead of the router under
  test.

No backend, browser, timer, sleep, retry, poll, timeout increase, context write,
or direct `pushState` is part of this regression.

## Mandated layer audit

| Layer | Signal and disposition |
|---|---|
| `tests/unit/` | Received-markdown transfer/install/project stamping is covered. Keep; no Python navigation test belongs here. |
| `tests/api/` and `tests/long_tests/` | No browser navigation owner. Add none. |
| `ui/tests/unit/` | Keep the shared pointer-policy table and Explorer click regression. They cover the lowest routing rule and a sibling consumer. |
| `ui/tests/api/` | No exact attachment-click case. Add none; HTTP is not involved in choosing the pointer. |
| `ui/tests/react/` | Modify the existing exact AttachmentRow regression to observe MemoryRouter state. This is the owning behavioral test. |
| `ui/tests/headless/` and `ui/tests/long/` | Existing full-app editor tests cover real loader/render round trips for other asset types. Add no slower duplicate for a local pointer decision. |
| `ui/tests/hub/` | Keep cross-client asset/plan sharing and install matrices. No browser-click addition. |
| `ui/tests/e2e/` and `ui/tests/manual_regression/` | Markdown editor URLs, tree selection, and rich editor behavior are already exercised downstream. There is no exact conversation raw-file click scenario, but the corrected component test plus shared pointer unit test cover that boundary more directly; add none. |
| `ui/tests/manual_regression/_fast_paths/` | Only CLI-log and record-search fast paths exist; neither is relevant. Add none. |

## Documentation review

No product documentation was changed. `docs/tab-management.md` already states
the current non-negotiable flow:

```text
click → navigation.openDock(pointer) → react-router loader → context → render
```

It also explicitly says click handlers perform only navigation and loaders own
context. The stale statements are confined to comments in the failing and
Explorer tests, which should be corrected with the test fix.

## Summary

- Classification: stale MemoryRouter observation after intentional URL-first navigation refactor
- Keep: production click, pointer, router, loader, pointer-policy, transfer, and downstream editor coverage
- Modify: 1 existing React test and its stale comments
- Add: 0 new tests/files
- Remove: 0
- Product change required: no
- Documentation changes: none
- Confidence: HIGH

# Coverage Analysis — Phase 6 independent status entity updates — 2026-07-28

## Failure classification and exact cause

The observed failure is deterministic test expectation drift, not a production
regression in lifecycle/worker-axis independence.

`ui/tests/react/agentic_process_stress.test.ts:322-340` constructs an
`AgenticProcess` without `worker_status`, sends a status-only `STARTING` update,
and expects the first `state_change` snapshot to contain
`workerStatus: "initializing"`. That default stopped being valid in commit
`4741fc51` ("a null worker status means ready"): the constructor now maps an
absent or null wire value to `undefined`
(`ts_sdk/src/process/agentic-process.ts:1424-1434`). The backend owns
INITIALIZING and emits it only when the lifecycle is STARTING and a spawned
worker has no transcript; a TypeScript constructor or an unrelated status-only
event must not synthesize it.

The hook otherwise applies these axes independently:

- a changed `status` updates lifecycle state and emits a `state_change` delta
  with `field: "status"` (`agentic-process.ts:2993-3012`);
- a changed non-null `worker_status` updates the transcript projection and emits
  `field: "workerStatus"` (`:3025-3034`);
- neither branch writes the other axis.

The static result of the failing sequence is therefore:

```text
STARTING / undefined
STARTING / running
RUNNING  / running
RUNNING  / idle
```

The machine artifact
`ui/tests/manual_regression/_results/2026-07-28T16-05-04Z/phase6-vitest-react.json`
reports this one deep-equality failure at line 334; the three adjacent entity
update cases passed.

## Adjacent production gap found by the normalization audit

There is a separate real SDK update bug at this seam. The Python serializer
deliberately includes `worker_status: null` when no transcript status exists
(`flow_sdk/builtin/agentic_process/agentic_process.py:5855-5869`), and transcript
updates use the `(status, busy, worker_status)` triple as their broadcast key
(`:6941-6963`). Thus null is an explicit, meaningful update, not equivalent to
an omitted field.

The TypeScript hook currently guards with truthiness:

```ts
if (data.worker_status && data.worker_status !== this.workerStatus) {
```

Consequently a cached process that previously held `running`, `working`, or
another worker status ignores a later explicit null and keeps returning the old
value from its private `_workerStatus`. The store's following `deepAssign`
writes only the raw snake-case `worker_status` property; it does not update the
getter's private field (`ts_sdk/src/FlowSync/store.ts:1646-1663`).

This gap did not cause the current assertion—the first update omits the field
and correctly preserves `undefined`—but it is an independently valid production
defect uncovered by the requested normalization review.

## Corrective seam (`slick` placement)

The lowest owner is `AgenticProcess.onEntityUpdate`, the shared SDK reflection
hook used by both WebSocket entity operations and REST write-throughs. It should
distinguish presence from truthiness:

- omitted `worker_status`: preserve the current getter value and emit nothing;
- explicit `worker_status: null`: normalize to `undefined`, update the getter,
  and emit one `workerStatus` delta when the prior value was non-null;
- a string status: assign and emit only on a real value change.

Do not synthesize INITIALIZING from `status: STARTING`, change the constructor
back to an INITIALIZING default, or patch a React consumer. Those would recouple
the lifecycle and transcript axes and reintroduce the ready-worker spinner bug
that `4741fc51` fixed.

## Existing coverage disposition

| Test / mechanism | Type | Status | Exact disposition |
|---|---|---|---|
| `ui/tests/react/agentic_process_stress.test.ts::status and worker_status update independently on entity events` | vitest-react project, SDK-only test | modify | Change the first expected `workerStatus` to `undefined` and type the snapshot field as `WorkerStatus | undefined` rather than `string`. Keep the four-step sequence because it clearly proves that an omitted worker update preserves that axis while later worker-only and status-only deltas do not overwrite each other. The test does not render React or receive a real WS event despite its suite label; do not add backend waits. |
| The other three active cases in `agentic_process_stress.test.ts` | vitest-react project, SDK/dataManager smoke | keep behavior; clean up stale suite prose separately | They pin subscription notification and the removal of `is_active` as a status owner. They passed and do not assume a worker default. The skipped PTY/restore suites and stale `resolvedStatus`/`ProcessorStatus` prose are historical debt outside this failure; they should not be revived by increasing waits or timeouts. |
| `ui/tests/unit/agentic-process-null-worker-status.test.ts` | vitest-unit | keep and extend | Its constructor assertion is the direct owner of null/absent → `undefined`, and its status-label assertion prevents the permanent Initializing spinner. Add the cached-update regression below here rather than creating another file. |
| `ui/tests/unit/agentic-process-output.test.ts` | vitest-unit | keep | It already exercises the same protected hook for busy, lifecycle failure, and terminal worker-status settlement. Those are turn-settlement contracts and should remain separate from null normalization. |
| `ui/tests/unit/agentic-status.test.ts` and worker display/status component tests | vitest-unit/React | keep | They own enum parity, readiness/display fallbacks, and rendered labels once an entity exposes a value. They do not own wire-to-entity reflection and need no duplicate null-update case. |
| `tests/unit/test_agentic_process/test_initializing_projection.py` | pytest-unit | keep | This is the authoritative backend projection regression: STARTING/no transcript → INITIALIZING, while RUNNING/no transcript → None and ready unless a turn is in flight. It directly disproves the stale frontend default. |
| `tests/unit/test_agentic_process/test_on_transcript_change.py` and serializer/status tests | pytest-unit | keep | They own change-gated triple broadcasts and the nullable wire projection. No backend change is required for this SDK defect. |
| `tests/api/test_agentic_process_status_api.py` and `tests/api/test_process_status_lifecycle.py` | pytest-api | keep | The status API explicitly asserts a new process returns `worker_status is None` and the lifecycle suites own durable status transitions. They do not reuse a cached TypeScript entity, so they cannot catch the reflection bug. |
| `tests/long_tests/` transcript/worker status scenarios | pytest-long | keep | These own real transcript production and backend status projection. Add no live worker case for a deterministic TypeScript field-presence reducer. |
| `ui/tests/api/` | vitest-api | no exact case; add none | A live API/WS case would make event ordering part of the assertion while duplicating a deterministic SDK hook contract. |
| `ui/tests/headless/`, `ui/tests/long/`, `ui/tests/e2e/`, and manual fast paths | mixed | no exact case; add none | The defect is observable before rendering, transport, or browser navigation. A higher-layer duplicate would be slower and less diagnostic. |
| `ui/tests/hub/chat_terminal_switch_stress.ui.test.ts` and worker status hub consumers | hub/browser | keep | These are broad transport/UI consumers. Hub does not own local `AgenticProcess` status normalization, so no hub-specific regression belongs here. |

## New regression required

Extend `ui/tests/unit/agentic-process-null-worker-status.test.ts` with one
field-presence update test using a tiny subclass that exposes
`onEntityUpdate` (the pattern already used in
`agentic-process-output.test.ts`).

Precondition: construct a RUNNING process with
`worker_status: WorkerStatus.RUNNING`, and collect `state_change` delta
payloads.

Actions and pass criteria:

1. Apply an update that omits `worker_status`: the getter remains RUNNING and no
   worker delta is emitted.
2. Apply `{worker_status: null}`: the getter becomes `undefined` and exactly one
   delta reports
   `{field:"workerStatus", oldValue:RUNNING, newValue:undefined}`.
3. Apply the same null again: no duplicate delta is emitted.

Fail if null is ignored, omission clears the value, a duplicate emits, or the
hook synthesizes INITIALIZING. The test needs no backend, WebSocket, timer,
retry, poll, timeout, or React mount.

The existing failing test then continues to own cross-axis ordering with this
corrected first snapshot; the new unit assertion owns null normalization. No
new test file or browser scenario is needed.

## Mandated layer audit

| Layer | Signal and disposition |
|---|---|
| `tests/unit/` | Backend nullable projection, status predicates, serializers, and transcript change broadcasts are already covered. Keep; no Python addition. |
| `tests/api/` | Null wire shape and lifecycle writes are covered. Keep; no new API case. |
| `tests/long_tests/` | Live transcript/worker behavior is covered. Keep; no SDK reflection duplication. |
| `ui/tests/unit/` | Extend the existing null-worker-status suite with the explicit-null vs omitted update contract. |
| `ui/tests/api/` | No exact cached-update case. Add none because the SDK reducer is deterministic below HTTP/WS. |
| `ui/tests/react/` | Correct the failing first expected snapshot and optional type; keep the independent-axis sequence. |
| `ui/tests/long/` and `ui/tests/headless/` | No relevant case; add none. |
| `ui/tests/hub/` | Keep broad status/transport consumers; no local normalization owner. |
| `ui/tests/e2e/` and `ui/tests/manual_regression/` | No exact case; add none because no UI interaction is needed to prove it. |
| `ui/tests/manual_regression/_fast_paths/` | Only CLI-log and record-search paths exist; neither is relevant. Add none. |

## Documentation review

Corrected two objectively stale interface statements:

- `docs/interface/agentic-process.md` now types `workerStatus` as
  `WorkerStatus | undefined` and documents `state_change` for all three emitted
  fields: `status`, `busy`, and `workerStatus`.
- `docs/agent-management/agentic-process.md` now includes `busy` in its
  `state_change` event table.

The canonical status-model docs already correctly describe raw nullable
`worker_status`, backend-only INITIALIZING projection, and the independence of
the lifecycle/busy/worker axes; no other documentation change is needed.

## Summary

- Observed failure: test expectation drift after intentional null-status fix
- Adjacent production defect: explicit null is ignored by cached SDK updates
- Modify: 1 existing React expectation/type and 1 existing unit file
- Add: 1 focused unit case, 0 new files, 0 API/browser cases
- Remove: 0
- Product change required: yes, narrowly in `AgenticProcess.onEntityUpdate` for explicit-null normalization
- Confidence: HIGH

# Coverage Analysis — Phase 5 headless spawn vs partial `createProcess` response — 2026-07-28

## Failure classification and exact cause

This is a production action-response contract regression introduced when
`AgenticProcess.spawn()` was moved onto the shared backend factory in commit
`85c09b9c` (2026-07-27). The headless expectation is valid and the request
payload is already correct.

The machine-readable artifact
`ui/tests/manual_regression/_results/2026-07-28T16-05-04Z/phase5-vitest-api-remainder.json`
failed the first assertion in
`ui/tests/api/agentic_spawn_pty_mode.test.ts:34`:

```text
expected true to be false
```

The persisted reload assertion at line 38 did not run. The complete causal
chain is:

1. `AgenticProcess.spawn(..., {headless:true})` passes
   `{visible:false, pty_mode:false}` to `ComputeNode.createProcess`
   (`ts_sdk/src/process/agentic-process.ts:559-571`).
2. `ComputeNode.createProcess` serializes the explicit `false` into the action
   body (`ts_sdk/src/entities/compute-node/compute-node.ts:199-205`).
3. `_scan_create_process` reads that top-level field, constructs the Python
   entity with `pty_mode=False`, and saves it
   (`flow_sdk/builtin/faas/scan_actions.py:287-292,443-473`).
4. The action then returns only
   `{id,type,shell_id,pty_pid}` (`scan_actions.py:558-565`), despite both its
   docstring and the TS method contract saying that it returns an
   `AgenticProcess`.
5. The SDK casts that partial object as `IAgenticProcess` and hydrates it
   (`compute-node.ts:208-210`). A cache miss invokes the
   `AgenticProcess` constructor, where omitted `pty_mode` deliberately defaults
   to the legacy PTY value `true`
   (`agentic-process.ts:1424-1444`).
6. `spawn()` then sets `shell_mode` and performs a full entity `save()`
   (`agentic-process.ts:573-574`). Because `APIEntity.toJSON()` includes the
   enumerable `pty_mode`, the bad hydrated `true` can be written back over the
   correctly-created durable `false`.

The symptom is race-sensitive, but the contract violation is deterministic.
The backend save broadcasts the full entity. If that WebSocket update reaches
the shared DataManager cache before the minimal action response is hydrated,
`castAndDeepAssign` merges the partial response into the cached full entity and
preserves `false`. If the HTTP response wins, the SDK constructs the partial
entity and defaults to `true`. This explains why
`agentic_process_fe_contract.test.ts` passed its persisted headless precondition
in the same Phase 5 artifact in which the dedicated spawn test saw in-memory
`true`: the two tests exercised opposite event orderings, not opposite product
contracts.

Before `85c09b9c`, `spawn()` directly constructed the TypeScript entity with
`pty_mode: !headless` and saved it, so its returned object could not lose the
field. The refactor correctly centralized construction in the backend but
exposed the pre-existing mismatch between `createProcess`'s full-entity TS
return type and its minimal backend response.

## Corrective seam (`slick` placement)

The shared `createProcess` action boundary is the owner. It mints and saves the
authoritative backend entity, while the frontend contract promises
`Promise<AgenticProcess>`. Its success response must therefore carry the full
authoritative serialized process, including explicit false values such as
`pty_mode:false` and `visible:false`. The sibling
`_scan_upsert_session_process` already uses the correct pattern: refresh the
process, serialize it with `model_dump(mode="json")`, and return that mapping
(`scan_actions.py:857-868`).

Do not patch `spawn()` with `process.pty_mode = !headless`, add a transport
latch there, or rely on the creation broadcast. Those approaches special-case
one caller and leave `openTab`, `launch`, Standard/Vibe chat, wizard, execution
panel, run-on-file, skill analysis, and direct `ComputeNode.createProcess`
callers exposed to the same partial-entity/cache-order race. A forced frontend
GET would recover authority but adds a second round trip to every creation and
preserves a misleading action response; returning the entity from the action is
the lower and already-documented seam.

## Existing coverage disposition

| Test / mechanism | Type | Status | Exact disposition |
|---|---|---|---|
| `ui/tests/api/agentic_spawn_pty_mode.test.ts` | vitest-api | keep behavior; update stale comments | This is the correct end-to-end regression: assert the returned `process.pty_mode` is false, then independently GET the durable row and assert false. Keep both assertions in that order. Update lines 14-15, which still describe the old “request omitted `pty_mode`” defect; the current defect is a response that omits the correctly-requested and saved field. The phrase “without an instruction” is technically about `workerOptions.instruction`, but should be clarified because `options.instructions` is present. |
| `ui/tests/api/agentic_process_fe_contract.test.ts::setVisible` | vitest-api | keep | Its first GET also asserts the created row is durably headless before proving `setVisible` never changes transport. This overlap is intentional because it is a precondition for the distinct visibility-axis contract. It is not sufficient as the creation regression: it never asserts the returned object's initial field and can pass when the save broadcast wins the race. |
| `tests/unit/test_improve_stream_json_headless_transport.py` | pytest-unit/action | modify | It already drives the real `_scan_create_process` method cheaply and captures the correctly-constructed headless entity. In addition to `saved["proc"].pty_mode is False`, assert the success response's entity data contains `pty_mode is False` (and `visible is False`). This is the deterministic, no-WebSocket pin for the actual broken seam. |
| `tests/long_tests/test_pty_mode_matrix.py` | pytest-long/live worker | keep assertions; update response comment | Its PTY/headless × vendor matrix explicitly posts `pty_mode`, then GETs and asserts the durable row before live turns. Preserve that durable check. The line 118 comment that `createProcess` returns a minimal row becomes stale when the action honors its full-entity contract; the test may additionally assert the response mode before the GET, but the fast action test above is the primary response owner. |
| `tests/api/test_workflows_run_cli_mode.py` and headless cases in `test_agentic_process_execute.py` | pytest-api | keep | These prove Python entity construction, persistence, API serialization, and headless routing. They bypass the ComputeNode factory response and therefore correctly passed despite this SDK/action integration defect. |
| `ui/tests/unit/open-new-chat.test.ts` | vitest-unit | keep | Pins that Standard/Vibe callers request `{visible:false, pty_mode:false}` and Terminal requests true. It proves request intent, not response hydration; no change is needed. |
| `ui/tests/unit/agentic-process-constructor.test.ts` | vitest-unit | keep | The legacy default `entity.pty_mode ?? true` is correct for rows that predate the field. Changing the constructor default to hide a partial action response would silently turn all genuinely legacy/omitted rows headless and is not an acceptable fix. |
| `ui/tests/unit/agentic-process-switch-mode.test.ts`, `agentic-status.test.ts`, `worker-mode.test.ts`, `session-transport-gate.test.ts`, and `terminal-headless-roundtrip.test.tsx` | vitest unit/React | keep | These own downstream transport classification, switching, readiness, and skin remount semantics once a full entity is present. They neither create nor hydrate the entity and need no duplicate creation case. |
| Hub `vibe_ask_help_two_client.ui.test.ts` and `chat_terminal_switch_stress.ui.test.ts` | browser/hub | keep | Both call the same shared factory and then exercise collaboration or live switching. Their active WebSocket makes them especially likely to receive the full save broadcast first, so they are broad consumers rather than deterministic response-contract owners. |

## Regression pass/fail contract

The deterministic action-level assertion should use the existing cheap
`_scan_create_process` fixture and inspect both the constructed entity and the
returned payload:

- request an explicitly headless transport (or retain the existing
  `output_format="stream-json"` headless request);
- assert the captured saved process has `pty_mode is False`;
- assert `resp.data` is a full entity-shaped mapping with the same `id` and
  `type`, `pty_mode is False`, and `visible is False`;
- preserve the Vitest API test's returned-object assertion and independent GET
  assertion.

Pass: request, saved Python entity, action response, hydrated TypeScript entity,
and reloaded durable row all agree on `pty_mode=false`.

Fail: the action response omits the field; hydration depends on a WebSocket
race; `spawn()` returns true; the follow-up save flips the durable row; or a
reload reports true. No sleep, retry, poll, timeout increase, cache warming, or
WebSocket ordering control is part of this contract.

## Mandated layer audit

| Layer | Signal and disposition |
|---|---|
| `tests/unit/` | Modify the existing real-action headless test to pin the authoritative response. Existing status, serializer, recovery, and stream-json tests remain valid. |
| `tests/api/` | Keep Python headless entity round trips and routing tests. No second Python HTTP test is needed once the real action method has a deterministic response assertion and the Vitest API case crosses HTTP. |
| `tests/long_tests/` | Keep the vendor/transport matrix and its independent persisted GET; update only its obsolete minimal-response comment. |
| `ui/tests/unit/` | Keep request-intent and downstream transport tests. No mocked spawn-only override test should be added because that would bless logic at the wrong seam. |
| `ui/tests/api/` | Keep both assertions in `agentic_spawn_pty_mode`; update its stale cause prose. Keep the `setVisible` suite for its separate invariant. |
| `ui/tests/react/` and `ui/tests/long_tests/` | Existing rendering and worker lifecycle coverage consumes `pty_mode` after creation. Add no slower duplicate of the action/hydration contract. |
| `ui/tests/headless/` | No direct factory-response case. The live API test is narrower and already exercises the same TypeScript SDK plus backend. |
| `ui/tests/hub/` and `hub_playwright/` | Keep collaboration and rapid-switch consumers; no hub-specific creation contract exists because the local ComputeNode action owns minting. |
| `ui/tests/e2e/`, `manual_regression/`, and fast paths | No exact factory-response scenario exists. Add none: returned object plus durable row are observable deterministically below the browser. |

## Documentation review

`docs/interface/agentic-process.md` is stale in two opposing ways: its
`createProcess` table promises “Returns the entity,” while the implementation
returns only four identity/runtime fields; later it incorrectly says
`spawn({headless:true})` never sets `pty_mode`, although current `spawn`
explicitly passes `false`. Correct the spawn section to state the request and
durable-response invariant, and retain the full-entity action return as the
authoritative contract.

`docs/interface/compute-node.md` already types the frontend factory as returning
`AgenticProcess` but does not say that the action response must be a complete
entity. Clarify that explicit false fields survive response hydration and that
the result must not depend on a WebSocket broadcast winning a race.

## Summary

- Classification: production action-response/schema regression; race-sensitive symptom, deterministic contract violation
- Keep: the failing Vitest API behavior, persisted visibility precondition, Python persistence/routing, long vendor matrix, and downstream transport tests
- Modify: 1 existing Python action test for response completeness; comments in 2 existing tests
- Add: 0 new test files or browser scenarios
- Remove: 0
- Product change required: yes, at the shared backend `createProcess` response seam
- Confidence: HIGH

# Coverage Analysis — Phase 5 aggregate-scan progress vs global WS jobs — 2026-07-28

## Failure classification and contract owner

This is deterministic live-test contract drift exposed by a legitimate
concurrent startup job, not an aggregate-scan emitter defect.

The machine-readable artifact
`ui/tests/manual_regression/_results/2026-07-28T16-05-04Z/phase5-vitest-api-pass.json`
fails `progress_report_fast.test.ts:145` through `assertTableShape():88`: the
collector expected every table received while its scan request was open to have
`job_name="scan"`, but one table had `job_name="index"`.

The cycle-owned backend log and manager timestamp correlation identify that row:

```text
fresh ComputeNode WS accepted
startup system-content index emits progress
POST three test skills
[fs-records] system-assets index complete
GET .../fs-records/scan?trigger=manual&limit_types=5 -> 200
```

`flow_sdk/server/app.py:_start_system_content_index()` deliberately starts that
index as a detached startup task.
`resource_tracker.py:broadcast_progress()` sends every progress report to every
active connection without a watcher filter, and the envelope carries no request
or run id. The manual scan handler and `FSIndexer.scan()` still emit
`job_name="scan"` exclusively; the observed `index` terminal table belonged to
the startup index.

The protocol's `job_name` is a phase discriminator, not complete operation
correlation. In particular, an aggregate index forwards its inner discovery
tables as `job_name="scan"` before emitting its own `index` tables. Filtering a
live feed by job name is therefore necessary for the current failure but is not
a proof that every retained table came from the initiating HTTP request.
Deterministic ownership of one operation's exact sequence belongs in the
isolated handler/Python wire tests; the shared-backend Vitest and browser tests
are live integration smokes and must tolerate unrelated global reports.

Likely change owner: the unfiltered Vitest collector/assertions (and its stale
Playwright counterpart), not the scan/index production emitters. No product
change is required for this failure.

## Existing coverage disposition

| Test / mechanism | Type | Status | Exact disposition |
|---|---|---|---|
| `ui/tests/api/progress_report_fast.test.ts` — aggregate scan, scan monotonicity, and per-type scan cases | vitest-api | modify | Derive `scanTables = tables.filter(t => t.job_name === "scan")` in all three scan cases, require it to be non-empty, and apply shape/total/monotonic/final-row assertions only to that sequence. The aggregate case's current assertion over every global report is invalid. Do not increase the existing settle or 30-second budgets and do not add an idle poll to wait out startup. |
| The aggregate-index and per-type-index cases in the same file | vitest-api | keep | They already select `job_name === "index"` where needed and pin index table bounds plus terminal completion. Preserve the comment that forwarded scan snapshots are valid. |
| `tests/long_tests/test_progress_report_fast.py` | pytest-long/API wire | keep | This is the deterministic wire owner. Its `no_startup_system_index` fixture documents the exact no-run-id aliasing and suppresses the foreign producer; `_progress_events(..., job_name)` filters reports before asserting shape, monotonicity, and terminal state. |
| `tests/unit/test_fs_store/test_scan_handler.py::test_scan_handler_emits_table_snapshots` | pytest-unit | keep | Directly owns the scan handler's initial/terminal `job_name="scan"` snapshots and `total=0` contract with a captured broadcaster. It proves the production scan emitter did not produce the observed `index` table. |
| `tests/unit/test_fs_store/test_index_handler.py::test_index_handler_emits_table_snapshots` and indexer progress-table tests | pytest-unit | keep | Own index-phase shape, totals, and completion independently of the shared live feed. |
| `tests/api/test_fs_records_scan_search.py`, `tests/long_tests/test_fs_scan_aggregate.py`, and `ui/tests/api/fs_records_scan_search.test.ts` | pytest/vitest API | keep | Own scan response structure and scan→index→search behavior. They do not inspect WS provenance and need no change. |
| `ui/tests/e2e/index-search/scan_index_progress_events.md(.ts)` aggregate WS case | Playwright scenario | modify | The prose repeats the invalid “every captured event is scan” assumption. The implementation also registers `page.on("websocket")` after `page.goto()` opened the app socket and never asserts a non-empty table list, so it can pass vacuously. Register capture before navigation/connection, select scan-labelled reports, require at least one valid scan table and a terminal scan snapshot, and update the paired `.md` expectation. |
| `ui/tests/manual_regression/search/rebuild_index_ui.md(.ts)` and `search_scan_info_stats.md(.ts)` | manual/Playwright | keep | These exercise the user-visible foreground phase sequence, status restoration, and rebuild HTTP chain. They are orthogonal to raw event provenance and remain the browser-level UI owners. |
| `SystemToolsService` mismatched-job guard (`ts_sdk/src/services/system-tools-service.ts:187-200`) | frontend SDK | coverage gap | Production already preserves a locally selected foreground phase by discarding reports whose `job_name` differs, but no unit/API/React test directly pins this branch. Add the narrow unit regression below. |

## New regression required

Add one `vitest-unit` case for `SystemToolsService` progress arbitration; no new
backend or live API scenario is needed.

Precondition: a fresh service has foreground `currentActivity="scan"` and an
existing scan progress table. Action: deliver a structurally valid global
`progress_report` with `job_name="index"`, followed by a matching
`job_name="scan"` report, through the mocked `ConnectionManager` event channel.

Pass criteria:

- the foreign index report does not change `currentActivity` or
  `progressTable`;
- the matching scan report replaces the table wholesale and retains
  `currentActivity="scan"`;
- no timer, retry, sleep, polling, or network wait is required.

Fail criteria:

- the foreign report changes the foreground phase/table or arms completion for
  the wrong job;
- the matching scan report is ignored or merged with the previous table.

This test pins the actual frontend consumer policy. Do not add a run-id
assertion to current wire tests: no such field exists, and introducing one would
be a separate protocol design change rather than a regression fix.

## Mandated layer audit

| Layer | Signal and disposition |
|---|---|
| `tests/unit/` | Scan and index handler emitters are already covered independently and correctly filter captured reports by job name. Keep; no Python addition. |
| `tests/api/` and `tests/long_tests/` | Response behavior is covered; the isolated Python WS suite explicitly suppresses startup index aliasing. Keep. |
| `ui/tests/unit/` | Add the single `SystemToolsService` foreign-job arbitration case. Existing process-status `progress_report` coverage is a different payload kind. |
| `ui/tests/api/` | Modify the three scan consumers in `progress_report_fast.test.ts`; keep index and response suites. |
| `ui/tests/react/` and `ui/tests/long_tests/` | No direct raw system-progress consumer test. Adding a component duplicate would provide less precise signal than the service unit. |
| `ui/tests/headless/` | No relevant scan/index progress case; add none because the service reducer can be tested without a live app/backend. |
| `ui/tests/hub/` | Not applicable: Hub mode has no local fs-records activity endpoint or local indexer. |
| `ui/tests/e2e/index-search/` | Modify the paired progress scenario/test so capture is non-vacuous and global reports are filtered by intended phase. |
| `ui/tests/manual_regression/` | Keep the existing rebuild/status/browser scenarios; they own visible behavior, not raw report provenance. |
| `ui/tests/manual_regression/_fast_paths/` and repo `_fast_paths/` | No relevant fast path exists; add none. |

## Documentation review

Corrected `docs/data-management/system-tools.md`. It previously said only one
system activity runs at a time and that consumers replace state from the latest
event without qualification. The implementation and this run prove that only
same-name jobs conflict, scan and index may overlap, broadcasts are global and
uncorrelated by run id, and the service ignores mismatched reports while a
foreground phase is selected.

## Summary

- Keep: deterministic Python scan/index emitter and wire tests, index-side
  Vitest cases, response tests, and user-visible rebuild/status coverage
- Modify: the 3 live Vitest scan consumers and the paired legacy Playwright
  progress scenario/test
- Add: 1 frontend service-unit regression for foreign-job arbitration
- Remove: 0
- Product change required for the observed failure: none

# Coverage Analysis — Phase 5 project-URL tab materialization vs opened-tab reuse — 2026-07-28

## Failure classification

This is deterministic test-contract drift introduced after the already-open content-asset fast path landed, not a failure to materialize a project-scoped tab before its Markdown target exists.

The machine-readable failure is at `tab_project_heal.test.ts:80`, the **second** `loadTabProjectId(dock)` call, after the Markdown has been created. The first missing-target assertion at line 72 passed. The owned backend log confirms that cold sequence:

```text
GET markdown/<id> -> 404
GET tab/list_all -> 200
POST tab/new_tab -> 200
GET tab/list_all -> 200
POST tab/<id>/activate -> 200
```

Thus the URL-authority contract worked: the missing-target tab was created, returned, and stamped with the existing project named by its pointer.

On the second same-client call, `setupTab` sees the same content-asset key in lifecycle state `Opened` and deliberately takes `tab-lifecycle.ts:281-299`: activate the retained `tabId`, rerun the content adapter, perform no list/new-tab round trip, and return `{tab: null}`. The log shows only the activation after the Markdown POST. `dataManager.clearCache()` does not reset the separate lifecycle registry, so the test's “fresh target fetch on reload” comment is incorrect; the no-op adapter also fetches no target. `loadTabProjectId()` therefore mistakes the documented reuse return shape for failed materialization.

## Existing coverage disposition

| Test / mechanism | Type | Status | Exact disposition |
|---|---|---|---|
| `ui/tests/api/tab_project_heal.test.ts::a project-scoped URL adopts its declared project immediately, before the target exists` | vitest-api | modify | Preserve the cold missing-target half, which is the only behavior named by the test and already passed. Assert the first `setupTab` result directly and the persisted `Tab.listAll()` row. Remove the later target-create/reopen phase: it neither rematerializes nor resolves the target, so it cannot prove the comment's “confirmed by the target” claim. |
| The two dead-project URL cases in `tab_project_heal.test.ts` | vitest-api | keep | They cover the distinct negative contract: nonexistent URL project ids leave no persistent tab and cannot be returned by project-entry resolution. Their assertions already read durable list state instead of requiring every `setupTab` call to return a row. |
| `ui/tests/unit/tab-lifecycle.test.ts::reuses an opened content-asset tab while rerunning loader-owned context setup` | vitest-unit | keep | Directly pins the fast path responsible for the second call: loader setup runs, list/remint do not, and lifecycle remains `Opened`. This is sufficient unit ownership of reuse; no second unit scenario is needed. |
| `tests/unit/test_project_dock_tab_project.py::test_project_dock_tab_inherits_pointer_project` | pytest-unit | keep | Pins backend read-time URL-authority backfill for an existing projectless row with a missing Markdown target. The live Vitest API cold assertion supplies the complementary create/materialize path. |
| `tests/unit/test_tab_entity.py` project backfill, reconciliation, missing-project, and orphan cases | pytest-unit | keep | Covers server target/pointer project derivation, target project reconciliation, dead-project cleanup, and the rule that a missing Markdown target is not an orphan. These contracts remain green and orthogonal to the frontend reuse return value. |
| `ui/tests/react/dock-dead-scope-tab-setup.test.tsx` | vitest-react | keep | Exercises the real route loader for an unsatisfiable scope and accepts either open or redirect. It concerns a nonexistent scope project, not an existing project with a temporarily missing content target. |
| Project scope/recency suites (`project_switch_scope_entry`, `project-chip-cross-project-clobber`, `tab-select-stamps-tab-recency`, `tab-project-filter`) | vitest unit/api/react | keep | Pins project filtering, project propagation, scope entry, and recency after materialization. None requires `TabSetupResult.tab` to be populated on an already-open content reuse. |
| `ui/tests/api/tab_project_heal_rca.test.ts` | temporary RCA switch | remove after RCA | The untracked on/off switch proves the fast-path discriminator (`parentTabId: null` bypasses it) and durable row remains correct. It duplicates the existing lifecycle unit plus API invariant and should not become a permanent test. |

## Exact modification and pass/fail criteria

Keep one behavior in the first API case:

1. Create a real project and a project-scoped Markdown dock whose target ID has no entity row.
2. Call `setupTab` once with the no-op adapter.
3. Assert `error` is absent and the returned cold-load `tab` is non-null.
4. Assert its `project_id` equals the URL project, its `target_type` / `target_id` equal the missing Markdown identity, and its pointer still names that project.
5. Read `Tab.listAll()` and assert exactly one row with that dock `tabHash`, the same Tab id, and the same project id.

Pass: the cold call and durable global list contain one visible tab owned by the URL's existing project even though the target GET returned 404.

Fail: cold `tab` is null, `error` is set, no durable row exists, the row is projectless/wrong-project, target metadata is lost, or more than one row shares the dock identity.

Do not make the helper fall back silently from `result.tab` to `Tab.listAll()` for the cold assertion; that would let a real cold-return regression pass. Do not reset lifecycle or add a second test solely to force another materialization. Add no timeout, wait, retry, sleep, or cache polling.

## Mandated layer audit

| Layer | Signal and disposition |
|---|---|
| `tests/unit/` | Backend project/pointer backfill, reconciliation, and orphan semantics are already covered. Keep; no new pytest case. |
| `tests/api/` | No Python HTTP addition is needed because the failing Vitest API test already crosses the real `new_tab` / `list_all` wire and proves the cold missing-target contract. |
| `ui/tests/unit/` | Existing lifecycle test owns the opened-content reuse optimization. Keep; no duplicate. |
| `ui/tests/api/` | Modify only the stale first scenario in `tab_project_heal.test.ts` as specified; retain its two dead-project scenarios. |
| `ui/tests/react/` and `ui/tests/long_tests/` | Existing route/scope/project tests cover separate loader and lifecycle concerns. No addition. |
| `ui/tests/headless/` | No direct setupTab/project-heal case. A headless duplicate would detect the same backend/API behavior later than the current real-backend Vitest API case. |
| `ui/tests/hub/` | Hub runtime intentionally does not materialize local `Tab` entities; no applicable coverage. |
| `ui/tests/manual_regression/` | The terminal project-filtering matrix covers visible project chips and direct URLs with existing targets, not this transient missing-target seam. No manual addition: the exact 404 -> new_tab contract is deterministic at API level. |
| `ui/tests/manual_regression/_fast_paths/` and repo `_fast_paths/` | No relevant fast path exists; add none. |

## Documentation review

Updated `docs/tab-management.md` and `docs/agent-management/tabs-management.md` to record the already-open content-asset reuse return shape and the backend target/pointer project fallback. Both previously described every `setupTab` call as materializing and incorrectly said all project resolution lived in the frontend.

## Summary

- Keep: all backend project-heal/orphan tests, lifecycle reuse unit coverage, dead-project API cases, and orthogonal project scope/recency coverage
- Modify: 1 existing Vitest API scenario to assert the cold missing-target contract only
- Add: 0 regressions; the exact high-risk behavior is already covered and passed
- Remove: 1 temporary untracked RCA switch after the debugger finishes
- Product change required: none for this failure

# Coverage Analysis — Phase 5 DirectoryTree mount-root corruption — 2026-07-28

## Failure classification and proven trigger

This is a deterministic production storage-path regression exposed during API-test setup, before `DirectoryTree` renders. It is not a DirectoryTree interaction failure, an unavailable compute node, a timeout, or a reason to materialize the test mount manually.

The failing sequence is:

1. `get_local_compute_node()` saves a local ComputeNode with a fresh, not-yet-created `/tmp/flow-test-<uuid>` mount.
2. `fsManager.writeFile(computeNode, "/test-file.md", "# Test")` returns HTTP 200.
3. The resulting `/tmp/flow-test-<uuid>` is a six-byte regular file containing `# Test`, rather than a directory containing `test-file.md`.
4. `fsManager.mkdir(computeNode, "/test-folder")` then returns HTTP 500 because its parent mount is a file (`Errno 20`, not a directory).

The name is the discriminator. `LocalStorageDriver._local_full_path()` correctly strips the request's entity TypeId once, but `StorageDriver.get_storage_path()` sends the resulting relative `test-file.md` through `app2storage_path_format()`, which parses it as a VFS locator a second time. `test-file.md` happens to be a syntactically valid TypeId (`test` plus the property identifier `file.md`), so the second parse yields an empty entity subpath and resolves the write to the mount root. Existing filesystem tests use unambiguous names such as `written_file.txt`, `test_file.txt`, and `test.txt`, so they do not exercise this typed-locator -> ambiguous relative filename boundary.

The absent mount makes the corruption visible as a successful root-file write; it is not the root cause. Upload and mkdir already own parent materialization. Precreating the helper's mount would merely turn the same resolver defect into an earlier `IsADirectoryError`.

## Existing coverage disposition

| Test / mechanism | Type | Status | Exact disposition |
|---|---|---|---|
| `ui/tests/api/DirectoryTree.test.tsx::should display files and folders in the tree` | vitest-api | keep | Preserve the exact `test-file.md` write followed by sibling mkdir. It is the current live-backend canary and should pass after the storage fix; do not rename the file to avoid the parser ambiguity or weaken the assertions. The suite's later 227 pending cases must be rerun after this blocker is fixed because `bail=1` prevented meaningful coverage from them. |
| `ui/tests/utils/test-utils.ts::get_local_compute_node` | vitest shared fixture | keep | Keep the randomized non-existing mount. It validly exercises LocalStorageDriver's parent-materialization contract and isolates tests. Creating the directory in this helper is not a sufficient fix and would move, not resolve, the path bug. |
| `tests/api/test_unit_fs.py::TestLocalStorageDriver` | pytest-api, narrow driver contract | add one case | This is the earliest existing owner for typed VFS resolution plus real LocalStorageDriver operations. Its current upload/write cases use an already-created `tmp_path` mount and filenames that cannot be mistaken for a TypeId. Add the focused regression below. |
| `tests/api/test_storage.py::TestLocalStorageDriver` and `tests/api/test_fs_integration.py` | pytest-api | keep | These already cover ordinary create/upload/download/list/copy/move behavior against created temporary roots. Their unambiguous paths do not cover the double-parse edge, and duplicating the new matrix here adds no distinct signal. |
| `tests/api/test_vfs_path_consolidation.py` and `tests/api/test_unit_fs.py::TestVFSPathBasic` | pytest-api | keep | They correctly pin a context-free parser and explicit request qualification. Do not “fix” this by globally requiring bare `test-file.md` to parse as a filename: a standalone TypeId is allowed by the grammar. The storage boundary knows that the value is already an entity subpath and must preserve it as such. |
| `ui/tests/api/fsService.test.ts` | vitest-api | keep | Covers real SDK write, list, mkdir, and end-to-end workflows through embedded Workspace storage, but uses `test.txt`, underscore names, and separate tests. It cannot detect the ComputeNode mount-root corruption. A second FSManager scenario would duplicate the existing DirectoryTree canary rather than catch the bug at its owner. |
| `ui/tests/react/unit/directory-tree.test.tsx` | vitest-react unit | keep | Mocked component coverage for selection, actions, states, navigation, and multiple roots is orthogonal; the Phase 5 failure occurs before component render. |
| ComputeNode PTY/API/long tests that consume `get_local_compute_node` | vitest-api / react / long | keep | They exercise provider setup, shell, replay, and recovery paths, not entity filesystem operations. A valid provider working directory does not prove the separate `fs_storage_mount_path` contract. |

## Required regression

Add one behavior-level case to `tests/api/test_unit_fs.py::TestLocalStorageDriver`; no new test file and no new UI scenario are needed.

Construct a `LocalStorageDriver` whose mount is a non-existing child of `tmp_path`. Build the same request-shaped locator produced by `EntityFSReqInfo`, using a TypeId whose entity ID comes from `mint_uuid()` and the entity subpath `test-file.md`. Upload `BytesIO(b"# Test")`, then create the typed sibling path `test-folder`, and list the typed root.

Pass criteria:

- the mount becomes and remains a directory;
- `<mount>/test-file.md` is a regular file containing exactly `# Test`;
- `<mount>/test-folder` is a directory;
- listing the entity root returns both children with the correct file/directory kinds.

Fail criteria:

- the mount itself becomes a regular file or receives the uploaded bytes;
- the upload targets the root / raises because the root was precreated;
- the sibling mkdir raises `ENOTDIR` or returns a 500-equivalent failure;
- either child is absent or has the wrong kind.

Use no retries, sleeps, polling, or timeout changes. This test should exercise public upload/create/list behavior rather than pinning `_local_full_path()` directly.

## Mandated layer audit

| Layer | Signal and disposition |
|---|---|
| `tests/unit/` | No new case. Unit tests around asset versioning and embedded blob consumers use stand-ins or already-materialized, unambiguous paths; they do not own LocalStorageDriver's real path conversion. |
| `tests/api/` | Add the single driver regression in `test_unit_fs.py`; keep the parser, storage, and FS integration suites. This is the narrowest layer that reproduces the production defect with the real driver. |
| `ui/tests/unit/`, `api/`, `react/`, `long_tests/` | Keep existing component, FSManager, DirectoryTree, PTY, and shell coverage. The current DirectoryTree case is sufficient upper-layer confirmation; add no duplicate Vitest test. |
| `ui/tests/headless/` | No relevant storage-driver or DirectoryTree path coverage; add none. |
| `ui/tests/hub/` | Filesystem-bearing Hub tests create/materialize their workdirs directly and cover sharing/collaboration contracts, not LocalStorageDriver path parsing; add none. |
| `ui/tests/manual_regression/` | `assets/vfs_files_tree_selection.md(.ts)` covers browser selection/navigation and creates its project root with Node filesystem APIs. Keep it; this backend resolver regression is better caught deterministically below the browser. |
| `ui/tests/manual_regression/_fast_paths/` and repo `_fast_paths/` | No relevant fast path exists; add none. |

`docs/vfs.md` remains consistent: it defines the parser as context-free, assigns request qualification to `EntityFSReqInfo`, and identifies LocalStorageDriver as the storage boundary. The defect violates that separation by reparsing a known entity subpath; no documentation change is required.

## Summary

- Keep: the existing DirectoryTree live-backend reproducer and all orthogonal parser, SDK, component, PTY, Hub, and manual coverage
- Add: 1 narrow LocalStorageDriver regression in `tests/api/test_unit_fs.py`
- Modify/remove: 0 existing test scenarios for coverage purposes
- Re-run requirement: the full Phase 5 Vitest API phase after the production fix, because 227 assertions were not executed after the first failure

# Coverage Analysis — Phase 1 registry guards: Wiki entity types and `flow terminal` — 2026-07-28

## Failure classification

Both failures are deterministic review guards doing useful work, not runtime, infrastructure, or timeout failures.

- `EntityType` added the persisted pairs `WIKI = "wiki"` and `WIKI_ENTRY = "wiki_entry"`, while the exhaustive expected map in `tests/unit/test_fs_store/test_entity_type_enum.py` remained stale. The exact-equality guard correctly forced an explicit review of the two additions; no existing pair changed, so no migration or production rollback is indicated.
- `flow_sdk/cli/flow_cli.py` registered the new top-level `terminal` group, while the transcript analyzer's intentionally static `_FLOW_VERBS` mirror omitted it. The guard correctly exposed a user-visible semantic regression: a real `flow terminal ...` invocation would execute, but live and replayed transcripts would classify it as a generic shell command instead of a `FlowCommandEntry`.

## Existing Tests

| Test | Type | Category | Status | Notes |
|------|------|----------|--------|-------|
| `tests/unit/test_fs_store/test_entity_type_enum.py:188-194` — `test_entity_type_values_frozen` | pytest-unit | schema/type values | modify | Keep the exact dictionary equality. Add only `"WIKI": "wiki"` and `"WIKI_ENTRY": "wiki_entry"` to `EXPECTED`; this records the additive persisted values while continuing to catch renames, removals, and future unreviewed additions. |
| `tests/unit/test_fs_store/test_entity_type_enum.py:197-205` — back-compat aliases | pytest-unit | schema aliases | keep | Proves `RecordType`, `BuiltinEntityType`, and `SkillitRecordType` are the canonical `EntityType` class. The two additions therefore propagate through every Python alias without a second mapping. |
| `tests/wiki/test_wiki_entities.py:58-104` — default Wiki, bind/unbind, explicit resolution | pytest-unit | Wiki namespace entities | keep | Exercises real `Wiki` and `WikiEntry` entities, stable identity, DB-only storage, explicit binding precedence, and `WikiEntry` materialization. This is behavioral support for both newly enumerated values, not a snapshot duplicate. |
| `tests/api/test_wiki_entity_actions.py:13-38,51-104` — canonical graph actions | pytest-api | Wiki graph API | keep | Drives the live graph registry through `project/.../default-wiki`, `graph/wiki/.../resolve`, bind, and unbind. It asserts the returned namespace type is `wiki`; the bind path plus the entity test cover `wiki_entry` materialization. |
| `tests/api/test_hub_wiki_cache.py:15-85,88-140` | pytest-api | Wiki Hub bridge | keep | Uses `BuiltinEntityType.WIKI` through the compatibility alias and proves remote Wiki metadata is cached under the canonical `wiki` entity type without creating a filesystem record. |
| `ui/tests/unit/wiki-sdk.test.ts:27-144` and `wiki-loader.test.ts:27-83` | vitest-unit | Wiki SDK/routing | keep | The TypeScript registry already exposes `Wiki` / `WikiEntry`; these tests pin action URLs, `WikiEntry` hydration, default-Wiki registration, local/Hub resolution, and loader behavior. No TypeScript enum update is missing. |
| `tests/unit/test_transcript_analyzer/test_flow_command_derive.py:197-215` — real-CLI drift guard | pytest-unit | transcript CLI registry | modify | It correctly caught the missing `terminal` mirror entry. After `_FLOW_VERBS` is updated, compare both directions (`registered == _FLOW_VERBS`) and report missing versus stale entries separately; the current subset assertion cannot catch a removed CLI verb that the analyzer would continue to misclassify as valid. |
| `tests/unit/test_transcript_analyzer/test_flow_command_derive.py:69-183` — cross-worker derivation | pytest-unit | transcript semantics | modify | Keep all generic positive, negative, purity, and FlowData-shape assertions. Add the terminal-specific regression below; current positives use `show`, `record`, `navigate`, and `context`, so the guard can pass after a set edit without ever proving a `flow terminal` entry's semantic shape. |
| `tests/unit/test_transcript_analyzer/test_derive_history.py:86-157`, `test_claude_event_to_flowdata.py:289-364`, and `test_codex_copilot_event_to_flowdata_derive.py:65-102` | pytest-unit | live/replay parity | keep | Proves the shared derivation reaches full load, delta refold, and live converters for Claude, Codex, and Copilot. These use `flow show`, but once the terminal primitive is pinned they provide sufficient path coverage because every path calls the same `derive_entry`. |
| `ui/tests/unit/tool-event-descriptor.test.ts:42-67` | vitest-unit | flow-command presentation | keep | Pins clickable targeted flow commands and targetless flow-command rendering. `flow terminal` is targetless under the current grammar, so a second UI case would duplicate the generic verb-based renderer. |
| `tests/unit/test_agent_terminal_reuse.py:33-69`, `tests/unit/test_display_target_shell.py:70-110`, and `ui/tests/unit/run-in-terminal.test.ts:54-138` | pytest-unit / vitest-unit | terminal execution seam | keep | Covers terminal reuse safety, the Python/TypeScript sentinel grammar, captured output, exit status, and missing-shell behavior. These tests validate the command's execution seam; they do not replace transcript classification coverage and need no changes for either guard failure. |

## New / Modified Coverage Required

| Priority | Category | Type | Scenario | Pass Criteria | Fail Criteria |
|----------|----------|------|----------|---------------|---------------|
| High | terminal transcript derivation | pytest-unit | Add one `WORKERS`-parameterized case beside the existing positives in `test_flow_command_derive.py`: derive `flow terminal run 'npm test'` from the Claude `ShellCommandEntry`, Codex shell argv, and Copilot bash tool shapes. | Every worker yields a `FlowCommandEntry` with `verb == "terminal"`, `subverb is None`, `target is None`, and `flow_args` retaining `run` plus the quoted command. | Any worker remains a `ShellCommandEntry`/generic `ToolUseEntry`, loses the command arguments, or invents a clickable target. |
| Medium | CLI mirror drift | pytest-unit | Strengthen `test_flow_verbs_match_the_real_cli_registry` from one-way subset to exact set parity, with diagnostics for both `registered - _FLOW_VERBS` and `_FLOW_VERBS - registered`. | Adding a CLI verb without the mirror and removing a CLI verb without pruning the mirror both fail deterministically; `terminal` is present in both sets. | A stale analyzer-only verb passes, the test imports CLI code into production parsing, or the check is weakened to a count-only comparison. |

No new Wiki test is required for these additive enum pairs. The exhaustive freeze, real Python entities, canonical graph actions, Hub bridge, and registered TypeScript SDK already cover the distinct contracts. Updating only `EXPECTED` is the correct response to that guard.

## Mandated layer audit

| Layer | Direct signal for these failures | Disposition |
|------|------|------|
| `tests/unit/` | Owns both failing guards, the transcript derivation primitive/live/replay paths, and terminal execution seams. | Apply the two focused changes above; update the enum snapshot. |
| `tests/api/` | Strong Wiki namespace and Hub bridge coverage; no transcript classification is performed at HTTP level. | Keep; no added API test. |
| `ui/tests/unit`, `api`, `react`, `long_tests` | Unit tests cover Wiki SDK/loader and generic flow-command presentation. `ui/tests/api/wiki.test.ts` covers the separate occurrence-link graph; React/long tests do not inspect these registries. | Keep; browser/component duplication would not catch either static Python mirror earlier. |
| `ui/tests/headless/` | No direct Wiki enum or `flow terminal` transcript case. | No addition: both failure seams resolve before a live-backend UI round trip. |
| `ui/tests/hub/` | No direct registry case; Hub Wiki transport is already covered by pytest API and SDK unit contracts. | No addition. |
| `ui/tests/manual_regression/` | `wiki/wiki_link_layer.md(.ts)` exercises the separate occurrence graph/editor surface. No scenario asserts transcript semantic typing for `flow terminal`. | Keep existing scenarios; do not add a manual duplicate for static registries. |
| `ui/tests/manual_regression/_fast_paths/` | No relevant fast path. | No addition. |

## Summary

- Keep: 8 existing coverage groups
- Modify: 3 existing pytest guards/test groups
- Add: 1 terminal-specific cross-worker pytest case
- Remove: 0 obsolete tests

### Gap Assessment

Wiki has adequate cross-layer behavioral coverage; its Phase 1 failure is intentional exhaustive-snapshot friction and nothing more. Preserve the exact guard and record the two additive pairs.

The terminal failure exposed the only functional gap: registry membership is checked, but no terminal-specific transcript case proves the semantic result after the mirror is edited. Add that one cross-worker case. Tightening the registry assertion to exact parity also closes the stale-verb direction without adding runtime coupling, waits, retries, or browser coverage.

# Coverage Analysis — additive `EntityType.DECK` / `SPREADSHEET` freeze failure — 2026-07-14

## Existing Tests

| Test | Type | Category | Status | Notes |
|------|------|----------|--------|-------|
| `tests/unit/test_fs_store/test_entity_type_enum.py:104` — `test_entity_type_values_frozen` | pytest-unit | schema/types | modify | Correct exhaustive persisted-value guard. Its exact map comparison proved all 143 prior pairs unchanged and exposed only the additive `DECK = "deck"` and `SPREADSHEET = "spreadsheet"` pairs. Add those two pairs to `EXPECTED`; do not weaken the equality and do not add a migration. |
| `tests/unit/test_fs_store/test_entity_type_enum.py:113` — `test_back_compat_aliases_are_the_same_class` | pytest-unit | schema/types | keep | Pins `RecordType`, `BuiltinEntityType`, and `SkillitRecordType` to the canonical enum class; additions are therefore visible through every Python alias. |
| `tests/unit/test_fs_store/test_indexer_deck.py:83,89` — manifest adoption / absent-id mint | pytest-unit | fs_store/deck | keep | Proves a valid v4 manifest ID is adopted and an absent ID mints, persists, and reuses a v4 folder capsule. |
| `tests/unit/test_fs_store/test_folder_capsule.py:42,52,71` plus `tests/unit/test_fs_store/test_indexer_deck_template.py:116` | pytest-unit | fs_store/identity | keep | Shared helper used by Deck is pinned for valid adoption, v4 mint/idempotence, and rejection/remint of garbage and foreign UUID versions. A duplicate Deck-only v7 test is not required because `deck_gen_id` delegates the candidate unchanged to this helper. |
| `tests/unit/test_fs_store/test_indexer_spreadsheet.py:146` — `test_gen_id_is_stable_and_valid` | pytest-unit | fs_store/spreadsheet | modify | Already proves stable identity, `is_valid_entity_id`, and extractor/gen agreement. Add `uuid.UUID(first).version == 5` so the stable-path contract cannot regress from deterministic v5 to another conforming version. |
| `tests/unit/test_fs_store/test_spreadsheet_from_fs_ref.py:62,77` | pytest-unit | fs_store/spreadsheet | keep | CSV and XLSX typed loaders both produce a valid v4/v5 entity ID and agree with the indexer path. |
| `tests/unit/test_fs_store/test_adopt_or_mint_id.py:44,52,59` | pytest-unit | fs_store/identity | keep | Pins the central adopt policy across v4 accepted, v5 accepted, and v7 rejected; this covers the Python policy gate independently of either new type. |
| `ui/tests/unit/plan-pointer-roundtrip.test.ts:8` | vitest-unit | TypeId | keep | Constructs a `TypeId` with an explicit v5 UUID, so frontend v5 acceptance is already exercised. |
| `ui/tests/unit/test_typeid.test.ts:31-39` | vitest-unit | TypeId | modify | Direct validator suite pins v4 but has no syntactically valid v7 rejection case; add the focused negative case below. |
| `ui/tests/api/deck_entity_fe_contract.test.ts:25,29` | vitest-api | deck | keep | Against a live backend, asserts the `deck` literal is indexed and returned and that `RecordType.DECK` routes to the deck editor. This catches missing Python/TS feature wiring without duplicating the exhaustive enum snapshot. |
| `ui/tests/api/spreadsheet_entity_fe_contract.test.ts:27,33` | vitest-api | spreadsheet | keep | Against a live backend, asserts the `spreadsheet` literal is indexed/returned and that `RecordType.SPREADSHEET` plus CSV/XLSX paths route correctly. |
| `ui/tests/unit/spreadsheet-grid-and-routing.test.ts:27-50` | vitest-unit | spreadsheet | keep | Pins the TS record-type value's editor mapping and the registered `Spreadsheet.type === "spreadsheet"` entity contract. |

## New Tests Required

| Priority | Category | Type | Scenario | Pass Criteria | Fail Criteria |
|----------|----------|------|----------|---------------|---------------|
| High | TypeId policy | vitest-unit | Add `rejects a syntactically valid UUID v7 entity id` to `ui/tests/unit/test_typeid.test.ts`: construct `new TypeId('spreadsheet', '018f0000-0000-7000-8000-000000000000')` and check `isTypeId` for the combined string. | Constructor throws and `isTypeId(...)` is false; the existing v5 round-trip remains green. | v7 is accepted/classified as an entity UUID, or v5 becomes rejected. |

No new pytest-api, vitest-headless, vitest-hub, manual (`.md`), or fast-path test is required for this Phase 1 failure. Persisted enum values and ID mint/adopt rules are backend contracts, and the live-backend Vitest API tests already cross the relevant wire boundary. Browser duplication would not add a distinct failure signal.

## Summary

- Keep: 9 existing test groups
- Modify: 3 existing tests (record the two additive enum pairs; make Spreadsheet's v5 assertion exact; add the TypeScript v7 rejection case)
- Add: 1 focused Vitest unit case for v7 rejection
- Remove: 0 obsolete tests

### Gap Assessment

There is **no coverage gap for additive enum entries**. The exhaustive freeze is intentionally review-gated: it fails when a member is added, and updating `EXPECTED` records the new persisted value while continuing to pin every old value. The observed 143-common/2-additive diff proves this is snapshot drift, not a persisted-value mutation; `DECK` and `SPREADSHEET` need no migration and no production change.

Both new types already have dedicated pytest-unit coverage and real-backend Vitest API coverage. Deck's v4 capsule path and Spreadsheet's deterministic conforming path are exercised. The only policy gap found is independent of the freeze: TypeScript lacks a negative guard against re-admitting UUID v7, the exact validator-mismatch class called out by the repository's entity-ID policy. Add that one unit case; do not add redundant headless/manual scenarios for the enum snapshot.

# Coverage Analysis — TranscriptStreamer parity discovery / deleted sources — 2026-07-14

## Failure classification

The nine Phase 1 failures are a **pytest corpus-lifetime / TOCTOU failure**, not evidence of a production parser mismatch. `test_chunked_writes_match_full_parse` fails at `jsonl_path.read_bytes()` (`tests/unit/test_transcript_streamer/test_streamer_parity.py:192`), before it constructs the replay streamer or compares parser output. The same nine paths misleadingly pass `test_full_file_matches_streamed_delta`: both parsers tolerate the now-missing path as an empty transcript, so empty-versus-empty is reported as parity without exercising any bytes.

Discovery is frozen at collection time in `_DISCOVERED` (`test_streamer_parity.py:63-78`), but execution later dereferences those paths. The failed parameters were under the session-wide sandbox HOME (`tests/conftest.py:43-53`) and their encoded Claude project names point at pytest `tmp_path` roots for `test_share_create_bookmark.py` and `test_message_attachment_install.py`. Those test bodies create temporary `home` / `proj` directories but do not explicitly write transcript JSONL. The files were therefore accidental ambient artifacts produced during the wider run/runtime, not fixtures owned by the parity module; pytest cleanup could remove their underlying temp roots between collection and parity execution.

## Existing Tests

| Test / mechanism | Type | Category | Status | Exact coverage and limitation |
|------|------|----------|--------|-------|
| `tests/unit/test_transcript_streamer/test_streamer_parity.py:63-78` — `_discover_jsonl_files` and module-level skip | pytest-unit harness | parity discovery | modify | Samples up to 100 Claude and 100 Codex JSONLs from `Path.home()` and freezes path objects during collection. It neither owns nor snapshots source bytes, does not revalidate paths, and skips the whole module in a clean HOME. This is the uncovered discovery-to-read deletion window. |
| `test_streamer_parity.py:140-163` — `test_full_file_matches_streamed_delta` | pytest-unit | full-file parity | modify | Correctly checks structural entry parity for a live source. A deleted source becomes an empty baseline and empty stream, producing a false-positive pass; it must consume an owned/snapshotted non-empty case or explicitly skip a vanished ambient case. |
| `test_streamer_parity.py:166-227` — `test_chunked_writes_match_full_parse` | pytest-unit | chunked parity | modify | Correctly replays live bytes in ten line-aligned chunks and checks final internal state. Its unconditional source read at line 192 generated all nine failures. It creates only the replay destination at lines 200-203, after dereferencing the ambient source. |
| `tests/unit/test_transcript_streamer/test_cursors.py:100-104` — `test_missing_file_does_not_need_catch_up` | pytest-unit | missing file | keep | Covers registry cursor semantics when a path is already absent. It does not cover a source deleted after parity discovery or an attempted source-byte snapshot. |
| `tests/unit/test_transcript_streamer/test_partial_line_buffering.py:98-114` — `test_truncate_resets_state` | pytest-unit | mutation | keep | Covers shrink/rewrite of an existing file. Truncation is distinct from unlink between discovery and read. |
| `tests/unit/test_transcript_streamer/test_registry.py:98-129` and `test_eviction.py:43-55` | pytest-unit | registry lifecycle | keep | Covers explicit logical removal by session/path and PTY-close eviction. It does not exercise external filesystem deletion of a discovered source. |
| `tests/unit/conftest.py:106-139` — `write_claude_transcript` / `claude_projects` | pytest fixture | transcript corpus | keep | Creates useful temporary Claude transcripts for owning tests, but patches `claude_projects_dir` to `tmp_path`; it does not guarantee anything under parity's `Path.home()/.claude/projects` scan at collection. |
| `tests/unit/resources/transcripts/*.jsonl` plus transcript-analyzer/parser tests | pytest-unit | committed corpus | keep | The repository already owns representative Claude and Codex JSONL fixtures (including `claude_multi_block_message.jsonl`, `claude_with_exit_plan_mode.jsonl`, `codex_rollout.jsonl`, and `codex_stream_events.jsonl`). Parser tests consume them, but the parity gate does not, so a pristine run can skip instead of enforcing parity. |
| `test_share_create_bookmark.py:86-120` and `test_message_attachment_install.py:104-218` | pytest-unit | unrelated feature tests | keep | Their temporary `home` / `proj` roots correspond to the nine failed parameter names, but their assertions do not own parity inputs and must not be treated as transcript-corpus setup. No changes belong in these tests for this failure. |

## New / Modified Coverage Required

| Priority | Category | Type | Scenario | Pass Criteria | Fail Criteria |
|----------|----------|------|----------|---------------|---------------|
| High | deterministic parity corpus | pytest-unit | Modify parity case construction so at least one committed Claude fixture and one committed Codex fixture are always included; ambient HOME sampling remains optional supplemental fuzz coverage. Read each ambient file once into a case snapshot (path/worker/bytes), omitting or explicitly skipping only `FileNotFoundError` from a source that vanished during capture. Both parity tests must parse/replay the captured bytes, not later reopen the ambient source. | A clean HOME still executes non-empty Claude and Codex full/chunked parity; deleting an ambient original after capture cannot create a failure or an empty-versus-empty false pass. | The module can still skip all parity in a clean HOME, a parser comparison uses a vanished original, or broad exception handling hides malformed live data/parser errors. |
| High | discovery deletion race | pytest-unit | Add one focused test around the case-capture helper: create a discoverable JSONL, discover it, unlink it before capture, and assert it is classified as vanished/omitted without retry, sleep, or timeout changes. Also assert a live neighboring JSONL is retained with its exact bytes. | Deleted candidate is not emitted as a runnable empty parity case; live candidate is emitted unchanged. | `FileNotFoundError` escapes, deleted input is represented as `b""`, live input is dropped, or the fix adds retries/waits. |

No pytest-api, Vitest, headless, hub, or manual scenario is warranted. This failure is wholly inside pytest parameter/corpus ownership and occurs before production streaming behavior is exercised.

## Summary

- Keep: 6 existing coverage groups plus the 2 unrelated feature-test groups unchanged
- Modify: 3 parity harness/tests (`_discover_jsonl_files`, full-file parity, chunked parity)
- Add: 1 focused deleted-after-discovery unit case
- Remove: 0 tests

### Narrow recommendation

Guarantee the gate with committed Claude/Codex fixtures, and treat ambient machine transcripts as best-effort supplemental cases whose bytes are captured atomically before comparison. Handle only the expected `FileNotFoundError` race; do not catch parser failures, add retries, or raise any timeout. This both removes the nine first-time failures and closes the more serious false-pass/clean-HOME-skip gaps without changing production code.

# Coverage Analysis — Phase 3 Codex PTY update interstitial and false success — 2026-07-14

## Failure and current signal

`test_multi_turn_resumes_same_session[pty-codex]` reached the unchanged 30-second cap, but its assertions cannot distinguish a successful turn from an update/interstitial interaction: `_send_turn` returns on the first arbitrary `<flow-` frame, retries 409s and empty streams, and the test checks only that a session ID is stable. The proved launch correction is a process-local interactive Codex argument, `-c check_for_update_on_startup=false`; it must not mutate global Codex config or perform an update/install. Independently, `_run_pty_prompt` currently treats any user entry as the requested turn and synthesizes `outcome=success` on inactivity even when composer delivery failed.

## Existing coverage disposition

| Test / mechanism | Status | Exact disposition |
|---|---|---|
| `tests/unit/test_codex_cli_cmd.py` — interactive argv, permission variants, headless argv, and shell/spawn parity | modify | Preserve the exact-list and token-for-token assertions. Require the update-suppression `-c` pair exactly once in both bypass and non-bypass interactive argv; require it absent from headless `codex exec`; keep trust override conditional on bypass/workdir. This proves process-local launch behavior without touching `~/.codex/config.toml`. |
| `tests/unit/test_codex_pty_composer_gate.py` — real trust/composer captures and event-driven pump | keep + extend | Keep all trust rejection, composer acceptance, split-marker, history, PTY-close, and no-double-delivery cases. They correctly prove quiet output is not readiness, but the fixture corpus has no update-available screen. |
| `test_codex_pty_composer_gate.py` — `_typed_pty_delivery` wiring | keep | It already proves no write before composer, verbatim single delivery after composer, and no write when the gate returns false. It does not prove what the enclosing HTTP stream reports after `False`. |
| `tests/long_tests/test_pty_mode_matrix.py::test_prompt_streams_in_both_transports` and `tests/long_tests/test_agentic_process_prompt_streaming.py::test_prompt_admits_visible_process_via_pty_transport` | keep as smoke | These retain useful real-CLI endpoint/transport admission coverage. An arbitrary flow frame is intentionally not accepted as proof of prompt delivery, assistant output, or success. |
| `tests/long_tests/test_pty_mode_matrix.py::test_multi_turn_resumes_same_session` | modify | This is the correct real-CLI cross-vendor matrix, but its Codex PTY row needs transcript-level proof and proof-based stream stopping instead of generic-frame success. Keep the 30-second cap unchanged. |
| `ui/tests/react/ChatComposerBar.test.tsx` | keep | Correctly pins frontend busy/idle disabling. Vendor TUI interstitial readiness belongs to the backend driver/shell gate, so this component test must not duplicate or infer it. |

No existing unit test drives `_run_pty_prompt` through mismatched/no user entries or a composer-gate failure; that is the material success-semantics gap.

## Required changes and additions

| Priority | Change | Strong pass criteria |
|---|---|---|
| High | Modify the exact interactive argv tests. | Bare interactive Codex contains exactly one `check_for_update_on_startup=false` process argument for fresh and `resume` launches, including non-bypass mode; headless argv contains none; shell-string tokens still equal spawn argv. No test or implementation writes global config or invokes an updater. |
| High | Add `codex_pty_update_screen.bin` from the proved raw update interstitial and one sibling pattern/pump test. | The capture asserts recognizable update text and does not satisfy composer readiness; feeding update then composer returns ready only after the composer chunk. Trust and update screens both cause zero typed submissions when the PTY closes there. No polling or sleep is added. |
| High | Add focused `_run_pty_prompt` semantics tests with deterministic fake transcript/composer events. | (1) A partial or different `USER_MESSAGE` does not set the submitted turn as landed and inactivity yields an error result, never success. (2) `_typed_pty_delivery=False` yields an explicit delivery/composer error and no write, rather than waiting into synthetic success. (3) Only an exact submitted user entry (limited to documented normalization) permits inactivity success; its assistant flow data is preserved. Drive the terminal decision directly/fake the clock—do not add a real wait, timeout, retry, sleep, or backoff. |
| High | Strengthen the Codex PTY row of `test_multi_turn_resumes_same_session`. | Use two unique prompts and two unique exact reply markers; read each stream until its expected assistant marker, not the first flow tag. Resolve/read the transcript once after each proven reply and assert ordered, exact counts: user prompt 1 once, reply 1 once, user prompt 2 once, reply 2 once; assert the same non-empty session ID after each turn. A truncated/foreign user entry, interstitial choice, missing reply, duplicate turn, or fake success fails. Replace `_send_turn`'s 20-attempt/1-second retry loop and `_settle_session_id`'s polling with proof-based streaming and one post-reply GET; do not raise the 30-second cap. |

## Summary

- Keep: composer pump/delivery coverage, both real-CLI admission smokes, and frontend busy gating
- Modify: Codex interactive/headless argv assertions and the real-CLI multi-turn matrix
- Add: one real update-screen fixture regression plus deterministic PTY success/error semantic cases
- Remove: 0 tests; remove only the multi-turn helper's retry/sleep and session polling machinery
- Add no timeout, wait, retry, sleep, or backoff; do not change any existing cap

# Coverage Analysis — Phase 3 restart-required transport exclusions and WS attribution — 2026-07-14

## Failure and current signal

`test_restart_required_full_cycle[codex]` stalled on its final `cli_config.ephemeral=false` positive case because the WebSocket correctly broadcast `restart_required=false` and the test discarded that message while waiting for `true`. `json_stream=false` appeared to pass only because its shallow `cli_config` replacement removed the previously tracked `skill_names`, creating unrelated drift. The production contract and unit tests already agree that `json_stream`, `ephemeral`, and `pty_mode` are transport-derived and must not affect either restart comparator.

## Existing coverage disposition

| Test / mechanism | Status | Exact disposition |
|---|---|---|
| `tests/long_tests/test_restart_required_ws.py::test_restart_required_full_cycle` | modify | Keep the positive mutate -> WS true -> resync -> WS false cycle, but remove `cli_config.json_stream`, `cli_config.ephemeral`, and `pty_mode` from the positive matrix. Merge nested `cli_config` mutations into current config so each label changes only its intended key. Match each WS message on that exact field/value and expected flag, not on `restart_required` alone. |
| `test_restart_required_ws.py::test_negative_field_does_not_flip` | modify | Reclassify those three Codex cases here. Match dotted nested values rather than whole-object/shallow-replacement artifacts; assert the written value is present while `restart_required` remains false. |
| `tests/unit/test_agentic_process_restart_snapshot.py::test_pty_mode_changes_codex_launch_shape_but_never_restart_hash` | keep | Already gives the essential raw-payload discriminator: PTY/headless changes `ephemeral/json_stream`, while the filtered hash is identical; it also pins `visible` and Claude parity. |
| `tests/unit/test_agentic_process_restart_info.py::test_diff_helper_ignores_transport_derived_worker_fields` and `test_transport_switch_does_not_change_restart_hash` | keep | Pins both comparator paths to the shared exclusion set and proves `restart_info.changed == []` for the Codex transport flip. |
| `tests/api/test_agentic_process_execute.py::test_r03_no_phantom_restart_across_transport_and_turns` | keep | Retains API lifecycle coverage that transport/session changes do not create phantom drift and that genuine config drift survives session adoption. It is complementary to, not a substitute for, WS attribution. |
| Remaining restart WS edge tests plus `ui/tests/react/unit/CommandStatusViewer.test.tsx` | keep | The running gate, external set/clear, no-op, consecutive mutations, start-lifecycle guard, and UI rendering are orthogonal and remain valid. |

## Required matrix correction

1. Move `cli_config.json_stream=false`, `cli_config.ephemeral=false`, and `pty_mode=true` from `CODEX_TRACKED_MUTATIONS` to `CODEX_NEGATIVE_MUTATIONS`; delete no test case—the three rows become explicit negative regressions.
2. Before every nested positive PUT, merge the requested key into the entity's current `cli_config`. This prevents clearing `skill_names` (or any prior tracked key) from supplying the `restart_required=true` signal for a transport-only label.
3. Attribute positive WS events to the mutation: require the exact top-level or dotted `cli_config` field/value *and* `restart_required=true`. Attribute the resync event to the returned `last_started_hash` (or the exact current field/value) *and* `restart_required=false`. Do not accept a delayed update solely because its flag matches.
4. For each reclassified negative row, require the PUT response/WS payload to show the intended raw change, then assert both `restart_required=false` and `restart-info.changed == []`. This proves the mutation happened and was excluded; a no-op cannot pass.

## Summary

- Keep: both unit comparator contracts, API transport/session lifecycle coverage, WS edge cases, and UI rendering
- Modify: the two existing long-test matrices and their field-aware WS predicate/mutation helper
- Add: 0 new test files or scenarios; the existing negative parametrization is the strongest home for all three regressions
- Remove: 0 tests; reclassify 3 stale positive rows as negative rows
- Keep `_WS_DRAIN_LIMIT` and every 30-second cap unchanged; add no wait, timeout, retry, sleep, backoff, or extra polling

# Coverage Analysis — Phase 6 project-scoped tab materialization and recency — 2026-07-14

## Accepted RCA and coverage boundary

The Phase 6 failure in `ui/tests/react/tab-select-stamps-tab-recency.test.tsx` is harness drift, not a production regression. The mocked `new_tab` response discarded `action.bodyParameters.project_id` and manufactured the new process Tab with `project_id: null`; the real project-scoped strip then correctly excluded that row. The one-field control that returned the posted `PROJECT_ID` passed, while production `Tab.getFromDockPointer` / `Tab.newTab`, tab materialization, process-loader selection, and `Tab.activateById` remained correct.

The current worktree already contains the first half of the repair: `tabRow` accepts a project ID and the fake `new_tab` action reads and returns the posted `project_id`. The remaining hardening should stay in this same integration test so the fixture cannot silently regress to a globally visible but projectless row again.

## Existing coverage disposition

| Test / mechanism | Status | Exact coverage and limitation |
|---|---|---|
| `ui/tests/react/tab-select-stamps-tab-recency.test.tsx` | modify | This is the only test that joins the real router/process loader, production tab materialization, exact project-scoped `UnifiedTabStrip`, and Tab recency activation. Preserve that cross-layer proof. Its fake must mirror the backend by propagating the request's `project_id`; it still needs an explicit request/row assertion and a negative-scope control. |
| `ui/tests/unit/tab-recency.test.ts` | keep | Pins warm-snapshot activation, cold-snapshot refresh then activation, and the no-matching-tab no-op. It proves the recency helper in isolation but cannot detect a malformed `new_tab` response or project-filter interaction. |
| `ui/tests/unit/tab-project-filter.test.ts` | keep | Pins exact project filtering: the active project excludes null and other-project rows, null scope includes only projectless rows, and all scope remains global. It correctly explains why the Phase 6 fake row disappeared; no production-filter relaxation is warranted. |
| `ui/tests/unit/tab-project-rebased-asset.test.ts` and `tab-project-cwd-fallback.test.ts` | keep | Pin project resolution from the target entity and cwd fallback, including the `project_id` sent to `new_tab`. They do not exercise a newly created process through the route loader and scoped strip. |
| `ui/tests/react/project-chip-cross-project-clobber.test.tsx` | keep | Already models the correct fake boundary by reading `action.bodyParameters.project_id` into a real-shaped Tab row and distinguishing global from scoped lists. Reuse this fixture convention; its assertion target is cross-project chip identity, not recency. |
| `ui/tests/react/tab-close-last-in-project.test.tsx` | keep | Proves close/reselection remains within the active project even when a different project has a more recent Tab. It does not cover process-tab creation or selection stamping. |
| `tests/unit/test_tab_actions_order.py::test_list_scopes_each_tab_to_exactly_one_view` and `tests/unit/test_tab_entity.py::test_list_all_spans_all_projects_unlike_scoped_list` | keep | Backend contract coverage already proves exact scoped versus global lists. The React fake should conform to this contract rather than weakening it. |
| Existing real-backend Tab API tests (`process_tab_cardinality`, `display_row_reap`, `tab_rename`, `tabs_changed_broadcast`) | keep | Exercise real `Tab.newTab` and adjacent lifecycle behavior, but none combines process project propagation, project-strip visibility, and loader-driven Tab recency. A new API file would duplicate lower-level coverage without closing the integration-harness gap. |

## Smallest required hardening

Modify only `ui/tests/react/tab-select-stamps-tab-recency.test.tsx`; add no new test file.

1. Keep the real-shaped fake boundary: read `action.bodyParameters.project_id` in `new_tab`, pass it into `tabRow`, and record the posted value. Assert that the process-tab request carried `PROJECT_ID` and that the resulting `NEW_PROCESS_TAB_ID` row retains exactly that project ID. This makes project propagation an observed contract rather than an incidental prerequisite for finding the chip.
2. Seed one distinct control Tab with `project_id: null` in the fake's global `backendTabs`. Assert that the control remains present in the global fake response but its chip is absent from the strip while the router is scoped to `PROJECT_ID`. This proves the repaired fixture did not make the production scope filter permissive and directly protects the RCA discriminator.
3. Preserve the core recency proof unchanged in substance: the newly materialized process chip appears, `tabActivateCalls` contains exactly the selected process Tab ID, and that row's initially null `last_active_at` becomes non-null. The control row must not satisfy any of these assertions.
4. Refresh the stale pre-fix test commentary so it states the enduring invariant—selection stamps the Tab entity after project-correct materialization—rather than claiming production never calls `Tab.activateById`.

Strong failure criteria are: the fake ignores or overwrites the posted project ID; a null-project control renders in the project strip; the backing AgenticProcess activation is mistaken for Tab activation; or recency is asserted on a row other than `NEW_PROCESS_TAB_ID`.

## Summary

- Keep: all existing scope, project-resolution, close-resolution, backend, and recency unit/API coverage
- Modify: 1 existing React integration test, including its stale description
- Add: 0 test files; add 1 in-test null-project negative control and explicit project-propagation assertions
- Remove: 0 tests and 0 production behavior

# Coverage Analysis — Phase 3 six-area failure cluster — 2026-08-25

## Scope and observed failure signal

This is a read-only, code-driven coverage audit of the six Phase 3 failure areas. No tests were run, no browser was opened, and no backend, hub, sandbox, or local instance was touched. The evidence source is the existing artifact
`ui/tests/manual_regression/_results/2026-08-24T23-36-15Z/phase3-pytest-long.log`: 159 collected, 22 failed, 113 passed, 19 skipped, and 5 xfailed in 29m05s.

The 22 failures come from eight test definitions:

- 1 E2B last-PTY cleanup row;
- 2 multi-vendor process-hook rows (Codex and Copilot);
- 12 prompt/multi-turn rows (three vendors by PTY/headless by two behaviors);
- 4 settings-instruction rows (all three headless vendors and Claude PTY; the Codex/Copilot PTY rows did not provide live coverage);
- 1 live skill-chip stream row;
- 2 system-prompt rows (Claude and Copilot; Codex passed).

The required test layers were all inspected. `docs/reports/current_api_migration_status.md`, requested by the role instructions, is absent in this checkout; this audit therefore used the current interface/agentic-process documentation and code/test contracts only.

Legend for the layer matrix: **exact** means the failure contract is directly covered, **adjacent** means only a neighboring seam is covered, and **none** means no relevant test was found.

| Failure area | `tests/unit` | `tests/api` | `ui/tests` unit/api/react/long | `ui/tests/headless` | `ui/tests/hub` | manual regression | `_fast_paths` |
|---|---|---|---|---|---|---|---|
| E2B PTY cleanup | adjacent | none | adjacent / real E2B use only | none | none | E2B use only | none |
| Multi-vendor process hooks | exact | partial, Claude-shaped | exact SDK + real vendor | none | none | none | none |
| PTY/headless prompt + multi-turn | exact lower seams | partial, Claude headless | partial + real matrix | none | exact UI stress | exact Codex/UI scenarios | none |
| Settings instruction propagation | exact launch sinks | none | incidental only | none | none | none | none |
| Live skill-chip streaming | exact converter/grouping | none | converter smoke + mocked renderer | replay/authoring only | skill execution, not chip timing | skill execution, not chip timing | none |
| System prompt propagation | partial Agent source + exact process sinks | none | authoring only + duplicated live test | none | none | none | none |

## 1. E2B PTY cleanup

### Existing coverage disposition

| Test | Type | Status | Exact coverage and limitation |
|---|---|---|---|
| `tests/long_tests/test_e2b_pty.py:237` — `test_shell_close_kills_sandbox_when_last_pty_leaves` | pytest-long, real E2B | modify | It is the only direct last-PTY cloud-reap proof. It timed out at the unchanged 30-second cap and currently closes through `shell.close()` and then conditionally calls `pty.close()` again before a remote `AsyncSandbox.get_info`, so the failure does not localize canonical close, provider cleanup, or the external verification call. |
| `tests/long_tests/test_e2b_pty.py::{test_shell_on_sandbox_boots_linux_pty_via_shell_start,test_shell_on_sandbox_pwd_is_home_user,test_two_sandbox_shells_share_one_e2b_sandbox,test_shell_start_on_sandbox_uses_e2b_provider_not_local}` | pytest-long, real E2B | keep | These prove routing, shell usability, and same-node sandbox sharing. None closes the first of two PTYs or proves the last close kills exactly once. |
| `tests/unit/conftest.py::any_provider`, `tests/unit/fakes/fake_e2b_sandbox.py`, `tests/unit/test_provider_dead_pty_no_bare_respawn.py`, and `tests/unit/test_factory_reset_system_content.py::test_factory_reset_terminates_live_pty_children_before_db_wipe` | pytest-unit | keep | The fake/provider seams and unrelated dead-PTY/factory-reset cleanup are useful foundations, but there is no E2B last-user reference-count regression. |
| `ui/tests/api/shell_tabs.test.ts::{test_list_shells_excludes_closed,test_close_tab_write_through_persists,test_refresh_scenario_no_tabs_after_close_all,test_open_tab_sets_running}` and `ui/tests/react/shell_stress.test.ts` | Vitest API/React | keep | These pin Shell row/tab cleanup and local PTY stress, not the E2B provider's shared-sandbox lifetime. |
| `ui/tests/long_tests/e2b_sandbox_pty.test.ts::{bootstrap exposes @sandbox compute node + sandbox_available flag,Cloud-button flow: create Shell on @sandbox…,…two sequential commands on the same Shell hit the same sandbox}` | Vitest long, real E2B | keep | This is strong TypeScript-SDK creation/routing/round-trip coverage, but it never closes the last sandbox Shell or observes reap. |
| `ui/tests/manual_regression/terminal/{sandbox_terminal_uname.md.ts,sandbox_two_tabs_roundtrip.md.ts}` | Playwright manual | keep | These remain user-facing sandbox-use checks; cloud resource teardown is not a browser contract and should not be added here. |

Modify the failing long test to use one canonical close path, assert the registry entry disappears immediately after the awaited close, and make one cloud-side state lookup. Put cleanup in `finally` so a failed assertion cannot leak the sandbox. Do not add a second close, retry, sleep, poll, or larger timeout.

### Required new deterministic tests

| Proposed test | Type | Behavior and failure criteria |
|---|---|---|
| `tests/unit/test_e2b_pty_cleanup.py::test_closing_one_of_two_e2b_ptys_does_not_kill_shared_sandbox` | pytest-unit | Open two fake E2B PTYs on one node, close one, and assert `kill` was not called, the sandbox cache remains, and the sibling PTY still exists. Any early kill or sibling-state removal fails. |
| `tests/unit/test_e2b_pty_cleanup.py::test_closing_last_e2b_pty_kills_once_and_clears_provider_state` | pytest-unit | Close the final fake PTY and assert fake `sandbox.kill` was awaited exactly once and both PTY/sandbox caches are empty; repeat the close and assert no second kill. This isolates reference counting and idempotency without E2B network timing. |

No new pytest-API, frontend, headless, hub, manual, or fast-path test is recommended: provider resource ownership is fully characterized by the deterministic provider tests plus the existing single real-E2B acceptance.

## 2. Multi-vendor process hooks

### Existing coverage disposition

| Test | Type | Status | Exact coverage and limitation |
|---|---|---|---|
| `tests/long_tests/test_process_hooks_multi_vendor.py:37` — `test_process_hook_acceptance_uses_real_vendor[codex|copilot]` | pytest-long, real CLIs | modify | Both rows timed out. The test correctly covers persisted intent, generated runtime contribution, real `flow hooks report`, canonical callback data, and SessionStart/UserPromptSubmit, but waits on bare `asyncio.Event.wait()` after `process.prompt()` with no causal failure surface. |
| `tests/long_tests/test_claude_cli.py::test_process_hook_acceptance_uses_real_claude_plugin` | pytest-long, real Claude | keep | This is the Claude counterpart and passed in the same cycle. |
| `tests/unit/test_process_hooks.py::{test_set_and_remove_hook_are_idempotent,test_process_hooks_reject_every_other_event_before_mutation,test_hook_intent_persists_and_rehydrated_process_reaches_registered_callback,test_callback_delivery_uses_process_id_and_one_targeted_flowdata,test_direct_listen_route_unwraps_vendor_native_hook_data,test_each_worker_launch_entry_prepares_once_with_runtime_parity,test_hook_events_accumulate_in_canonical_order_and_remove_independently,test_on_hook_delivers_each_configured_session_event_with_its_own_subtype}` | pytest-unit, three vendors where parametrized | keep | Strong semantic intent, launch, route, callback, ordering, and persistence coverage. |
| `tests/unit/test_process_hook_runtime.py::{test_claude_process_hook_projection_is_deterministic,test_plugin_dirs_propagate_through_every_claude_context_consumer,test_claude_session_snapshot_and_normalization_carry_lifecycle_fields}` | pytest-unit | keep | Pins Claude projection and lifecycle normalization. |
| `tests/unit/test_codex_process_hook_runtime.py::{test_codex_process_hook_runtime_is_structured_fileless_and_deterministic,test_codex_stream_worker_copies_hook_runtime_from_context,test_codex_hook_normalization_is_sparse_and_preserves_native_payload,test_codex_session_snapshot_and_normalization_carry_lifecycle_fields}` | pytest-unit | keep | Pins Codex fileless argv projection, stream-worker propagation, and native normalization. |
| `tests/unit/test_copilot_process_hook_runtime.py::{test_process_hook_plugin_projection_is_deterministic_and_reconciles_stale_files,test_native_and_vscode_payloads_normalize_to_canonical_agent_hook_data,test_every_configured_event_projects_one_handler_under_its_alias,test_transport_terminator_is_stripped_only_for_the_prompt_event}` | pytest-unit | keep | Pins Copilot plugin projection, event aliases, native/VS Code payloads, and prompt normalization. |
| `tests/unit/test_hook_capability_matrix.py::test_v1_vendors_support_exactly_the_same_event_set` and `tests/unit/test_hook_typed_responses.py::test_vendors_that_declare_no_response_events_render_nothing` | pytest-unit | keep | Correctly pins cross-vendor capability parity and observer-only response behavior. |
| `tests/api/test_hook_unsupported_cell_is_reported.py::{test_set_hook_refuses_an_unsupported_event_with_the_reason,test_set_hook_accepts_a_supported_event}` and `tests/api/test_hook_response_round_trip.py::{test_a_callback_answer_comes_back_as_vendor_json,test_no_callback_returns_the_plain_ack}` | pytest-API | keep | These cover public action/route envelopes, but fixtures are Claude-shaped and do not prove Codex/Copilot launch contribution to report-route delivery. |
| `ui/tests/unit/agentic-process-hooks.test.ts` and `ui/tests/long_tests/process_hook_acceptance.test.ts::%s: setHook → registerCallback → prompt delivers one canonical hook` | Vitest unit/long | keep | The SDK callback lifecycle and three-vendor real UserPromptSubmit acceptance are valuable. The long test covers only UserPromptSubmit; Python retains SessionStart/SessionEnd responsibilities. |

Modify the Python real-vendor acceptance to preflight an explicit vendor-ready condition, run the prompt, and assert that required callbacks are already present when the prompt's terminal success is observed. A normalized vendor-unavailable result may skip; absence of callbacks after an accepted terminal turn must fail. Remove the unbounded event waits and preserve the existing 30-second cap and teardown.

### Required new deterministic test

| Proposed test | Type | Behavior and failure criteria |
|---|---|---|
| `tests/api/test_process_hook_delivery_matrix.py::test_configured_process_hook_reaches_callback_through_vendor_report_route` | pytest-API, parametrized Claude/Codex/Copilot and three supported events | Configure the hook through the public process action, launch a fake vendor command that invokes the generated report command with a native payload, and assert one canonical callback for the target process with the exact event, session discriminator, raw payload, and normalized prompt. Wrong process attribution, missing/duplicate delivery, wrong alias, or a projection that never calls the route fails. |

No new frontend/headless/hub/manual/fast-path scenario is needed; the UI SDK and real-worker acceptance already cover the consumer boundary once deterministic backend route wiring exists.

## 3. PTY/headless prompt and multi-turn transport matrix

### Existing coverage disposition

| Test | Type | Status | Exact coverage and limitation |
|---|---|---|---|
| `tests/long_tests/test_pty_mode_matrix.py:303` — `test_prompt_streams_in_both_transports` | pytest-long, 3 vendors x 2 transports | modify | All six rows failed. It demands an exact assistant frame, but stops reading immediately when that frame appears instead of proving the turn reached its terminal frame. That makes the one-turn assertion weaker and can leave lifecycle work in flight. |
| `tests/long_tests/test_pty_mode_matrix.py:328` — `test_multi_turn_resumes_same_session` | pytest-long, 3 vendors x 2 transports | modify | All six rows failed. `_send_turn` retries up to 20 times with one-second sleeps after breaking a live stream early, and `_settle_session_id` polls 15 times. Those waits can hide the unfinished-turn bug and violate the repository's no-timeout/retry masking rule. |
| `tests/unit/test_codex_pty_composer_gate.py` (composer detection/delivery/terminal/error cases), `tests/unit/test_stream_transcript_resume_guard.py::{test_guard_waits_for_the_new_turn,test_without_worker_exits_on_stale_marker}`, `tests/unit/test_agentic_process_prompt_admission.py`, `tests/unit/test_agentic_process_turn_cleanup.py`, and `tests/unit/test_headless_turn_runner.py` | pytest-unit | keep | Strong lower-seam coverage exists for PTY input admission/composer behavior, new-turn transcript guarding, one-turn admission, cancellation, and shared headless lifecycle. |
| Vendor CLI command/resume unit suites and `tests/unit/test_agentic_process_restart_snapshot.py::test_pty_mode_changes_codex_launch_shape_but_never_restart_hash` | pytest-unit | keep | These correctly pin each vendor's initial/resume argv and transport-derived launch differences. |
| `tests/api/test_agentic_process_execute.py::{test_execute_headless_round_trip_captures_session_id,test_prompt_headless_streams_flowdata_and_end,test_cancel_prompt_terminates_in_flight_turn,test_disconnect_mid_turn_shielded_turn_completes_durably,test_r03_no_phantom_restart_across_transport_and_turns}` | pytest-API, fake Claude headless | keep | Good public lifecycle coverage, but it has no PTY path and no Codex/Copilot output/resume matrix. |
| `ui/tests/long_tests/agentic_process_execute.test.ts::{executeInstruction(\"Say hola\")…,two sequential executeInstruction calls…}` | Vitest long, Claude headless | keep | Useful TypeScript-SDK headless smoke, but not vendor/transport parity. |
| `ui/tests/hub/chat_terminal_switch_stress.ui.test.ts` | Vitest hub UI | keep | This is the strongest user-facing transport proof: repeated Chat/Terminal switching, canonical prompt/submit paths, and same-session continuity. |
| `ui/tests/manual_regression/agentic-process/{codex_chat_terminal_switch_matrix.md.ts,codex_chat_terminal_full_matrix.md.ts}` and `ui/tests/manual_regression/terminal/visible_process_still_pty.md.ts` | Playwright manual | keep | These retain visual/navigation regression coverage. They should not duplicate the backend six-cell protocol matrix. |

Modify both long matrix tests so one prompt stream is consumed through the expected exact assistant reply **and** its terminal `flow-result`/`flow-end`. After that terminal proof, read the process row once and, for multi-turn, send turn two once. Remove the 20-attempt retry/sleep loop and session-id polling; do not raise the global 30-second or HTTP read caps. An explicit normalized `flow-worker-unavailable` may skip; an arbitrary `flow-error`, missing exact reply, terminal-before-reply, changed session, duplicate turn, or unresolved first turn must fail.

### Required new deterministic tests

| Proposed test | Type | Behavior and failure criteria |
|---|---|---|
| `tests/api/test_agentic_process_transport_matrix.py::test_prompt_streams_one_complete_turn_for_every_vendor_and_transport` | pytest-API, fake worker, 3 x 2 | Through the public create/prompt actions, inject each vendor's minimal real-shaped output and assert persisted `pty_mode`, exact user/assistant FlowData, one terminal frame, and no prompt error. This isolates Flowpad routing from auth/network/model behavior. |
| `tests/api/test_agentic_process_transport_matrix.py::test_two_prompts_resume_one_session_for_every_vendor_and_transport` | pytest-API, fake worker, 3 x 2 | Send two distinct prompts after terminal completion, assert two distinct exact replies in order, one stable non-empty session ID on process and transcript rows, and no duplicate/foreign turn. A fresh second session or second-turn 409 fails immediately; no retry is permitted. |

No new UI-headless or fast-path test is recommended. The hub stress and manual matrices already cover rendering and toggling; the missing coverage is the deterministic public backend matrix.

## 4. Settings instruction propagation

### Existing coverage disposition

| Test | Type | Status | Exact coverage and limitation |
|---|---|---|---|
| `tests/long_tests/test_settings_instruction.py:168` — `test_settings_instruction_is_obeyed` | pytest-long, 3 vendors headless | modify | All rows failed the marker assertion. Asset delivery is asserted, but obedience is read from a separately resolved transcript after 20 seconds rather than from the prompt stream, so stale/wrong-session selection and worker output are conflated. |
| `tests/long_tests/test_settings_instruction.py:203` — `test_settings_instruction_is_obeyed_pty` | pytest-long, 3 vendors PTY | modify | Claude failed; Codex/Copilot supplied no enforced live signal in this cycle. The paths differ (`prompt` versus `start_pty` + `submit`) and then rely on the same transcript poll, so vendor parity is not observed at one public seam. |
| `tests/unit/test_system_instruction_assets.py::{test_embedded_assets_default_none_then_materialized,test_no_system_instructions_leaves_assets_uncreated,test_system_instruction_assets_applied_to_worker_options,test_persona_survives_fresh_entity_instance,test_pty_seam_never_applies_the_project_language}` | pytest-unit, vendor matrix where applicable | keep | This is strong asset materialization, rehydration, and PTY/headless instruction-context coverage. |
| `tests/unit/test_cli_options_system_prompt.py::{test_claude_receives_system_prompt_file_flag,test_codex_receives_developer_instructions_config,test_copilot_receives_custom_instruction_dir_env,test_no_addition_is_a_no_op}` | pytest-unit | keep | Exact vendor sink coverage matches the driver contract: Claude append file, Codex developer instructions, and Copilot custom instruction directory. |
| `ui/tests/long_tests/flow_show_display_focus.test.ts` | Vitest long | keep | It uses `context_data.instructions` incidentally to steer a live worker, but is a display-focus test and must not become the propagation contract. |

Modify the live settings tests to drive the same public `/prompt` stream for PTY and headless and assert the unique marker in the exact assistant frame before terminal success. Preserve the asset assertions. Preflight explicit CLI/auth availability before the turn; after the worker accepts the turn, no fresh transcript or missing marker is a failure, not a skip. Remove transcript polling/sleeps and do not enlarge a cap.

### Required new deterministic test

| Proposed test | Type | Behavior and failure criteria |
|---|---|---|
| `tests/api/test_system_instruction_propagation.py::test_saved_process_instructions_reach_every_vendor_transport_sink` | pytest-API, fake launch capture, 3 x 2 | Create/save/reload a process with a nonce in `context.instructions`, prompt it through each transport, and inspect the actual launch argv/env/files: Claude has the generated append file, Codex has `developer_instructions`, and Copilot's configured directory contains `flowpad.instructions.md`. Missing nonce, wrong vendor sink, lost instructions after reload, or a transport-specific omission fails. |

No UI form for this process setting was found, so no UI unit/react/headless/hub/manual/fast-path test should be invented. The public API serialization/reload seam is the material gap.

## 5. Live skill-chip streaming

### Existing coverage disposition

| Test | Type | Status | Exact coverage and limitation |
|---|---|---|---|
| `tests/long_tests/test_skill_chip_live_stream.py:56` — `test_live_stream_emits_skill_meta_chip_frame` | pytest-long, real Claude | modify | It timed out at 30 seconds while calling `proc.communicate(timeout=60)`. It asks a model to choose the Skill tool, then directly invokes `event_to_flowdata`; it does not traverse AgenticProcess prompt streaming or render the chip, so its name overstates the covered layers. |
| `tests/unit/test_claude_event_to_flowdata.py::test_user_text_block_yields_meta_user_message` | pytest-unit | keep | Exact deterministic regression for Claude `user` text block -> `USER_MESSAGE is-meta=true`. |
| `ui/tests/unit/group-turn-events-skill.test.ts::{drops the Skill TOOL_CALL and its TOOL_RESULT from dense groups,stamps the dropped call’s skill name onto the meta message group,reads the name from the flow value when the attribute is absent}` | Vitest unit | keep | Correctly pins collapse and skill-name harvesting. |
| `ui/tests/unit/group-turn-events-virtual-drop.test.ts::{drops a codex skill call (tool-name shell),still harvests the skill name for the meta chip}` | Vitest unit | keep | Covers the Codex virtual-tool form and one-chip invariant. |
| `ui/tests/unit/turn-files-chips.test.tsx::drops the Flowpad prompt envelope, keeps other meta messages` and `ui/tests/unit/tool-event-descriptor.test.ts::names the skill without making the dense row the click affordance` | Vitest component/unit | keep | These pin filtering/descriptor behavior, but `MetaMessageChip` is mocked in component tests, so the actual chip label/expansion is untested. |
| `ui/tests/hub/skill_run_vibe_mcp_ui.ui.test.ts::Bob shares find-me-a-product; Alice runs it from the chip → mcp-ui form → report` | Vitest hub UI, live Claude | keep | Proves a received skill can be launched by name and render MCP-UI; it never asserts the in-chat `Using skill` meta chip, nor before-versus-after-refresh timing. |
| `ui/tests/headless/full-analysis-flow.test.tsx` and `ui/tests/manual_regression/skills/full_analysis_flow.md.ts` | Vitest headless / Playwright manual | keep | These replay/seed skill-loaded analysis data; they do not observe a live prompt stream. |

Modify the real-Claude long test into a narrowly named vendor stream-format acceptance. Read stdout incrementally within the existing 30-second cap and stop only after both a real Skill tool call and the corresponding raw user-text/meta conversion are observed; remove `communicate(timeout=60)`. Explicit auth/unavailability may skip, but an authenticated run that never invokes the requested skill or never emits the body must fail. The deterministic API and React tests below should carry the actual Flowpad regression contract.

### Required new tests

| Proposed test | Type | Behavior and failure criteria |
|---|---|---|
| `tests/api/test_skill_chip_stream.py::test_prompt_stream_forwards_skill_body_as_meta_user_frame_before_end` | pytest-API, fake Claude stream | Feed the public `/prompt` path a fixture containing Skill TOOL_CALL, injected `user` text body, TOOL_RESULT, and result. Assert the HTTP stream contains `flow-chat role=user is-meta=true` before the terminal frame and preserves the skill name/body. Missing, reordered-after-end, or duplicate meta frames fail. |
| `ui/tests/react/meta-message-skill-chip.test.tsx::renders_skill_chip_from_live_meta_frame_before_reload` | Vitest React with real `MetaMessageChip` | Append the API-shaped meta FlowData to the mounted turn stream without remount/reload and assert `Using skill: chip-probe` appears once, dense Skill call/result rows stay hidden, and expanding the chip reveals the body. Do not mock `MetaMessageChip`. |

A second live hub/browser scenario is not recommended: `skill_run_vibe_mcp_ui` is already expensive and model-driven. The deterministic public-stream plus actual-renderer tests prove the live-before-refresh bug; the existing hub run remains the end-user skill smoke.

## 6. System prompt propagation

This area is distinct from process settings at the source seam: an authored `Agent.system_prompt` must become deployment/process `context_data.instructions`. Below that seam, it deliberately shares the instruction-asset and vendor-sink pipeline from section 4.

### Existing coverage disposition

| Test | Type | Status | Exact coverage and limitation |
|---|---|---|---|
| `tests/long_tests/test_system_prompt.py:68` — `test_system_prompt` | pytest-long, 3 vendors headless | remove | Claude and Copilot failed; Codex passed. This test writes the same `AgenticProcess.instructions` field, asserts the same four files, and polls a transcript like `test_settings_instruction_is_obeyed`, but with a 150-second pytest timeout and 120-second polling budget. It does not exercise an `Agent`, deployment, or Agent-to-process mapping, so it duplicates settings coverage while violating the repository timeout policy. |
| `tests/unit/agent/test_agent_deployment_contract.py::test_system_prompt_never_enters_cli_config` | pytest-unit | keep | Correct negative boundary: Agent identity does not enter restart-hashed `cli_config`. It does not positively assert where the prompt goes. |
| `tests/unit/agent/test_seeded_agents.py:44::test_shipped_agent_parses_and_is_cheap`, `tests/unit/agent/test_q_bundle.py:16::test_q_bundle_is_a_valid_agent_with_its_qa_skill`, and `tests/unit/agent/test_agent_launch_bundle.py:51::test_shipped_agent_resolves_off_disk_without_an_index` | pytest-unit | keep | These prove authored/bundled agents have prompts, not runtime propagation. |
| `tests/api/test_agent_authoring.py` and `tests/api/test_git_asset_share.py` | pytest-API | keep | These cover authoring/publishing/preserving `system_prompt`, not deployment launch. |
| `ui/tests/unit/agent-document.test.ts::changes only the Markdown body for system_prompt` and `ui/tests/unit/agent-document-capsule.test.ts::re-attaches the capsule after a system_prompt swap` | Vitest unit | keep | Correct editor persistence coverage; execution remains a backend responsibility. |

Remove the duplicated long test after the settings live matrix is repaired. Do not merge its 120/150-second budgets into another test. Preserve one real live semantic acceptance in `test_settings_instruction.py`, and cover the unique Agent source mapping deterministically.

### Required new test

| Proposed test | Type | Behavior and failure criteria |
|---|---|---|
| `tests/unit/agent/test_agent_deployment_contract.py::test_agent_system_prompt_becomes_process_context_instructions` | pytest-unit | Build/deploy an Agent with a unique system prompt through the production launch-bundle seam and assert the resulting process context instructions contain the prompt exactly once, survive save/reload, and remain absent from `cli_config`. Lost, duplicated, reordered behind caller instructions contrary to the declared merge order, or restart-hash contamination fails. |

No second API/live/UI system-prompt scenario is required: the new Agent-source unit test composes with `test_saved_process_instructions_reach_every_vendor_transport_sink` and the repaired settings acceptance. This removes duplication while preserving end-to-end semantic coverage.

## Prioritized gaps and disposition counts

| Priority | Gap | Smallest effective action |
|---|---|---|
| P0 | No deterministic public 3-vendor x 2-transport prompt/resume matrix | Add the two fake-worker pytest-API matrix tests; repair the live matrix to drain one turn to terminal completion with no retries or polling. |
| P0 | E2B last-PTY ownership is proven only by one opaque cloud timeout | Add the two provider-unit reference-count/idempotency tests; keep one canonical real-E2B reap acceptance. |
| P0 | Process instructions have strong file/argv units but no save/reload/public-action propagation proof | Add the six-cell pytest-API sink test and make the live test assert its own streamed turn. |
| P1 | Skill-chip coverage jumps from converter/grouping units to a model-driven direct-converter smoke; the public stream and actual renderer are absent | Add one pytest-API ordering test and one unmocked React chip test; narrow the real-Claude test to vendor format drift. |
| P1 | Codex/Copilot hook route wiring is accepted only with real CLIs | Add a fake native-payload API matrix from configured launch contribution through callback delivery. |
| P1 | `Agent.system_prompt` has only a negative `cli_config` assertion; the failing live test never launches an Agent | Add the positive Agent-to-process-context unit and remove the duplicated 120/150-second live test. |

Disposition/count summary for the eight failing definitions (22 parametrized failures):

- Keep unchanged: 0 failing definitions; retain all cited supporting tests.
- Modify: 7 failing definitions (`test_shell_close_kills_sandbox_when_last_pty_leaves`, `test_process_hook_acceptance_uses_real_vendor`, both `test_pty_mode_matrix` definitions, both `test_settings_instruction` definitions, and `test_live_stream_emits_skill_meta_chip_frame`).
- Remove: 1 obsolete definition (`test_system_prompt`).
- Add: 9 named deterministic tests — 3 pytest-unit, 5 pytest-API, and 1 Vitest React.
- Add no timeout, retry, sleep, polling, backoff, rerun, or flaky allowance; preserve every existing cap.

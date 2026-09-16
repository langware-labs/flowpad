# Session naming across browsers

`worker_session_name_observers.md.ts` runs two independent Chromium contexts
against one real isolated backend. It uses controlled Copilot native metadata,
the production file watcher, naming FSM, entity actions and WebSocket delivery.
It makes no CLI or model calls and requires no provider credentials. This
complements the real worker matrix in `worker_session_names.md.ts`.

Use the isolated instance and native-home setup in `worker_session_names.md`.
Set `NAMING_NATIVE_FIXTURES=true`, `NAMING_WORKSPACE_ROOT` to an exclusively owned
workspace outside excluded OS temporary directories, and `COPILOT_HOME` to the
same disposable native home used by the backend. Keep `FLOWPAD_COPILOT_HOME`
aligned. The test creates a Project, process and native session directory and
deletes them afterward.

From `ui/`, with the instance environment exported:

```sh
NAMING_NATIVE_FIXTURES=true \
  npx playwright test \
  --config tests/manual_regression/agentic-process/playwright.config.ts \
  worker_session_name_observers.md.ts --output /path/to/naming-observer-results
```

The observer opens its Project before the publisher opens the process. It must
keep its process runtime unmounted throughout: no active terminal panel,
process toolbar, process-owned composer or xterm. Both tab strips and Chats
sidebars, plus the publisher header, must follow this sequence without reload:

1. A controlled `first_prompt` event supplies the fallback.
2. An atomic native `workspace.yaml` update with `user_named: false` promotes a
   verified harness title over the fallback.
3. Double-clicking the actual tab title and pressing Enter without changing a
   character pins that same title as a user choice.
4. A later native auto-title update advances the stored native source cursor
   while the user-pinned name stays unchanged and `auto_rename` remains false.

The cursor assertion proves the final update was consumed. Phase JSON and
distinct screenshots are written to the output directory before attachment,
including both the initial pin and the later rejected native title. Failures
retain Playwright traces. Existing suite timeouts and zero retries apply.

The row subscribes to server entity updates for already-cached processes.
Removing that subscription reproduces an idle observer whose fresh worker
history response contains the new title while its cached process keeps the old
one. The test must fail on that stale row; a reload is not an acceptable repair.

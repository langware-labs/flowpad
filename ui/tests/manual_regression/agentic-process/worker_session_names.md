# Worker session names

`worker_session_names.md.ts` exercises real Claude Code, Codex, Copilot and
OpenCode sessions in both PTY and headless modes. It uses the actual browser,
SDK, WebSocket connection, backend and native CLI files. It makes model calls.

Use an exclusively owned instance launched with `scripts/instance_ctl.sh` and
separate provider homes. Set `FLOW_HOME`, `CLAUDE_CONFIG_DIR` and
`FLOWPAD_CLAUDE_HOME`, `CODEX_HOME`, `COPILOT_HOME` and `FLOWPAD_COPILOT_HOME`,
`XDG_DATA_HOME`, and `XDG_CONFIG_HOME` to disposable directories. Preserve those
values in the instance launcher environment before restarting its backend.
Copy only the credentials required for the test account, keep copies private,
and remove them after the run. Never use native production session directories.

Set `NAMING_WORKSPACE_ROOT` to a disposable workspace outside history's excluded
OS temporary directories, for example a uniquely named directory under
`~/.flow/`. The test creates a real Project for each separate child workdir and
deletes its process and project entities afterward. It verifies the API mount
path, process project binding and browser project scope before a model turn.

From `ui/`, with the instance's actual ports exported:

```sh
FLOW_INSTANCE=naming-qa VITE_PORT=5002 QA_API_URL=http://localhost:6001 \
  npx playwright test \
  --config tests/manual_regression/agentic-process/playwright.config.ts \
  worker_session_names.md.ts --output /path/to/private/naming-results
```

`NAMING_WORKER=codex` selects one provider; Playwright `--grep` can select a
specific mode. The checked-in suite's existing timeouts and zero retries apply.
Verify the selected model against the isolated native CLI first; the model
choices in this fixture record the successful September 2026 local experiment.

Each of the eight cells requires all three browser tests to pass:

1. A real first assistant response and matching canonical tab, header and
   sidebar names without a refresh.
2. An explicit numeric-leading rename on the actual tab, persisted pinning,
   and another real worker response that cannot change the name.
3. Refresh, tab close and sidebar reopen, then transport changes in both
   directions, retaining the name, pin and native session identity.

Screenshots and resolved naming state are attached to passing stages. Failures
attach process and tab projections before cleanup and retain Playwright traces.
An authentication block, failed discovery, missing sidebar row, failed mode
transition, skipped test or unexecuted serial follower is not a passing cell.

The browser suite complements backend FSM/provider tests for delayed native
titles, stale session identities, explicit same-text pinning, legacy provenance,
and no-auto capability behavior. Native CLI `/rename` and no-auto behavior must
also have separate PTY/headless experiment evidence. A complete release gate
requires those checks and all eight browser cells; partial runs must name their
unvalidated behavior.

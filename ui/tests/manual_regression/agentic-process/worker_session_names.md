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

With one worker selected, `NAMING_MODEL` may override its model and
`NAMING_EXPECTED_ENDPOINT_TYPEID` asserts that worker's resolved funding source
within each fixture Project before process creation. Configure a local key
through the normal `lm_keys` action using the isolated encrypted secret store,
then select it through `llm-endpoint/select`. Project endpoint constraints refer
to hub endpoints; leave them empty when selecting a local provider key. A bare
provider-key environment variable does not configure worker funding. Keep
plaintext credentials out of test arguments, environment reports and browser
artifacts. For Claude through
OpenRouter, also point the native haiku/sonnet/opus and subagent model defaults
at the verified model so auxiliary title requests use the same endpoint model.

For a fresh isolated Claude home, `NAMING_CONFIGURE_CLAUDE_FIXTURE=true` prepares
its native theme/onboarding state and trusts only each newly created test
workdir. It requires explicit `CLAUDE_CONFIG_DIR` and refuses normal
`~/.claude`. Claude's first-turn check also requires its verified native title
to reach the `harness` naming phase with the correct session binding before
the subsequent explicit rename can pin it.
The Claude fixture uses normal permissions; these science questions need no
privileged tool execution or native Bypass Permissions onboarding.

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

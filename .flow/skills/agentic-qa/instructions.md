# QA Instructions & Learnings

## Testing Environment

- Backend: `http://localhost:9008` (port set via `LOCAL_SERVER_PORT=9008` in `.env.local`)
- Frontend: `http://localhost:4097` (Vite dev server)
- Backend start command: `cd /Users/shlom/Documents/dev/flowpad-oss && LOCAL_SERVER_PORT=9008 uv run -m flow_sdk.server.run`
- Platform: darwin (macOS)
- Browser: chromium (Playwright headless)

## Learnings

### 2026-04-04 — AgenticProcess Layer 3 refactor (worker_session_id → session_id)

**MCP browser "refresh" ≠ page reload**
MCP browser "refresh" implementations by testers tend to navigate to the base URL (e.g., `/dock/shell`) instead of calling `page.reload()`. This causes all tabs to appear lost. Always use Playwright's `page.reload()` for refresh tests. Affected: `flow_shell_tab_location`, `shell_tabs_remain_open_after_closing`.

**MCP browser Ctrl+W closes browser tabs, not terminal tabs**
Ctrl+W in MCP browser context closes the browser tab rather than the terminal tab inside the app. For close-tab tests, use the close button selector or Playwright automation instead. Affected: `shell_tabs_remain_open_after_closing`.

**window.sniffer removed in SnifferContext refactor (commit fa7bbae, 2026-04-04)**
`window.sniffer` global was removed when sniffer was refactored to use React SnifferContext. The new API is `window.context?.snifferHook?.entity`. Update `sniffer_shared_state_single_backend_call.md` test 3 to use the new accessor.

**Bootstrap idempotency fails when concurrent DB clears occur between calls**
`sniffer_bootstrap_init_state` test 1 checks that two successive bootstrap calls return the same sniffer_hook ID. If another test's DB clear fires between the two calls, a new hook is created, breaking idempotency. Always run sniffer tests in isolation with no concurrent DB clears.

**Stale server causes session_id/worker_session_id mismatch**
After the `worker_session_id` → `session_id` field rename, a server running old code returns `worker_session_id` in API responses. The TS SDK expects `session_id` and gets `null`, causing "Session unavailable" toasts. Always restart the backend after code changes before running manual regression.

**Backend module path: flow_sdk.server.run (not server.run)**
The server package is at `flow_sdk/server/`, not a top-level `server/` module. Use `uv run -m flow_sdk.server.run` from the repo root.

**Concurrent testers sharing one DB — isolation via clear before each test**
Multiple qa-testers running simultaneously on the same backend DB cause interference. The DB clear endpoint is `POST http://localhost:9008/api/v1/graph/compute_node/@local/desktop-db/clear`. Always clear before each scenario. However, concurrent clears from multiple testers can still collide — run DB-sensitive sniffer/agentic tests serially or as a single-tester batch.

**process_terminal_shell_tab_navigates_url: initialTabCount must start from 1 (clean DB)**
The test uses `initialTabCount + 1` for tab assertion. If the DB has leftover sessions from concurrent tests, `initialTabCount` > 1 and the assertion fails. Run with clean DB (single shell created) to get `initialTabCount = 1`.

**chat_refresh_persistence: use Playwright page.goto(sameUrl) not MCP navigation**
The scenario simulates refresh by re-navigating to the current URL. MCP browser sometimes creates a new shell instead of reusing the existing one (due to shared DB state). Playwright's `page.goto(shellUrl)` reliably returns to the same session. A Playwright `.md.ts` file was added (`chat_refresh_persistence.md.ts`) to automate this scenario.

**Playwright config per category, not global**
There is no `tests/manual_regression/playwright.config.ts`. Each category has its own config at `tests/manual_regression/<category>/playwright.config.ts`. Some categories (sniffer, assets) have no Playwright config at all — they require MCP browser execution only.

**Terminal tests need gotoShell() helper — data-terminal-id is not reliable**
The `data-terminal-id` selector from older chat scenarios is unreliable. Use `[data-testid="terminal-panels"]` and `[data-testid="terminal-panel"][data-active="true"] .xterm-rows` for terminal readiness checks. These are used in `helpers.ts:gotoShell()`.

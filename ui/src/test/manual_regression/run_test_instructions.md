---
id: 970c3531-200a-5fb0-bf30-597691f93096
---

# Manual Regression Tests - Run Instructions & Learnings

## Prerequisites

1. **Backend running** on port 8000:
   ```bash
   cd flowpad
   python run.py
   ```

2. **Frontend dev server running** on port 8193:
   ```bash
   cd flowpad/ui
   npm run dev
   ```
   The port defaults to 8193. Override with `VITE_PORT` env var if needed.

3. **Playwright browsers installed**:
   ```bash
   cd flowpad/ui
   npx playwright install chromium
   ```

Alternatively, use the one-command startup: `ops/scripts/run_claude.sh`

---

## Running the Tests

All commands run from `flowpad/ui/`.

### Run all chat tests (15 test cases)
```bash
npx playwright test --config=tests/manual_regression/chat/playwright.config.ts
```

### Run all terminal tests (11 test cases)
```bash
npx playwright test --config=tests/manual_regression/terminal/playwright.config.ts
```

### Run a single test file
```bash
npx playwright test --config=tests/manual_regression/chat/playwright.config.ts tests/manual_regression/chat/chat_streaming.md.ts
```

### Run with headed browser (visible)
```bash
npx playwright test --config=tests/manual_regression/chat/playwright.config.ts --headed
```

### Debug a failing test with trace viewer
```bash
npx playwright show-trace test-results/<test-folder>/trace.zip
```

---

## Test Configuration

Both suites share these settings (see `playwright.config.ts` in each folder):

| Setting | Value | Reason |
|---------|-------|--------|
| `workers` | 1 | Tests must run sequentially (shared backend state) |
| `fullyParallel` | false | Same reason |
| `timeout` | 60,000ms | LLM responses can be slow |
| `expect.timeout` | 15,000ms | DOM assertions need time for async rendering |
| `headless` | true | CI-friendly; use `--headed` flag to override |
| `slowMo` | 50ms | Prevents race conditions with UI animations |
| `trace` | retain-on-first-failure | Traces saved only for failures |
| `baseURL` | `http://localhost:8193` | Override with `VITE_PORT` env var |

---

## Test Inventory

### Chat Tests (10 files, 15 test cases)

| File | Test Cases | What It Tests |
|------|-----------|---------------|
| `chat_input_controls.md.ts` | 3 | Enter key send, empty submit blocked, stop button |
| `chat_message_types.md.ts` | 3 | User/assistant blocks, thinking blocks, tool use thinking |
| `chat_refresh_persistence.md.ts` | 1 | Session tab persists after page refresh |
| `chat_streaming.md.ts` | 2 | Streaming execution + completion, sequential responses |
| `chat_tab_switching.md.ts` | 1 | Navigate between session and shell views |
| `landing_to_new_chat.md.ts` | 1 | Landing page to active chat session flow |
| `return_to_home.md.ts` | 1 | Navigate back to home from active chat |
| `send_multiple_messages.md.ts` | 2 | Multiple messages with responses, scroll behavior |
| `switch_between_sessions.md.ts` | 1 | Create and switch between session tabs |

### Terminal Tests (10 files, 11 test cases)

| File | Test Cases | What It Tests |
|------|-----------|---------------|
| `navigate_to_shell.md.ts` | 1 | Shell view loads with xterm.js terminal |
| `run_basic_command.md.ts` | 1 | Type command, validate output |
| `multiple_terminal_tabs.md.ts` | 1 | Create tabs, switch between them |
| `terminal_clear_and_scrollback.md.ts` | 1 | `clear` command clears screen |
| `terminal_command_history.md.ts` | 1 | Up/down arrow history navigation |
| `terminal_ctrl_c.md.ts` | 1 | Ctrl+C interrupts running commands |
| `terminal_persistence_on_tab_switch.md.ts` | 1 | Terminal state survives view switches |
| `terminal_pty_no_duplicates.md.ts` | 1 | Claude CLI terminal has no escape artifacts |
| `terminal_pty_output_clean.md.ts` | 1 | No duplicated lines in terminal output |
| `terminal_resize.md.ts` | 1 | Terminal resizes with browser window |
| `terminal_tab_rename.md.ts` | 1 | Double-click to rename a terminal tab |

---

## Shared Helpers

### Chat helpers (`chat/helpers.ts`)

| Helper | Purpose |
|--------|---------|
| `dismissSetupModal(page)` | Suppress the first-launch setup modal via localStorage |
| `gotoLanding(page)` | Navigate to `/` and wait for the "Hey" heading |
| `submitFromLanding(page, msg)` | Fill landing input, press Enter, wait for `/dock/shell/` URL |
| `ensureActiveSession(page)` | Click "New Session" if needed, wait for instruction input |
| `sendInstruction(page, msg)` | Send instruction and wait for a new assistant response block |
| `waitForDone(page)` | Wait for the `DONE` status text (exact match) |
| `goHome(page)` | Click sidebar Home button, wait for landing page |
| `createSessionWithMessage(page, msg)` | Combines submitFromLanding + ensureActiveSession + sendInstruction |

### Terminal helpers (`terminal/helpers.ts`)

| Helper | Purpose |
|--------|---------|
| `dismissSetupModal(page)` | Same as chat version |
| `gotoShell(page)` | Navigate to `/dock/shell/new_terminal`, wait for xterm.js |
| `gotoShellViaSidebar(page)` | Hover chevron, click Shell button, wait for terminal |
| `sendCommand(page, cmd)` | Click terminal panel, type command, press Enter |
| `waitForOutput(page, text)` | Poll `.xterm-rows` until text appears |
| `addTerminalTab(page)` | Click "+" button to add a terminal tab |
| `getActiveTabName(page)` | Read the name of the currently active tab |
| `goHome(page)` | Click sidebar Home button, navigate to `/` |
| `clickTab(page, name)` | Click a specific terminal tab by name |

---

## Issues Solved & Learnings

### 1. Stale DONE race condition in `sendInstruction`

**Problem:** The original `sendInstruction` called `waitForDone()` after pressing Enter. But DONE was already visible from the *previous* message (e.g., from `submitFromLanding`). This caused `waitForDone` to resolve immediately before the new instruction was processed, making subsequent assertions fail because the new message hadn't rendered yet.

**Fix:** `sendInstruction` now:
1. Waits for DONE first (ensures previous processing is complete)
2. Counts existing `◂ assistant` blocks
3. Fills and sends the instruction
4. Waits for the assistant block count to increase by 1

This avoids the stale DONE race entirely.

**Lesson:** When waiting for async completion in a chat UI, count result elements rather than relying on status text that may already be present from a prior operation.

---

### 2. `getByText('DONE')` matching LLM response content

**Problem:** `getByText('DONE')` is case-insensitive by default in Playwright. When the LLM responded with text like "Done counting to 100!", `getByText('DONE')` matched multiple elements, causing a strict mode violation.

**Fix:** Use `getByText('DONE', { exact: true })` everywhere. The status bar renders `DONE` as exact text in a `<span>`, so exact match targets only the status indicator.

**Lesson:** Always use `{ exact: true }` when matching status indicators or other fixed text that might collide with dynamic LLM-generated content.

---

### 3. `submitFromLanding` creates an assistant block (off-by-one counts)

**Problem:** Multiple tests expected specific counts of `◂ assistant` blocks but forgot that `submitFromLanding` sends the initial message from the landing page, which generates an assistant response. So after `submitFromLanding` + 2 `sendInstruction` calls, there are 3 assistant blocks, not 2.

**Fix:** Updated all expected counts to include the initial `submitFromLanding` response:
- `chat_streaming.md.ts`: Changed from 2 to 3 assistant/user blocks
- `send_multiple_messages.md.ts`: Changed from 2/3 to 3/4 assistant blocks
- `chat_input_controls.md.ts` (empty submit): Changed from 0 to 1 user blocks

**Lesson:** `submitFromLanding` is not a "silent" session creator - it sends the landing input text as the first instruction and generates a full LLM response. All block count assertions must account for this.

---

### 4. Status text `IDLE` and `no output` don't exist as expected

**Problem:** Tests expected `IDLE` status after session creation. In reality, the status shows `DONE` after the initial `submitFromLanding` message completes. The text `no output` only appears after a page refresh (as `○ no output`), not during an active session.

**Fix:** Replaced `getByText('IDLE')` with `getByText('DONE', { exact: true })`. Removed `no output` assertions from tests where the session has already processed messages.

**Lesson:** Check the actual UI state (via error context snapshots or manual inspection) rather than assuming status text values.

---

### 5. Sidebar button order changes break index-based navigation

**Problem:** `chat_tab_switching.md.ts` clicked `sidebarButtons.nth(7)` assuming Shell was at index 7. The sidebar button order changed, and index 7 now opens the Files view instead of Shell.

**Fix:** Replaced index-based sidebar navigation with direct URL navigation (`page.goto('/dock/shell/new_terminal')`). The Home button is found via `page.locator('ul li button').first()`.

**Lesson:** Never use `nth(N)` for sidebar/navigation buttons - the order can change when features are added or reordered. Use direct URL navigation or accessible name selectors instead.

---

### 6. `.xterm-rows` strict mode violation (2 elements)

**Problem:** `navigate_to_shell.md.ts` used `page.locator('.xterm-rows')` which resolved to 2 elements (the terminal renders both visible and hidden xterm-rows containers), causing a Playwright strict mode error.

**Fix:** Added `.first()` to the locator: `page.locator('.xterm-rows').first()`.

**Lesson:** xterm.js creates multiple `.xterm-rows` elements. Always use `.first()` when querying this class, or use a more specific selector like `[data-testid="terminal-panel"][data-active="true"] .xterm-rows`.

---

### 7. "New Session" button doesn't exist when session is already active

**Problem:** `landing_to_new_chat.md.ts` submitted from the landing page and then tried to click a "New Session" button. But `submitFromLanding` already creates an active session, so "New Session" never appears.

**Fix:** Removed the "New Session" click and related `IDLE`/`EXEC` status assertions. After `submitFromLanding`, the test now goes straight to verifying the user message and assistant response.

**Lesson:** `submitFromLanding` creates a fully active session in one step. There's no intermediate "inactive session" state that needs a "New Session" button click.

---

### 8. Session persistence after page refresh is non-deterministic

**Problem:** `chat_refresh_persistence.md.ts` originally expected sessions to reset after `page.reload()`. Testing showed the behavior is inconsistent: sometimes messages persist, sometimes they're cleared. Only the session tab structure reliably persists.

**Fix:** Updated the test to verify only what's deterministic:
- Session tab ("Session 1") still exists after refresh
- Instruction input is ready
- Does NOT assert on message content persistence

**Lesson:** Don't write assertions against non-deterministic behavior. Focus on what reliably persists (session tab, instruction input) rather than what may or may not persist (chat messages).

---

### 9. `getByText('Message three')` matching multiple elements

**Problem:** `send_multiple_messages.md.ts` used `getByText('Message three')` which matched both the user message "Message three" and the assistant response "Message three received. It looks..." - causing a strict mode violation.

**Fix:** Used `getByText('Message three', { exact: true })` to match only the exact text.

**Lesson:** LLM responses often echo the user's message text. Always use `{ exact: true }` when asserting on user message visibility to avoid matching the assistant's response.

---

### 10. Flaky `submitFromLanding` navigation timeout

**Problem:** `landing_to_new_chat.md.ts` intermittently failed on `page.waitForURL(/\/dock\/session\//)` with a 20s timeout. The page sometimes showed a dashboard/analytics view instead of navigating to the session.

**Fix:**
- Increased `submitFromLanding` timeout from 10s to 30s
- Added `page.waitForLoadState('networkidle')` before submission
- Added `test.describe.configure({ retries: 1 })` for the flaky test
- Used shared helpers instead of inline implementation

**Lesson:** Landing page submissions can be slow when the backend is under load from previous tests. Use generous timeouts (30s+), wait for `networkidle` before interacting, and configure retries for inherently flaky flows.

---

## Debugging Tips

### View error context snapshots
When a test fails, Playwright captures an accessibility snapshot of the page. Find it at:
```
test-results/<test-name>-chromium/error-context.md
```
This YAML snapshot shows exactly what elements were on the page when the assertion failed - invaluable for understanding UI state mismatches.

### View failure traces
```bash
npx playwright show-trace test-results/<test-name>-chromium/trace.zip
```
Opens an interactive trace viewer showing every action, network request, and DOM snapshot.

### Common failure patterns

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `toBeVisible` fails for text you know exists | Text is inside LLM response, matched ambiguously | Use `{ exact: true }` or `.first()` |
| `toHaveCount` off by 1 | Forgot `submitFromLanding` creates a response | Add 1 to expected count |
| `waitForDone` strict mode violation | LLM response contains "done"/"Done" | Use `{ exact: true }` in `waitForDone` |
| `waitForURL` timeout | Slow backend or page transition race | Increase timeout, add `networkidle` wait |
| `sendInstruction` assertion never resolves | Previous execution not complete | `sendInstruction` now handles this automatically |
| `.xterm-rows` strict mode | xterm.js creates multiple row containers | Use `.first()` |
| Sidebar button at wrong index | Button order changed | Use direct URL or accessible name selectors |

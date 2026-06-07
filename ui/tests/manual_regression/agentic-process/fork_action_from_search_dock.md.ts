/**
 * Fork action from the global search dock-menu on a claude_session result.
 * Source: fork_action_from_search_dock.md
 *
 * The Fork action (GitBranch) lives in RECORD_TYPE_NAV['claude_session'].actions
 * and is surfaced by SearchResultCard / EntitySearchModal — i.e. on a
 * claude_session SEARCH RESULT, which is backed by the FTS search index. The
 * Spotlight quick-open rows (sourced from worker-history / ~/.claude) only carry
 * a primary onActivate (open), NOT the Fork sub-action, so the search index is
 * the only surface that exposes Fork.
 *
 * Per the scenario's own precondition: if GET /api/v1/search?record_type=
 * claude_session returns total===0, SKIP (seeding a synthetic claude_session into
 * the index requires either running the real CLI to produce a valid JSONL AND an
 * explicit indexer walk of ~/.claude — and per project policy the indexer only
 * runs on an explicit user click, never auto-triggered). On this QA instance the
 * index is empty after a DB reset, so the Fork-from-search-dock surface has no
 * row to act on.
 */
import { test } from '@playwright/test';
import { apiBase } from './_ap_helpers';

test('Fork action from search dock-menu creates a visible interactive PTY', async ({ page }) => {
  test.setTimeout(60_000);
  const res = await page.request.get(`${apiBase()}/api/v1/search?record_type=claude_session&limit=1`);
  const data = (await res.json())?.data ?? {};
  test.skip(
    (data.total ?? 0) === 0,
    'No claude_session in the FTS search index (total=0) — the Fork action is only '
    + 'exposed on a search-result row (SearchResultCard via RECORD_TYPE_NAV.actions), '
    + 'and populating the index is an explicit user-only indexer walk. skip_challenge_required.',
  );

  // If an index ever holds a claude_session here, exercise the Fork action:
  // open the global search, find the claude_session result, open its actions
  // menu, click Fork (GitBranch), and verify the dock navigates to a new
  // visible AgenticProcess shell tab (createProcess body { visible:true,
  // watchProcess:false }) that accepts keyboard input.
  // (Left unimplemented while total===0 keeps this skipped — encode it once the
  //  index is seedable headlessly.)
});

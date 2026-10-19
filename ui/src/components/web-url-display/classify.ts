/**
 * Decide what the display must do about an external page.
 *
 * Pure on purpose, like `webapp-display/classify.ts`. Only two findings count,
 * because only two are true for the user as well as for the backend:
 *
 *   frame_blocked → the site refuses to be framed; hand it to the browser
 *   unreachable   → nothing answers at that address; warn over the frame
 *
 * The HTTP status is deliberately NOT a finding. The backend fetches without the
 * user's cookies, so a private GitHub page 404s there and loads here, and a bot
 * filter 403s there and not in the browser. Warning on it would cover pages that
 * work.
 */

/** Result of `POST /api/v1/web/status` (`flow_sdk/core/webpage_status.py`). */
export interface WebpageStatus {
  url: string;
  reachable: boolean;
  http_status: number | null;
  nav_error: string | null;
  frame_blocked: boolean;
  frame_block_reason: string | null;
}

export type WebpageIssue = 'frame_blocked' | 'unreachable';

/** Failures the browser's own navigation would hit too. `probe_error` is ours, not the page's. */
const UNREACHABLE_ERRORS = new Set(['invalid_url', 'dns_failure', 'connection_refused', 'timeout', 'redirect_loop', 'not_http']);

export function classifyWebpageStatus(status: WebpageStatus | null): WebpageIssue | null {
  if (!status) return null;
  if (status.frame_blocked) return 'frame_blocked';
  if (status.nav_error && UNREACHABLE_ERRORS.has(status.nav_error)) return 'unreachable';
  return null;
}

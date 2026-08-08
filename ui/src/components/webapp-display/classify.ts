/**
 * Decide what the display should show for a web app, from every signal we can
 * actually get.
 *
 * This is deliberately pure and framework-free: no React, no fetch, no lingui.
 * The whole point of the component is that it behaves correctly across a wide
 * matrix of failures, and a pure function is the only way to test that matrix
 * exhaustively for free. Anything stateful -- polling, debouncing, holding a
 * verdict steady while a repair runs -- belongs in `useWebappDiagnostics`.
 *
 * The governing question for every branch below is **"can the user see and use
 * the app?"**. If no, we replace the frame (`fatal`); if yes but something is
 * wrong, we overlay a banner (`degraded`). That single rule is what keeps the
 * UI predictable when signals disagree, which they routinely do -- a `no-cors`
 * liveness ping resolves happily against a server returning 500.
 */

/** Reachability from the browser. Mirrors `useWebappHealth`. */
export type WebappHealth = 'checking' | 'up' | 'down';

export type WebappSeverity = 'unknown' | 'ok' | 'degraded' | 'fatal';

/** A machine-readable cause. Mapped to human copy in `messages.tsx`. */
export type WebappIssueCode =
  | 'starting'
  | 'not_running'
  | 'not_http'
  | 'server_error'
  | 'not_found'
  | 'blank_page'
  | 'hung'
  | 'redirect_loop'
  | 'crashed'
  | 'console_errors'
  | 'failed_requests'
  | 'ok';

/** Result of the backend `probe-webapp` action (Level A + optional Level B). */
export interface WebappProbe {
  reachable: boolean;
  is_http: boolean;
  http_status: number | null;
  content_length: number | null;
  blank: boolean;
  nav_error: string | null;
  probe_error: string | null;
  // Level B: only a real browser can see these, so the backend omits them
  // entirely until that probe exists. They are OPTIONAL on the wire -- reading
  // them as guaranteed arrays crashes the display against a Level A payload.
  deep_ran?: boolean;
  console_errors?: string[];
  page_errors?: string[];
  failed_requests?: { url: string; status: string | number }[];
}

export interface WebappSignals {
  health: WebappHealth;
  probe: WebappProbe | null;
  /** Consecutive failed liveness polls; one blip must not condemn an app. */
  consecutiveFailures: number;
  /** Has the frame ever loaded successfully in this session? */
  everLoaded: boolean;
  /** Still inside the post-mount window where a dev server may be compiling. */
  withinGrace: boolean;
}

export interface WebappVerdict {
  severity: WebappSeverity;
  code: WebappIssueCode;
  /** Technical lines for the Details disclosure and the repair agent. */
  detail: string[];
}

/**
 * A server that is still booting refuses connections exactly like a server that
 * is dead. Requiring two consecutive failures keeps a single dropped poll from
 * flipping a healthy app into the error UI (and, worse, spending tokens on an
 * automatic repair of nothing).
 */
export const FAILURE_THRESHOLD = 2;

function probeDetail(probe: WebappProbe): string[] {
  const detail: string[] = [];
  if (probe.http_status != null) detail.push(`HTTP ${probe.http_status}`);
  // Response size is the difference between "served an empty page" and "served
  // nothing" — the first thing a repair agent needs for a blank-page report.
  if (probe.content_length != null) detail.push(`${probe.content_length} bytes`);
  if (probe.reachable && !probe.is_http) detail.push('not speaking HTTP');
  if (probe.nav_error) detail.push(`nav: ${probe.nav_error}`);
  if (probe.probe_error) detail.push(`probe: ${probe.probe_error}`);
  detail.push(...(probe.page_errors ?? []).map((e) => `uncaught: ${e}`));
  detail.push(...(probe.console_errors ?? []).map((e) => `console: ${e}`));
  detail.push(...(probe.failed_requests ?? []).map((r) => `failed ${r.status}: ${r.url}`));
  return detail;
}

export function classifyWebappSeverity(signals: WebappSignals): WebappVerdict {
  const { health, probe, consecutiveFailures, everLoaded, withinGrace } = signals;

  // --- nothing known yet ---------------------------------------------------
  // A dev server compiling for a few seconds must read as "starting", never as
  // "broken". Only an app that has never loaded gets this benefit: once it has
  // rendered, a disappearance is a real regression and we say so immediately.
  if (!everLoaded && withinGrace && !probe?.reachable) {
    return { severity: 'unknown', code: 'starting', detail: [] };
  }
  if (health === 'checking' && !probe) {
    return { severity: 'unknown', code: 'starting', detail: [] };
  }

  // --- the probe is authoritative when we have one -------------------------
  if (probe) {
    const detail = probeDetail(probe);

    if (!probe.reachable) {
      // A probe can land between a restart's teardown and its listen, so an app
      // that was working gets the benefit of the doubt until the INDEPENDENT
      // liveness poll agrees. Once both say the port is gone, that is not a
      // blip and there is nothing to wait for — note we deliberately do NOT
      // also require a failure count here: `health` is a level, not an edge, so
      // counting transitions would stall at 1 and never condemn a dead app.
      if (everLoaded && health !== 'down') {
        return { severity: 'unknown', code: 'starting', detail };
      }
      return { severity: 'fatal', code: 'not_running', detail };
    }
    if (probe.nav_error === 'not_http') return { severity: 'fatal', code: 'not_http', detail };
    if (probe.nav_error === 'redirect_loop') return { severity: 'fatal', code: 'redirect_loop', detail };
    if (probe.nav_error === 'timeout') return { severity: 'fatal', code: 'hung', detail };
    if (probe.http_status != null && probe.http_status >= 500)
      return { severity: 'fatal', code: 'server_error', detail };
    if (probe.http_status != null && probe.http_status >= 400)
      return { severity: 'fatal', code: 'not_found', detail };
    // An uncaught exception is only fatal if it stopped the page from painting.
    // Level B tells us that; without it, a page error is a warning, not a wipe.
    const pageErrors = probe.page_errors ?? [];
    const consoleErrors = probe.console_errors ?? [];
    const failedRequests = probe.failed_requests ?? [];

    if (probe.deep_ran && pageErrors.length > 0 && probe.blank)
      return { severity: 'fatal', code: 'crashed', detail };
    if (probe.blank) return { severity: 'fatal', code: 'blank_page', detail };

    if (pageErrors.length > 0 || consoleErrors.length > 0)
      return { severity: 'degraded', code: 'console_errors', detail };
    if (failedRequests.length > 0)
      return { severity: 'degraded', code: 'failed_requests', detail };

    return { severity: 'ok', code: 'ok', detail: [] };
  }

  // --- no probe: fall back to the one browser signal that works ------------
  if (health === 'down') {
    if (consecutiveFailures < FAILURE_THRESHOLD && everLoaded) {
      return { severity: 'unknown', code: 'starting', detail: [] };
    }
    return { severity: 'fatal', code: 'not_running', detail: [] };
  }
  return { severity: 'ok', code: 'ok', detail: [] };
}

/**
 * The fault matrix for the web-app display.
 *
 * Each case names a way a real dev server misbehaves and asserts what the user
 * should end up looking at. The rule under test is "can the user see and use the
 * app?" -- `fatal` replaces the frame, `degraded` keeps it and adds a banner --
 * so the cases that matter most are the ones where the naive signal disagrees
 * with that rule (a 500 that a liveness ping calls "up", an empty React shell
 * that looks blank but isn't).
 */
import { describe, expect, it } from 'vitest';
import {
  FAILURE_THRESHOLD,
  classifyWebappSeverity,
  type WebappProbe,
  type WebappSignals,
  type WebappSeverity,
  type WebappIssueCode,
} from '@src/components/webapp-display/classify';

function probe(overrides: Partial<WebappProbe> = {}): WebappProbe {
  return {
    reachable: true,
    is_http: true,
    http_status: 200,
    content_length: 120,
    blank: false,
    nav_error: null,
    deep_ran: false,
    console_errors: [],
    page_errors: [],
    failed_requests: [],
    probe_error: null,
    ...overrides,
  };
}

function signals(overrides: Partial<WebappSignals> = {}): WebappSignals {
  return {
    health: 'up',
    probe: probe(),
    consecutiveFailures: 0,
    everLoaded: true,
    withinGrace: false,
    ...overrides,
  };
}

interface Case {
  name: string;
  signals: WebappSignals;
  severity: WebappSeverity;
  code: WebappIssueCode;
}

const CASES: Case[] = [
  {
    name: 'healthy app renders with no chrome',
    signals: signals(),
    severity: 'ok',
    code: 'ok',
  },
  {
    name: 'no server listening (the original blank-pane bug)',
    signals: signals({
      health: 'down',
      consecutiveFailures: FAILURE_THRESHOLD,
      probe: probe({ reachable: false, is_http: false, http_status: null, nav_error: 'connection_refused' }),
    }),
    severity: 'fatal',
    code: 'not_running',
  },
  {
    name: 'server returns 500 while the liveness ping still reads up',
    signals: signals({ health: 'up', probe: probe({ http_status: 500 }) }),
    severity: 'fatal',
    code: 'server_error',
  },
  {
    name: 'server returns 404',
    signals: signals({ probe: probe({ http_status: 404 }) }),
    severity: 'fatal',
    code: 'not_found',
  },
  {
    name: 'page is genuinely blank with no script to fill it',
    signals: signals({ probe: probe({ blank: true, content_length: 30 }) }),
    severity: 'fatal',
    code: 'blank_page',
  },
  {
    name: 'empty SPA shell is healthy, not blank',
    signals: signals({ probe: probe({ blank: false, content_length: 90 }) }),
    severity: 'ok',
    code: 'ok',
  },
  {
    name: 'server accepts but never responds',
    signals: signals({ probe: probe({ nav_error: 'timeout', http_status: null }) }),
    severity: 'fatal',
    code: 'hung',
  },
  {
    name: 'redirect loop',
    signals: signals({ probe: probe({ nav_error: 'redirect_loop', http_status: null }) }),
    severity: 'fatal',
    code: 'redirect_loop',
  },
  {
    name: 'port held by something that is not a web server',
    signals: signals({ probe: probe({ nav_error: 'not_http', http_status: null }) }),
    severity: 'fatal',
    code: 'not_http',
  },
  {
    name: 'uncaught exception that stopped the page painting',
    signals: signals({
      probe: probe({ deep_ran: true, blank: true, page_errors: ['TypeError: x is not a function'] }),
    }),
    severity: 'fatal',
    code: 'crashed',
  },
  {
    name: 'console errors on a page that still renders',
    signals: signals({ probe: probe({ deep_ran: true, console_errors: ['boom'] }) }),
    severity: 'degraded',
    code: 'console_errors',
  },
  {
    name: 'uncaught exception after paint keeps the app visible',
    signals: signals({ probe: probe({ deep_ran: true, page_errors: ['late boom'] }) }),
    severity: 'degraded',
    code: 'console_errors',
  },
  {
    name: 'failed subresource keeps the app visible',
    signals: signals({
      probe: probe({ deep_ran: true, failed_requests: [{ url: '/app.js', status: 404 }] }),
    }),
    severity: 'degraded',
    code: 'failed_requests',
  },
  {
    name: 'still booting: never loaded, inside grace',
    signals: signals({
      health: 'down',
      everLoaded: false,
      withinGrace: true,
      consecutiveFailures: 1,
      probe: probe({ reachable: false, nav_error: 'connection_refused' }),
    }),
    severity: 'unknown',
    code: 'starting',
  },
  {
    name: 'one dropped poll on a working app does not condemn it',
    signals: signals({
      health: 'up',
      everLoaded: true,
      consecutiveFailures: 1,
      probe: probe({ reachable: false, nav_error: 'connection_refused' }),
    }),
    severity: 'unknown',
    code: 'starting',
  },
  {
    // Regression: `health` is a LEVEL, not an edge. The failure counter is
    // incremented on transitions, so once liveness settles on `down` it stops
    // at 1 — gating on it here left a dead app stuck in `starting` forever,
    // which is the exact blank-pane bug this feature exists to fix.
    name: 'dead app is fatal even though the failure counter stalled at one',
    signals: signals({
      health: 'down',
      everLoaded: true,
      consecutiveFailures: 1,
      probe: probe({ reachable: false, nav_error: 'connection_refused' }),
    }),
    severity: 'fatal',
    code: 'not_running',
  },
  {
    name: 'app that was working and truly died is fatal at once',
    signals: signals({
      health: 'down',
      everLoaded: true,
      consecutiveFailures: FAILURE_THRESHOLD,
      probe: probe({ reachable: false, nav_error: 'connection_refused' }),
    }),
    severity: 'fatal',
    code: 'not_running',
  },
  {
    name: 'no probe yet, health still checking',
    signals: signals({ health: 'checking', probe: null }),
    severity: 'unknown',
    code: 'starting',
  },
  {
    name: 'no probe available, health down past threshold',
    signals: signals({ health: 'down', probe: null, consecutiveFailures: FAILURE_THRESHOLD }),
    severity: 'fatal',
    code: 'not_running',
  },
];

describe('classifyWebappSeverity', () => {
  it.each(CASES)('$name', ({ signals: input, severity, code }) => {
    const verdict = classifyWebappSeverity(input);
    expect({ severity: verdict.severity, code: verdict.code }).toEqual({ severity, code });
  });

  it('never shows the error UI while an app has not had a chance to boot', () => {
    // The most damaging false positive: telling a user their app is broken --
    // and spending tokens repairing it -- while a dev server is still compiling.
    const booting = classifyWebappSeverity(
      signals({
        health: 'down',
        everLoaded: false,
        withinGrace: true,
        consecutiveFailures: 5,
        probe: probe({ reachable: false, nav_error: 'connection_refused' }),
      }),
    );
    expect(booting.severity).toBe('unknown');
  });

  it('handles the real Level A payload, which omits the Level B fields entirely', () => {
    // Regression: every other case here builds a probe through a factory that
    // fills in `console_errors`/`page_errors`/`failed_requests`. The backend
    // does NOT send them — only a browser can see those — so the classifier was
    // calling `.map()` on undefined and crashing the whole display. Construct
    // the wire shape literally, exactly as `blank_result()` returns it.
    const wirePayload = {
      port: 4321,
      url: 'http://localhost:4321',
      reachable: true,
      is_http: true,
      http_status: 200,
      content_length: 180,
      blank: false,
      nav_error: null,
      probe_error: null,
    } as unknown as WebappProbe;

    const verdict = classifyWebappSeverity(signals({ probe: wirePayload }));
    expect(verdict.severity).toBe('ok');

    const dead = classifyWebappSeverity(
      signals({
        health: 'down',
        consecutiveFailures: FAILURE_THRESHOLD,
        probe: { ...wirePayload, reachable: false, is_http: false, http_status: null, nav_error: 'connection_refused' },
      }),
    );
    expect(dead).toMatchObject({ severity: 'fatal', code: 'not_running' });
    expect(dead.detail).toContain('nav: connection_refused');
  });

  it('carries technical detail for the repair agent without surfacing it as the headline', () => {
    const verdict = classifyWebappSeverity(
      signals({
        probe: probe({
          http_status: 500,
          deep_ran: true,
          page_errors: ['TypeError: cannot read x'],
          failed_requests: [{ url: '/api/items', status: 502 }],
        }),
      }),
    );
    expect(verdict.severity).toBe('fatal');
    expect(verdict.detail).toContain('HTTP 500');
    expect(verdict.detail).toContain('uncaught: TypeError: cannot read x');
    expect(verdict.detail).toContain('failed 502: /api/items');
  });
});

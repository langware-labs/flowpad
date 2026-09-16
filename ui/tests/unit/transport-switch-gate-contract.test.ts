import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { surfaceTransportGate } from '@src/components/terminal/interactive-terminal/use-process-surface';
import { ViewMode } from '@src/contexts/view-mode-context';

/**
 * TS half of the transport-switch gate contract (FLOWPAD-2105).
 *
 * `surfaceTransportGate` is read by BOTH the `useProcessSurface` reconcile
 * effect and the footer `ViewToggle`'s greyed-out state, so the two halves of
 * the app cannot disagree about what is possible. This file pins that predicate
 * to `test_fixtures/status_sets.json`, the same file the Python contract test
 * (`tests/unit/test_transport_switch_gate_contract.py`) loads to assert the
 * BACKEND refusal is the same question. Editing one side without the other
 * breaks both.
 *
 * What the fixture pins, per row:
 *   needs_switch     — would the client issue a lifecycle call at all
 *   blocked          — …and does the client refuse it right now
 *   backend_route    — which action that call lands on
 *   backend_refuses  — whether THAT route 409s (Python asserts this half)
 *
 * Both directions now go through the guarded `switch-mode` action, so the last
 * two columns agree everywhere: `blocked === backend_refuses` on every row. That
 * was an asymmetry until FLOWPAD-2130 — `→terminal` routed through the unguarded
 * `open`, so the client refused nothing there and a mid-turn click spawned a PTY
 * onto the session a live headless turn was writing, losing it.
 */

interface TransportSwitchCase {
  label: string;
  status: string;
  busy: boolean;
  pty_mode: boolean;
  session_id: string | null;
  view_mode: string;
  needs_switch: boolean;
  blocked: boolean;
  backend_route: string | null;
  backend_refuses: boolean;
}

const FIXTURE_PATH = resolve(__dirname, '../../../test_fixtures/status_sets.json');
const fixture: { transport_switch_cases: TransportSwitchCase[] } = JSON.parse(
  readFileSync(FIXTURE_PATH, 'utf-8'),
);

/** The wire shape `surfaceTransportGate` reads: `isHeadless` is the SDK's
 *  `pty_mode === false`, and `busy` is the backend's own `is_turn_busy` answer
 *  serialized onto the entity — the client never recomputes it. */
const processFrom = (c: TransportSwitchCase) =>
  ({
    isHeadless: c.pty_mode === false,
    status: c.status,
    busy: c.busy,
    pty_mode: c.pty_mode,
    session_id: c.session_id,
  }) as never;

const VIEW_MODES: Record<string, ViewMode> = {
  vibe: ViewMode.Vibe,
  standard: ViewMode.Standard,
  advanced: ViewMode.Advanced,
  dev: ViewMode.Dev,
};

describe('transport switch gate — TS half of the cross-language contract', () => {
  const cases = fixture.transport_switch_cases;

  it('the fixture carries the shared truth table', () => {
    expect(cases?.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.label, c] as const))('%s', (_label, c) => {
    const mode = VIEW_MODES[c.view_mode];
    expect(mode, `unknown view_mode ${c.view_mode}`).toBeDefined();
    expect(surfaceTransportGate(processFrom(c), mode)).toEqual({
      needsSwitch: c.needs_switch,
      route: c.backend_route,
      blocked: c.blocked,
    });
  });

  it('never blocks a pick that issues no call — the two flags cannot both be wrong', () => {
    // `blocked` is only meaningful when a call would be made. A row that gates
    // a no-op pick would grey a segment for no reason the user can act on, and
    // chat⇄vibe is exactly that pick: it moves no worker, so it must stay live
    // through the busiest turn. Reading the conversation is not a lifecycle
    // action.
    for (const c of cases) {
      if (!c.needs_switch) expect(c.blocked, c.label).toBe(false);
    }
  });

  it('blocks exactly what the server refuses — no more, no less', () => {
    // The whole contract in one line. A client STRICTER than the server greys a
    // button the backend would have honoured, which tells the user something
    // untrue about the system; a client LOOSER sends a call that 409s. Neither
    // is acceptable, so this is equality, not an inequality.
    for (const c of cases) {
      expect(c.blocked, c.label).toBe(c.backend_refuses);
    }
  });

  it('only the switch-mode route ever refuses, and only while busy', () => {
    for (const c of cases) {
      const expected = c.backend_route === 'switch-mode' && c.busy;
      expect(c.blocked, c.label).toBe(expected);
    }
  });

  it('routes every transport switch at `switch-mode`, never at the unguarded `open`', () => {
    // `_reject_if_turn_in_flight` is invoked only from `switch_mode` and
    // `http_restart`, so a switch routed at `open` is an unguarded one
    // (FLOWPAD-2130). Guarding `open` itself is FLOWPAD-2117, deliberately apart.
    const switching = cases.filter((c) => c.needs_switch);
    expect(switching.length).toBeGreaterThan(0);
    for (const c of switching) {
      expect(c.backend_route, c.label).toBe('switch-mode');
    }

    const midTurnToTerminal = switching.filter((c) => c.busy && !c.pty_mode);
    expect(midTurnToTerminal.length, 'fixture must cover a mid-turn →terminal').toBeGreaterThan(0);
    for (const c of midTurnToTerminal) {
      expect(c.backend_refuses, c.label).toBe(true);
      expect(c.blocked, c.label).toBe(true);
    }
  });
});

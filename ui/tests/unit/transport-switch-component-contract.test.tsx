import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * COMPONENT-level half of the transport-switch contract (FLOWPAD-2105).
 *
 * The sibling `transport-switch-gate-contract.test.ts` pins the pure predicate.
 * This file pins the two things the user actually touches, driven with the
 * SAME server-shaped busy state the backend would be carrying:
 *
 *   • the footer `ViewToggle` — which segment greys, and whether a click on it
 *     navigates (running the REAL `useViewToggleGate`, not a stub);
 *   • `useProcessSurface` — which lifecycle call, if any, actually goes out.
 *
 * and asserts both behave the way the ROUTE each direction lands on behaves:
 *
 *   →chat / →vibe  → `switch-mode`, which 409s mid-turn  ⇒ refused mid-turn
 *   →terminal      → `open`, which has NO mid-turn guard  ⇒ allowed mid-turn
 *
 * The rows come from `test_fixtures/status_sets.json`, the same file the Python
 * contract test loads, so "what the server does" is not restated here — it is
 * read from the shared table and asserted against on both sides.
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
const CASES: TransportSwitchCase[] = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')).transport_switch_cases;

// ─── The one piece of state both components read ─────────────────────────────
// `busy` is the backend's own `is_turn_busy` answer serialized onto the entity;
// the client never recomputes it. Feeding the fixture row straight in is what
// makes this "the same busy state as the server".
const live = vi.hoisted(() => ({
  proc: null as unknown,
  mode: 'standard' as string,
  ptyMode: false as boolean,
}));

const switchMode = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const openDock = vi.hoisted(() => vi.fn());

vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: live.proc }) }));
vi.mock('@src/hooks/use-preference', () => ({
  usePreferenceResolved: () => true,
  usePreference: () => [live.mode, () => {}],
}));
vi.mock('@src/notifications/notify', () => ({ notify: { error: vi.fn() } }));

const dock = vi.hoisted(() => ({
  get viewMode() {
    return live.mode;
  },
  withViewMode(next: string) {
    return { pointer: 'agentic_process-x', viewMode: next };
  },
}));
vi.mock('@src/navigation', () => ({
  useDockNavigation: () => ({ currentDock: dock, navigation: { openDock } }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => dock,
  useDockNavigation: () => ({ currentDock: dock, navigation: { openDock } }),
}));

import { ViewMode } from '@src/contexts/view-mode-context';
import { resetRevealedModes, ViewToggle } from '@src/components/view-toggle/view-toggle';
import {
  resetSurfaceReconcileState,
  useProcessSurface,
} from '@src/components/terminal/interactive-terminal/use-process-surface';

const VIEW_MODES: Record<string, ViewMode> = {
  vibe: ViewMode.Vibe,
  standard: ViewMode.Standard,
  advanced: ViewMode.Advanced,
  dev: ViewMode.Dev,
};

/** The entity as the wire delivers it for this row. */
function processFor(c: TransportSwitchCase) {
  return {
    id: 'p-1',
    typeId: { type: 'agentic_process', id: 'p-1' },
    get isHeadless() {
      return live.ptyMode === false;
    },
    status: c.status,
    busy: c.busy,
    pty_mode: c.pty_mode,
    session_id: c.session_id,
    switchMode,
    loadHistory: () => Promise.resolve(),
  } as never;
}

function Surface() {
  useProcessSurface({ process: live.proc as never });
  return null;
}

/** Mount the session on the row's STARTING transport, then move the view mode
 *  to the row's target — the real previous→current transition the effect acts
 *  on (it reconciles on a CHANGE, never on first sight). */
async function driveSurfaceTo(c: TransportSwitchCase) {
  const startMode = c.pty_mode ? ViewMode.Advanced : ViewMode.Standard;
  live.mode = startMode;
  live.ptyMode = c.pty_mode;
  live.proc = processFor(c);
  const view = render(<Surface />);
  await act(async () => {});

  live.mode = VIEW_MODES[c.view_mode];
  view.rerender(<Surface />);
  await act(async () => {});
  return view;
}

beforeEach(() => {
  localStorage.clear();
  switchMode.mockClear();
  openDock.mockClear();
  resetSurfaceReconcileState();
  resetRevealedModes();
});
afterEach(cleanup);

describe('the reconcile effect issues exactly the call the route accepts', () => {
  // Only rows that are a real transition from the row's own starting transport.
  const switching = CASES.filter((c) => c.needs_switch);

  it.each(switching.map((c) => [c.label, c] as const))('%s', async (_label, c) => {
    await driveSurfaceTo(c);

    if (c.blocked) {
      // Refused — because `switch-mode` would 409 on this exact `busy`.
      expect(switchMode).not.toHaveBeenCalled();
      return;
    }
    // Allowed — and it must reach the route the fixture names.
    expect(switchMode).toHaveBeenCalledTimes(1);
    const [mode] = switchMode.mock.calls[0] as unknown as [string];
    expect(mode).toBe(c.backend_route === 'open' ? 'interactive' : 'cli');
  });

  it('a mid-turn →terminal really does go out, because `open` has no guard', async () => {
    // The behaviour the client mirrors rather than second-guesses. If a guard is
    // ever added to `open`, the fixture flips and this expectation flips with it.
    const c = CASES.find((r) => r.backend_route === 'open' && r.busy);
    expect(c, 'fixture must cover a mid-turn →terminal').toBeDefined();

    await driveSurfaceTo(c!);

    expect(switchMode).toHaveBeenCalledTimes(1);
    expect(switchMode).toHaveBeenCalledWith('interactive', undefined);
  });

  it('a mid-turn →chat does NOT go out, because `switch-mode` 409s', async () => {
    const c = CASES.find((r) => r.backend_route === 'switch-mode' && r.busy);
    expect(c, 'fixture must cover a mid-turn →chat').toBeDefined();

    await driveSurfaceTo(c!);

    expect(switchMode).not.toHaveBeenCalled();
  });
});

describe('the ViewToggle greys exactly what the effect would refuse', () => {
  const seg = (m: string) => screen.getByTestId(`view-toggle-${m}`);

  it.each(CASES.map((c) => [c.label, c] as const))('%s', (_label, c) => {
    // The control reads the same live entity the effect does.
    live.ptyMode = c.pty_mode;
    live.proc = processFor(c);
    // Dev renders only once revealed (double-click on Terminal) or when it IS
    // the mode, so a Dev row has to be viewed FROM Dev for its segment to exist
    // at all. Every other row starts on the transport it is currently running.
    live.mode =
      c.view_mode === 'dev' ? ViewMode.Dev : c.pty_mode ? ViewMode.Advanced : ViewMode.Standard;
    render(<ViewToggle />);

    const target = seg(VIEW_MODES[c.view_mode]);
    expect(target.getAttribute('aria-disabled')).toBe(c.blocked ? 'true' : null);

    // …and greying is exactly "the server would refuse this", nothing more.
    expect(c.blocked).toBe(c.backend_refuses);
  });

  it('leaves →terminal clickable mid-turn, and refuses →chat', () => {
    // The user-visible shape of the asymmetry, asserted end-to-end through the
    // real component and the real gate.
    const busyPty = CASES.find((r) => r.backend_route === 'switch-mode' && r.busy)!;
    live.ptyMode = true;
    live.proc = processFor(busyPty);
    live.mode = ViewMode.Advanced;
    const view = render(<ViewToggle />);

    expect(seg(ViewMode.Standard).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(seg(ViewMode.Standard));
    expect(openDock).not.toHaveBeenCalled();

    view.unmount();
    const busyHeadless = CASES.find((r) => r.backend_route === 'open' && r.busy)!;
    live.ptyMode = false;
    live.proc = processFor(busyHeadless);
    live.mode = ViewMode.Standard;
    render(<ViewToggle />);

    expect(seg(ViewMode.Advanced).getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(seg(ViewMode.Advanced));
    expect(openDock).toHaveBeenCalledTimes(1);
  });
});

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gated = vi.hoisted(() => ({ modes: new Set<string>() }));
vi.mock('@src/components/view-toggle/use-view-toggle-gate', () => ({
  useViewToggleGate: () => (mode: string) => gated.modes.has(mode),
}));

// The click path is asserted on `openDock`, NOT on the rendered selection.
// Selection is URL-first: the segment only lights up once a navigation commits,
// and a committed navigation is exactly what jsdom cannot do here (react-router
// builds a real `Request` and undici rejects jsdom's AbortSignal). Asserting the
// selection would therefore pass whether or not the gate works — the bug this
// file exists for would go undetected. The navigation call is the real contract.
const openDock = vi.hoisted(() => vi.fn());
const dock = vi.hoisted(() => ({
  viewMode: 'standard' as string | null,
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

import { resetRevealedModes, ViewToggle } from '@src/components/view-toggle/view-toggle';
import { ViewMode } from '@src/contexts/view-mode-context';
import { surfaceTransportGate } from '@src/components/terminal/interactive-terminal/use-process-surface';

const seg = (m: string) => screen.getByTestId(`view-toggle-${m}`);

/** No transport change implied: no route, and never gated. */
const NO_OP = { needsSwitch: false, route: null, blocked: false };

/** A process stub shaped the way `surfaceTransportGate` reads one. */
const proc = (pty: boolean, opts: { busy?: boolean; failed?: boolean } = {}) =>
  ({
    isHeadless: !pty,
    status: opts.failed ? 'failed' : 'running',
    worker_status: opts.failed ? 'error' : 'idle',
    busy: opts.busy ?? false,
  }) as never;

describe('surfaceTransportGate — the one predicate the control and the effect share', () => {
  // Semantics live in the cross-language fixture
  // (`transport-switch-gate-contract.test.ts` / the Python half). These cases
  // are the hand-written companions that spell out WHY each shape is what it is.

  it('never gates a pick that moves no worker, however busy the turn', () => {
    // Chat⇄vibe are both headless, and re-picking the current transport is a
    // no-op. Reading the conversation is not a lifecycle action, so a mid-turn
    // user must always be free to move between them.
    const headlessBusy = proc(false, { busy: true });
    expect(surfaceTransportGate(headlessBusy, ViewMode.Standard)).toEqual(NO_OP);
    expect(surfaceTransportGate(headlessBusy, ViewMode.Vibe)).toEqual(NO_OP);

    const ptyBusy = proc(true, { busy: true });
    expect(surfaceTransportGate(ptyBusy, ViewMode.Advanced)).toEqual(NO_OP);
    expect(surfaceTransportGate(ptyBusy, ViewMode.Dev)).toEqual(NO_OP);
  });

  it('routes →terminal at `open`, which has no mid-turn guard — so neither has the client', () => {
    // The client mirrors the server PER ROUTE and invents no policy. Greying a
    // button the backend would have honoured tells the user something untrue.
    expect(surfaceTransportGate(proc(false, { busy: true }), ViewMode.Advanced)).toEqual({
      needsSwitch: true,
      route: 'open',
      blocked: false,
    });
    expect(surfaceTransportGate(proc(false), ViewMode.Advanced)).toEqual({
      needsSwitch: true,
      route: 'open',
      blocked: false,
    });
  });

  it('routes →chat at `switch-mode`, which 409s mid-turn — so the client refuses too', () => {
    // The FLOWPAD-2105 direction, gated on `busy` — the same `is_turn_busy` the
    // backend 409s on, so the control and the server cannot disagree.
    expect(surfaceTransportGate(proc(true, { busy: true }), ViewMode.Standard)).toEqual({
      needsSwitch: true,
      route: 'switch-mode',
      blocked: true,
    });
    expect(surfaceTransportGate(proc(true), ViewMode.Vibe)).toEqual({
      needsSwitch: true,
      route: 'switch-mode',
      blocked: false,
    });
  });

  it('does NOT gate a failed session — nothing is working, and this is how it is revived', () => {
    // Caught in the running app: a `status: failed` / `worker_status: error`
    // session is `busy: false`, so no route refuses it — but it is also NOT
    // `isReadyForInput`. An earlier draft gated on readiness, which greyed
    // Terminal on a dead session under the words "not while the agent is
    // working", and took away the click that revives it (→PTY carries
    // `retry: true`, which clears the `start_failure` latch).
    expect(surfaceTransportGate(proc(false, { failed: true }), ViewMode.Advanced)).toEqual({
      needsSwitch: true,
      route: 'open',
      blocked: false,
    });
    // Same for the FLOWPAD-2105 direction on a PTY the user ended with `/exit`:
    // STOPPED is neither busy nor ready, and it is the session that most needs
    // the switch — leaving it gated keeps `pty_mode=true` forever.
    expect(surfaceTransportGate(proc(true, { failed: true }), ViewMode.Standard)).toEqual({
      needsSwitch: true,
      route: 'switch-mode',
      blocked: false,
    });
  });

  it('is inert on a dock with no session', () => {
    expect(surfaceTransportGate(null, ViewMode.Advanced)).toEqual(NO_OP);
    expect(surfaceTransportGate(undefined, ViewMode.Standard)).toEqual(NO_OP);
  });
});

describe('ViewToggle refuses a gated segment instead of lying about it', () => {
  beforeEach(() => {
    localStorage.clear();
    gated.modes = new Set();
    dock.viewMode = ViewMode.Standard;
    openDock.mockClear();
    resetRevealedModes();
  });

  afterEach(() => {
    cleanup();
    resetRevealedModes();
  });

  it('greys a gated segment and leaves the ungated ones alone', () => {
    gated.modes = new Set([ViewMode.Advanced]);
    render(<ViewToggle />);

    expect(seg(ViewMode.Advanced).getAttribute('aria-disabled')).toBe('true');
    expect(seg(ViewMode.Vibe).getAttribute('aria-disabled')).toBeNull();
    expect(seg(ViewMode.Standard).getAttribute('aria-disabled')).toBeNull();
  });

  it('does not navigate when a gated segment is clicked', () => {
    // The whole point. Before the gate the click still navigated, so the URL
    // moved, the segment lit up and the preference was adopted — while the
    // transport silently stayed put and nothing said why.
    gated.modes = new Set([ViewMode.Advanced]);
    render(<ViewToggle />);

    fireEvent.click(seg(ViewMode.Advanced));

    expect(openDock).not.toHaveBeenCalled();
  });

  it('still navigates for an ungated segment while another is gated', () => {
    // The gate must be per segment. Blanking the whole control mid-turn would
    // take away chat⇄vibe, which needs no worker and must stay available.
    gated.modes = new Set([ViewMode.Advanced]);
    render(<ViewToggle />);

    fireEvent.click(seg(ViewMode.Vibe));

    expect(openDock).toHaveBeenCalledTimes(1);
    expect(openDock).toHaveBeenCalledWith(expect.objectContaining({ viewMode: ViewMode.Vibe }));
  });

  it('uses aria-disabled rather than the native one, so the segment can still be hovered', () => {
    // A natively `disabled` button gets no pointer events in most browsers, so
    // it cannot open the tooltip that explains why it is greyed — a control the
    // user cannot interrogate only moves the confusion. The refusal lives in
    // `select` instead, which also covers keyboard activation.
    gated.modes = new Set([ViewMode.Advanced]);
    render(<ViewToggle />);

    expect(seg(ViewMode.Advanced).hasAttribute('disabled')).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewType } from '@sdk';
import { DockPointer, HIGHLIGHT_PARAM } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { ViewMode } from '@src/contexts/view-mode-context';

/**
 * A URL write must compose onto where we are GOING, not where we were.
 *
 * `navigate()` is async — React Router runs loaders before the URL changes — so
 * for the whole of that window `window.location` still reports the PREVIOUS
 * location. Anything that rebuilds a URL from the live browser location during
 * that window and commits it will supersede the navigation in flight.
 *
 * That is not hypothetical. It shipped: a journey step said "click Chat to leave
 * Vibe", the click started the navigation, the step advanced, and the next
 * step's `?highlight=` write rebuilt the pre-navigation URL and committed it —
 * putting the user back in Vibe while the journey narrated the loss that never
 * happened. The URL left behind said it exactly:
 * `?viewMode=vibe&journeyId=…&highlight=ViewModeVibe` — the OLD viewMode
 * carrying the NEW step's highlight.
 *
 * A memory journey made it reproducible: a server journey's `advance()` is an
 * HTTP POST, and that latency was accidentally holding the write back until the
 * navigation committed.
 */

const SHELL = 'agentic_process-024a9d07-6b07-4ab8-bd0b-9a41a133caee';

/** The browser has NOT moved yet — loaders are still running. */
function pendingNavigation() {
  const navigate = vi.fn();
  const from = new DockPointer(ViewType.SHELL, SHELL).withViewMode(ViewMode.Vibe);
  window.history.pushState({}, '', from.toUrl());

  const navigation = new NavigationActions(navigate, from);
  navigation.openDock(from.withViewMode(ViewMode.Standard));
  // Deliberately do NOT update window.location: that is the whole point.
  return { navigate, navigation };
}

/** The URL of the most recent commit. */
const lastUrl = (navigate: ReturnType<typeof vi.fn>): string =>
  String(navigate.mock.calls[navigate.mock.calls.length - 1][0]);

describe('composing a URL while a navigation is in flight', () => {
  afterEach(() => {
    NavigationActions.resetPendingNavigationForTests();
    vi.restoreAllMocks();
  });

  it('starts from a real pending navigation', () => {
    const { navigate } = pendingNavigation();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(lastUrl(navigate)).toContain(`viewMode=${ViewMode.Standard}`);
  });

  it('a highlight write does not revert the navigation', () => {
    const { navigate, navigation } = pendingNavigation();
    navigation.setOption(HIGHLIGHT_PARAM, 'ViewModeVibe');

    const url = lastUrl(navigate);
    expect(url).toContain('highlight=ViewModeVibe');
    // THE REGRESSION: the destination must survive the highlight.
    expect(url).toContain(`viewMode=${ViewMode.Standard}`);
    expect(url).not.toContain(`viewMode=${ViewMode.Vibe}`);
  });

  it('a journey write does not revert the navigation either', () => {
    const { navigate, navigation } = pendingNavigation();
    navigation.showJourney('@vibe-exit-mode-switch');

    const url = lastUrl(navigate);
    expect(url).toContain('journeyId=');
    expect(url).toContain(`viewMode=${ViewMode.Standard}`);
  });

  it('keeps the dock it was navigating to, not the one it left', () => {
    const { navigate, navigation } = pendingNavigation();
    navigation.setOption(HIGHLIGHT_PARAM, 'X');
    expect(lastUrl(navigate)).toContain(SHELL);
  });

  it('with nothing in flight, it composes onto the live location', () => {
    const navigate = vi.fn();
    const here = new DockPointer(ViewType.SHELL, SHELL).withViewMode(ViewMode.Standard);
    window.history.pushState({}, '', here.toUrl());

    const navigation = new NavigationActions(navigate, here);
    navigation.setOption(HIGHLIGHT_PARAM, 'ViewModeVibe');

    const url = lastUrl(navigate);
    expect(url).toContain('highlight=ViewModeVibe');
    expect(url).toContain(`viewMode=${ViewMode.Standard}`);
  });
});

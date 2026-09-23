/**
 * A backend-driven navigate (`flow navigate view <address>` → `navigate_dock` →
 * `NavigationActions.commitDetached`) lands in the mode on screen.
 *
 * The pushed address names no mode, and a bare entry re-resolves through the
 * stored preference — so without carrying the live URL's `?viewMode`, an agent's
 * navigate repainted a user who was in Vibe into whatever the preference held
 * (dock_sweep, QA cycle 2026-09-23). `openDock` already applies this fallback;
 * `commitDetached` must agree with it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { ViewType } from '@src/types/ViewType';

function modeAfterNavigate(from: string, target: DockPointer): string | null {
  window.history.replaceState(null, '', from);
  NavigationActions.commitDetached(target);
  return new URLSearchParams(window.location.search).get('viewMode');
}

describe('commitDetached keeps the mode on screen', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('carries the live URL mode onto a target that names none', () => {
    expect(modeAfterNavigate('/dock/desktop?viewMode=vibe', new DockPointer(ViewType.EVENTS))).toBe('vibe');
    expect(window.location.pathname).toBe('/dock/events');
  });

  it("lets the target's own mode win", () => {
    const target = new DockPointer(ViewType.EVENTS).withViewMode('standard');
    expect(modeAfterNavigate('/dock/desktop?viewMode=vibe', target)).toBe('standard');
  });

  it('adds no mode when the page states none', () => {
    expect(modeAfterNavigate('/dock/desktop', new DockPointer(ViewType.EVENTS))).toBeNull();
  });
});

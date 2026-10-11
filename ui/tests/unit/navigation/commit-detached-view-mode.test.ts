/**
 * A backend-driven navigate (`flow navigate view <address>` → `navigate_dock` →
 * `NavigationActions.commitDetached`) never carries a view mode onto a page.
 *
 * A mode belongs to a session tab. The pushed address used to inherit the live
 * URL's `?viewMode`, which reskinned every page by the tab it was opened from;
 * now only a session (or a child its workspace hosts) states one.
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

describe('commitDetached states a mode only for a session', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('a page takes no mode from the tab on screen', () => {
    const from = '/dock/shell/agentic_process-8c98d9c8-4295-4ac4-8560-788d762bd89a?viewMode=advanced';
    expect(modeAfterNavigate(from, new DockPointer(ViewType.EVENTS))).toBeNull();
    expect(window.location.pathname).toBe('/dock/events');
  });

  it('a page cannot be given one either', () => {
    const target = new DockPointer(ViewType.EVENTS).withViewMode('standard');
    expect(modeAfterNavigate('/dock/desktop', target)).toBeNull();
  });

  it("a session target's own mode wins", () => {
    const target = new DockPointer(ViewType.SHELL, 'shell-1').withViewMode('advanced');
    expect(modeAfterNavigate('/dock/desktop', target)).toBe('advanced');
  });
});

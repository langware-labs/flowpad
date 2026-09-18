/**
 * Per-SESSION view-mode memory (`AgenticProcess.last_mode`) under the default
 * `VIEW_MODE_STORE` policy: memory is READ on every open, but WRITTEN only on a
 * mode switch.
 *
 * Seams:
 *   - `NavigationActions.openDock` seeds a session dock's `?viewMode` from the
 *     session's own memory (read side, cache-only).
 *   - `tabManager.recordViewModeEvent` reports tab opens/creates — which the
 *     default policy ignores.
 *   - `setViewMode(mode, dock)` is the switch — it writes the preference, the
 *     session and the current project.
 */
import { AgenticProcess, dataContext, dataManager, Tab, tabManager, ViewModeEvent, ViewType } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DockPointer } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { getViewMode, setViewMode, ViewMode } from '@src/contexts/view-mode-context';

const SESSION_ID = '024a9d07-6b07-4ab8-bd0b-9a41a133caee';
const SESSION_POINTER = `agentic_process-${SESSION_ID}`;

/** A stand-in for the cached entity: only `last_mode` and `save` are read. */
function fakeSession(lastMode: string | null = null) {
  return { id: SESSION_ID, last_mode: lastMode, save: vi.fn().mockResolvedValue(undefined) };
}

/** Put a session in the entity cache, as a real navigation would find it. */
function cacheSession(session: ReturnType<typeof fakeSession> | null) {
  vi.spyOn(dataManager, 'getByTypeIdFromCache').mockImplementation((typeId) =>
    session && typeId.type === AgenticProcess.type && typeId.id === SESSION_ID ? (session as never) : null,
  );
}

/** Sit on a URL that names `mode`, so inheritance has something to inherit. */
function sitOnSomewhereIn(mode: ViewMode): void {
  const here = new DockPointer(ViewType.ASSETS, 'all').withViewMode(mode);
  window.history.pushState({}, '', here.toUrl());
}

const lastUrl = (navigate: ReturnType<typeof vi.fn>): string =>
  String(navigate.mock.calls[navigate.mock.calls.length - 1][0]);

const sessionDock = () => new DockPointer(ViewType.SHELL, SESSION_POINTER);

describe('per-session view-mode memory (AgenticProcess.last_mode)', () => {
  beforeEach(() => {
    setViewMode(ViewMode.Standard);
  });

  afterEach(() => {
    NavigationActions.resetPendingNavigationForTests();
    vi.restoreAllMocks();
  });

  describe('openDock seeds a session dock from the session itself', () => {
    it('opens a session in its remembered mode, not the mode we are in', () => {
      cacheSession(fakeSession(ViewMode.Vibe));
      sitOnSomewhereIn(ViewMode.Advanced);
      const navigate = vi.fn();

      new NavigationActions(navigate, null).openDock(sessionDock());

      expect(lastUrl(navigate)).toContain(`viewMode=${ViewMode.Vibe}`);
    });

    it('a session with no memory displays the mode we are in', () => {
      cacheSession(fakeSession(null));
      sitOnSomewhereIn(ViewMode.Advanced);
      const navigate = vi.fn();

      new NavigationActions(navigate, null).openDock(sessionDock());

      expect(lastUrl(navigate)).toContain(`viewMode=${ViewMode.Advanced}`);
    });

    it('garbage in `last_mode` reads as no memory rather than as a mode', () => {
      cacheSession(fakeSession('bogus-mode'));
      sitOnSomewhereIn(ViewMode.Advanced);
      const navigate = vi.fn();

      new NavigationActions(navigate, null).openDock(sessionDock());

      expect(lastUrl(navigate)).toContain(`viewMode=${ViewMode.Advanced}`);
      expect(lastUrl(navigate)).not.toContain('bogus-mode');
    });

    it('an explicitly requested mode (the footer toggle) beats the memory', () => {
      cacheSession(fakeSession(ViewMode.Vibe));
      sitOnSomewhereIn(ViewMode.Vibe);
      const navigate = vi.fn();

      new NavigationActions(navigate, sessionDock()).openDock(sessionDock().withViewMode(ViewMode.Advanced));

      expect(lastUrl(navigate)).toContain(`viewMode=${ViewMode.Advanced}`);
    });

    it('opens a bare project dock in the project’s remembered mode', () => {
      const PROJECT_ID = '5d3f0a52-8c1e-4b7a-9f0e-2a6c1b3d4e5f';
      vi.spyOn(dataManager, 'getByTypeIdFromCache').mockImplementation((typeId) =>
        typeId.type === 'project' && typeId.id === PROJECT_ID ? ({ last_mode: ViewMode.Dev, save: vi.fn() } as never) : null,
      );
      sitOnSomewhereIn(ViewMode.Advanced);
      const navigate = vi.fn();

      new NavigationActions(navigate, null).openDock(new DockPointer(ViewType.PROJECT, PROJECT_ID));

      expect(lastUrl(navigate)).toContain(`viewMode=${ViewMode.Dev}`);
    });

    it('leaves non-session docks on the inherited mode', () => {
      cacheSession(fakeSession(ViewMode.Vibe));
      sitOnSomewhereIn(ViewMode.Advanced);
      const navigate = vi.fn();

      new NavigationActions(navigate, null).openDock(new DockPointer(ViewType.TASKS, 'all'));

      expect(lastUrl(navigate)).toContain(`viewMode=${ViewMode.Advanced}`);
    });
  });

  describe('opening a tab never mints memory (default policy)', () => {
    it.each([ViewModeEvent.TabOpen, ViewModeEvent.TabCreate])('%s saves nothing', (event) => {
      const session = fakeSession(null);
      cacheSession(session);
      const tab = new Tab({ id: 'tab-1', pointer: SESSION_POINTER, target_type: AgenticProcess.type, target_id: SESSION_ID });

      tabManager.recordViewModeEvent(tab, event, ViewMode.Advanced);

      expect(session.last_mode).toBeNull();
      expect(session.save).not.toHaveBeenCalled();
    });
  });

  describe('setViewMode is the switch', () => {
    it('records the mode onto the session, the project and the preference', () => {
      const session = fakeSession(ViewMode.Vibe);
      const project = { last_mode: null, save: vi.fn().mockResolvedValue(undefined) };
      cacheSession(session);
      // `project` is a MobX computed over `getContextEntity`, so stub the source it reads.
      vi.spyOn(dataContext, 'getContextEntity').mockReturnValue(project as never);

      setViewMode(ViewMode.Advanced, sessionDock());

      expect(session.last_mode).toBe(ViewMode.Advanced);
      expect(project.last_mode).toBe(ViewMode.Advanced);
      expect(getViewMode()).toBe(ViewMode.Advanced);
    });
  });
});

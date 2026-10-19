/**
 * Per-SESSION view-mode memory (`AgenticProcess.last_mode`) under the default
 * `VIEW_MODE_STORE` policy: memory is READ on every open, WRITTEN when the tab
 * is created and on a mode switch — never by merely opening a tab.
 *
 * Seams:
 *   - `NavigationActions.openDock` seeds a session dock's `?viewMode` from the
 *     session's own memory (read side, cache-only) — never from the mode on screen.
 *   - `tabManager.recordViewModeEvent` reports tab opens/creates — the default
 *     policy stores the create and ignores the open.
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
  const here = new DockPointer(ViewType.SHELL, 'shell-somewhere').withViewMode(mode);
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

      // Remembered Vibe opens the session as its Vibe host tab.
      expect(lastUrl(navigate)).toContain('/dock/vibe/agentic_process-');
    });

    // A session never takes the mode we are in — that belongs to the tab being
    // left. With no memory it is the last mode the user selected.
    it.each([ViewMode.Advanced, ViewMode.Vibe])('a cached session with no memory opens in the last selected mode, not in %s', (here) => {
      setViewMode(ViewMode.Standard);
      cacheSession(fakeSession(null));
      sitOnSomewhereIn(here);
      const navigate = vi.fn();

      new NavigationActions(navigate, null).openDock(sessionDock());

      expect(lastUrl(navigate)).toContain('/dock/shell/agentic_process-');
      expect(lastUrl(navigate)).toContain(`viewMode=${ViewMode.Standard}`);
    });

    it('a session not in cache opens bare — the shell loader states its mode from the entity', () => {
      cacheSession(null);
      sitOnSomewhereIn(ViewMode.Vibe);
      const navigate = vi.fn();

      new NavigationActions(navigate, null).openDock(sessionDock());

      expect(lastUrl(navigate)).toContain('/dock/shell/agentic_process-');
      expect(lastUrl(navigate)).not.toContain('viewMode=');
    });

    it('garbage in `last_mode` reads as no memory rather than as a mode', () => {
      setViewMode(ViewMode.Standard);
      cacheSession(fakeSession('bogus-mode'));
      sitOnSomewhereIn(ViewMode.Advanced);
      const navigate = vi.fn();

      new NavigationActions(navigate, null).openDock(sessionDock());

      expect(lastUrl(navigate)).toContain(`viewMode=${ViewMode.Standard}`);
      expect(lastUrl(navigate)).not.toContain('bogus-mode');
    });

    it('an explicitly requested mode (the session switch) beats the memory', () => {
      cacheSession(fakeSession(ViewMode.Vibe));
      sitOnSomewhereIn(ViewMode.Vibe);
      const navigate = vi.fn();

      new NavigationActions(navigate, sessionDock()).openDock(sessionDock().withViewMode(ViewMode.Advanced));

      expect(lastUrl(navigate)).toContain(`viewMode=${ViewMode.Advanced}`);
    });

    it('a project dock states no mode, whatever the project once stored', () => {
      const PROJECT_ID = '5d3f0a52-8c1e-4b7a-9f0e-2a6c1b3d4e5f';
      vi.spyOn(dataManager, 'getByTypeIdFromCache').mockImplementation((typeId) =>
        typeId.type === 'project' && typeId.id === PROJECT_ID ? ({ last_mode: ViewMode.Dev, save: vi.fn() } as never) : null,
      );
      sitOnSomewhereIn(ViewMode.Advanced);
      const navigate = vi.fn();

      new NavigationActions(navigate, null).openDock(new DockPointer(ViewType.PROJECT, PROJECT_ID));

      expect(lastUrl(navigate)).not.toContain('viewMode');
    });

    it('a page never takes the mode on screen', () => {
      cacheSession(fakeSession(ViewMode.Vibe));
      sitOnSomewhereIn(ViewMode.Advanced);
      const navigate = vi.fn();

      new NavigationActions(navigate, null).openDock(new DockPointer(ViewType.TASKS, 'all'));

      expect(lastUrl(navigate)).not.toContain('viewMode');
    });
  });

  describe('a tab remembers the mode it is shown in (default policy)', () => {
    it('TabCreate stamps the mode the session was opened in', () => {
      const session = fakeSession(null);
      cacheSession(session);
      const tab = new Tab({ id: 'tab-1', pointer: SESSION_POINTER, target_type: AgenticProcess.type, target_id: SESSION_ID });

      tabManager.recordViewModeEvent(tab, ViewModeEvent.TabCreate, ViewMode.Advanced);

      expect(session.last_mode).toBe(ViewMode.Advanced);
      expect(session.save).toHaveBeenCalledTimes(1);
    });

    it('TabOpen restates it: a session shown in another mode comes back in that mode', () => {
      const session = fakeSession(ViewMode.Vibe);
      cacheSession(session);
      const tab = new Tab({ id: 'tab-1', pointer: SESSION_POINTER, target_type: AgenticProcess.type, target_id: SESSION_ID });

      tabManager.recordViewModeEvent(tab, ViewModeEvent.TabOpen, ViewMode.Advanced);

      expect(session.last_mode).toBe(ViewMode.Advanced);
      expect(session.save).toHaveBeenCalledTimes(1);

      // Reopening in the mode it already has costs nothing.
      tabManager.recordViewModeEvent(tab, ViewModeEvent.TabOpen, ViewMode.Advanced);
      expect(session.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('setViewMode is the switch', () => {
    it('records the mode onto the session and the preference — never the project', () => {
      const session = fakeSession(ViewMode.Vibe);
      const project = { last_mode: null, save: vi.fn().mockResolvedValue(undefined) };
      cacheSession(session);
      // `project` is a MobX computed over `getContextEntity`, so stub the source it reads.
      vi.spyOn(dataContext, 'getContextEntity').mockReturnValue(project as never);

      setViewMode(ViewMode.Advanced, sessionDock());

      expect(session.last_mode).toBe(ViewMode.Advanced);
      expect(project.last_mode).toBeNull();
      expect(getViewMode()).toBe(ViewMode.Advanced);
    });
  });
});

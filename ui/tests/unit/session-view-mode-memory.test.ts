/**
 * Per-SESSION view-mode memory (`AgenticProcess.last_mode`).
 *
 * The bug this pins: view mode was one global preference, so switching to
 * Terminal repainted every session at once and clicking between chats dragged
 * the ambient mode along. Mode is a property of the session you are looking at
 * — each one opens in the mode it was last seen in, and switching mode while it
 * is open records the new one onto THAT session.
 *
 * Two seams, matching the two directions:
 *   - `NavigationActions.openDock` seeds a session dock's `?viewMode` from the
 *     session's own memory instead of inheriting the live URL's mode (click
 *     path, cache-only).
 *   - `applyProcessViewMode` does the same for a cold URL that carries no mode
 *     (deep link / hard refresh), and adopts + records the ambient mode for a
 *     session that has no memory yet.
 */
import { AgenticProcess, ViewType } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DockPointer } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';
import {
  applyProcessViewMode,
  getViewMode,
  setViewMode,
  stampProcessViewMode,
  ViewMode,
} from '@src/contexts/view-mode-context';

const SESSION_ID = '024a9d07-6b07-4ab8-bd0b-9a41a133caee';
const SESSION_POINTER = `agentic_process-${SESSION_ID}`;

/** A stand-in for the cached entity: only `last_mode` and `save` are read. */
function fakeSession(lastMode: string | null = null) {
  return {
    id: SESSION_ID,
    last_mode: lastMode,
    save: vi.fn().mockResolvedValue(undefined),
  };
}

/** Put a session in the entity cache, as a real navigation would find it. */
function cacheSession(session: ReturnType<typeof fakeSession> | null) {
  vi.spyOn(AgenticProcess, 'getByIdFromCache').mockImplementation((id: string) =>
    session && id === SESSION_ID ? (session as unknown as AgenticProcess) : null,
  );
}

/** Sit on a URL that names `mode`, so inheritance has something to inherit. */
function sitOnSomewhereIn(mode: ViewMode): void {
  const here = new DockPointer(ViewType.ASSETS, 'all').withViewMode(mode);
  window.history.pushState({}, '', here.toUrl());
}

const lastUrl = (navigate: ReturnType<typeof vi.fn>): string =>
  String(navigate.mock.calls[navigate.mock.calls.length - 1][0]);

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

      new NavigationActions(navigate, null).openDock(new DockPointer(ViewType.SHELL, SESSION_POINTER));

      expect(lastUrl(navigate)).toContain(`viewMode=${ViewMode.Vibe}`);
    });

    it('a session with no memory adopts the mode we are in', () => {
      cacheSession(fakeSession(null));
      sitOnSomewhereIn(ViewMode.Advanced);
      const navigate = vi.fn();

      new NavigationActions(navigate, null).openDock(new DockPointer(ViewType.SHELL, SESSION_POINTER));

      expect(lastUrl(navigate)).toContain(`viewMode=${ViewMode.Advanced}`);
    });

    it('garbage in `last_mode` reads as no memory rather than as a mode', () => {
      cacheSession(fakeSession('bogus-mode'));
      sitOnSomewhereIn(ViewMode.Advanced);
      const navigate = vi.fn();

      new NavigationActions(navigate, null).openDock(new DockPointer(ViewType.SHELL, SESSION_POINTER));

      const url = lastUrl(navigate);
      expect(url).toContain(`viewMode=${ViewMode.Advanced}`);
      expect(url).not.toContain('bogus-mode');
    });

    it('an explicitly requested mode (the footer toggle) beats the memory', () => {
      cacheSession(fakeSession(ViewMode.Vibe));
      sitOnSomewhereIn(ViewMode.Vibe);
      const navigate = vi.fn();
      const dock = new DockPointer(ViewType.SHELL, SESSION_POINTER);

      new NavigationActions(navigate, dock).openDock(dock.withViewMode(ViewMode.Advanced));

      expect(lastUrl(navigate)).toContain(`viewMode=${ViewMode.Advanced}`);
    });

    it('leaves non-session docks on the inherited mode', () => {
      cacheSession(fakeSession(ViewMode.Vibe));
      sitOnSomewhereIn(ViewMode.Advanced);
      const navigate = vi.fn();

      new NavigationActions(navigate, null).openDock(new DockPointer(ViewType.TASKS, 'all'));

      expect(lastUrl(navigate)).toContain(`viewMode=${ViewMode.Advanced}`);
    });
  });

  describe('applyProcessViewMode (the loader side)', () => {
    it('applies the remembered mode when the URL names none', () => {
      const session = fakeSession(ViewMode.Advanced);
      applyProcessViewMode(session as unknown as AgenticProcess, null);

      expect(getViewMode()).toBe(ViewMode.Advanced);
      expect(session.save).not.toHaveBeenCalled();
    });

    it('adopts and records the current mode for a session with no memory', () => {
      const session = fakeSession(null);
      applyProcessViewMode(session as unknown as AgenticProcess, null);

      expect(getViewMode()).toBe(ViewMode.Standard);
      expect(session.last_mode).toBe(ViewMode.Standard);
      expect(session.save).toHaveBeenCalledTimes(1);
    });

    it('stands aside when the URL names a mode — that one is authoritative', () => {
      const session = fakeSession(ViewMode.Advanced);
      applyProcessViewMode(session as unknown as AgenticProcess, ViewMode.Vibe);

      expect(getViewMode()).toBe(ViewMode.Standard);
      expect(session.last_mode).toBe(ViewMode.Advanced);
      expect(session.save).not.toHaveBeenCalled();
    });
  });

  describe('stampProcessViewMode', () => {
    it('records a new mode', () => {
      const session = fakeSession(ViewMode.Vibe);
      stampProcessViewMode(session as unknown as AgenticProcess, ViewMode.Advanced);

      expect(session.last_mode).toBe(ViewMode.Advanced);
      expect(session.save).toHaveBeenCalledTimes(1);
    });

    it('does not save when the mode already matches (breaks the apply→record loop)', () => {
      const session = fakeSession(ViewMode.Advanced);
      stampProcessViewMode(session as unknown as AgenticProcess, ViewMode.Advanced);

      expect(session.save).not.toHaveBeenCalled();
    });
  });
});

/**
 * Runtime verification for the consolidated worker-launch surface:
 *   - WorkerToolbar display modes (all vs lastOpened) + the Dev-view default,
 *   - the overflow chevron reveal in lastOpened mode,
 *   - the hasProcess → "Open" short-circuit,
 *   - the menu-list variant,
 *   - and the useLastWorkerType ↔ shared last-opener key round-trip
 *     (worker `claude_code` ⇄ opener `claude`) that makes the last-used worker
 *     surface first next time.
 *
 * These are the units the full app gates behind auth, so they're proven here at
 * runtime without the app shell. No router or live backend — the last-opener
 * memory rides the registry-driven `instancePreferences` singleton
 * (PrefKey.LAST_OPENER), seeded/reset per-test, plus the view-mode setter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { instancePreferences, PrefKey } from '@sdk';
import { setViewMode, ViewMode } from '@src/contexts/view-mode-context';
import { WorkerToolbar } from '@src/components/workers/WorkerToolbar';
import {
  openerToWorker,
  useLastWorkerType,
  workerToOpener,
} from '@src/components/terminal/openers/useLastWorkerType';
import { renderHook } from '@testing-library/react';
import { resetOpenerPrefs } from '../utils/opener-prefs';

beforeEach(() => {
  // The last-opener memory now lives in the registry-driven instancePreferences
  // singleton (PrefKey.LAST_OPENER), not the legacy `flowpad.terminal.lastOpener`
  // localStorage key. resetOpenerPrefs() clears it so each test starts with
  // claude_code primary and no pinned openers.
  localStorage.clear();
  resetOpenerPrefs();
  setViewMode(ViewMode.Standard);
});

describe('WorkerToolbar — display modes', () => {
  it('mode="all" renders every worker, no chevron', () => {
    render(<WorkerToolbar onLaunch={() => {}} mode="all" testIdPrefix="t" />);
    expect(screen.getByTestId('t-launch-claude_code')).toBeTruthy();
    expect(screen.getByTestId('t-launch-codex')).toBeTruthy();
    expect(screen.getByTestId('t-launch-copilot')).toBeTruthy();
    expect(screen.queryByTestId('t-launch-more')).toBeNull();
  });

  it('Standard view defaults to lastOpened: one worker + chevron', () => {
    render(<WorkerToolbar onLaunch={() => {}} testIdPrefix="t" />);
    // No remembered worker yet → falls back to claude_code as primary.
    expect(screen.getByTestId('t-launch-claude_code')).toBeTruthy();
    expect(screen.queryByTestId('t-launch-codex')).toBeNull();
    expect(screen.queryByTestId('t-launch-copilot')).toBeNull();
    expect(screen.getByTestId('t-launch-more')).toBeTruthy();
  });

  it('Dev view defaults to all (no chevron)', () => {
    setViewMode(ViewMode.Dev);
    render(<WorkerToolbar onLaunch={() => {}} testIdPrefix="t" />);
    expect(screen.getByTestId('t-launch-codex')).toBeTruthy();
    expect(screen.getByTestId('t-launch-copilot')).toBeTruthy();
    expect(screen.queryByTestId('t-launch-more')).toBeNull();
  });

  it('chevron reveals the remaining workers', async () => {
    const user = userEvent.setup();
    render(<WorkerToolbar onLaunch={() => {}} testIdPrefix="t" />);
    await user.click(screen.getByTestId('t-launch-more'));
    expect(screen.getByTestId('t-launch-codex')).toBeTruthy();
    expect(screen.getByTestId('t-launch-copilot')).toBeTruthy();
  });

  it('leads with the last-used worker', () => {
    instancePreferences.set(PrefKey.LAST_OPENER, 'codex');
    render(<WorkerToolbar onLaunch={() => {}} testIdPrefix="t" />);
    // Primary is codex; claude_code now lives behind the chevron.
    expect(screen.getByTestId('t-launch-codex')).toBeTruthy();
    expect(screen.queryByTestId('t-launch-claude_code')).toBeNull();
    expect(screen.getByTestId('t-launch-more')).toBeTruthy();
  });
});

describe('WorkerToolbar — launch + persistence', () => {
  it('launching calls onLaunch and remembers the worker as last opener', async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    render(<WorkerToolbar onLaunch={onLaunch} mode="all" testIdPrefix="t" />);

    await user.click(screen.getByTestId('t-launch-codex'));

    expect(onLaunch).toHaveBeenCalledWith('codex');
    // Persisted under the shared opener preference in opener form.
    expect(instancePreferences.get(PrefKey.LAST_OPENER)).toBe('codex');
  });

  it('hasProcess short-circuits to the Open button', () => {
    const onOpen = vi.fn();
    render(
      <WorkerToolbar onLaunch={() => {}} hasProcess onOpen={onOpen} testIdPrefix="t" />,
    );
    expect(screen.getByTestId('t-open-session')).toBeTruthy();
    expect(screen.queryByTestId('t-launch-claude_code')).toBeNull();
  });

  it('menu-list variant renders labelled session rows', () => {
    render(<WorkerToolbar onLaunch={() => {}} variant="menu-list" mode="all" testIdPrefix="t" />);
    const row = screen.getByTestId('t-launch-claude_code');
    expect(row.textContent).toContain('Session');
    expect(row.textContent).toContain('Claude');
  });
});

describe('useLastWorkerType — opener ⇄ worker coercion', () => {
  it('coerces both directions and ignores non-worker openers', () => {
    expect(workerToOpener('claude_code')).toBe('claude');
    expect(openerToWorker('claude')).toBe('claude_code');
    expect(openerToWorker('codex')).toBe('codex');
    expect(openerToWorker('terminal')).toBeNull();
    expect(openerToWorker(null)).toBeNull();
  });

  it('rememberWorker round-trips through the shared key', () => {
    const { result } = renderHook(() => useLastWorkerType());
    expect(result.current.lastWorker).toBeNull();

    act(() => result.current.rememberWorker('copilot'));

    expect(result.current.lastWorker).toBe('copilot');
    expect(instancePreferences.get(PrefKey.LAST_OPENER)).toBe('copilot');
  });
});

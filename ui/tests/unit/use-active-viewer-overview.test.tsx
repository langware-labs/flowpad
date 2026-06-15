/**
 * useActiveViewer × dock-less URLs (the parked `useActiveViewer.ts:92` bug,
 * tab-management.md Part 1 §1 / Part 3 U1).
 *
 * Characterization (pre-fix): navigating to ANY dock-less URL hard-nulled
 * `currentOverviewTab`, blanking the overview panel content the user was just
 * looking at.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ViewType } from '@sdk';

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: vi.fn(),
}));
vi.mock('@src/hooks/flow-hooks/useProcessStream', () => ({
  useProcessStream: () => ({ data: [] }),
}));
vi.mock('@src/hooks/flow-hooks/useProcessExecution', () => ({
  useProcessExecution: () => ({ isRunning: false }),
}));

import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useActiveViewer } from '@src/hooks/flow-hooks/useActiveViewer';
import { useViewerStore } from '@src/hooks/flow-hooks/useViewerStore';

const mockedUseDockNavigation = vi.mocked(useDockNavigation);

function mockDock(currentDock: { viewType?: ViewType; pointer?: string; options?: Record<string, string> } | null) {
  mockedUseDockNavigation.mockReturnValue({
    navigation: {} as never,
    isDockUrl: currentDock !== null,
    currentDock: currentDock as never,
  });
}

describe('useActiveViewer — dock-less URL handling', () => {
  beforeEach(() => {
    useViewerStore.setState({ currentOverviewTab: ViewType.SHELL, currentContext: null });
  });

  it('KEEPS the last overview tab on a dock-less URL (fixed :92 behavior)', () => {
    // INTENTIONAL BEHAVIOR CHANGE (red→green): the characterization of the
    // old code asserted `currentOverviewTab` became null here — that was the
    // useActiveViewer.ts:92 bug (any dock-less URL blanked the overview
    // panel). The unified-tabs viewer retirement (Part 3 U1) keeps the last
    // overview tab; the overview panel resolves from what's already there.
    mockDock(null);
    renderHook(() => useActiveViewer(null));
    expect(useViewerStore.getState().currentOverviewTab).toBe(ViewType.SHELL);
  });

  it('still clears the viewing context on a dock-less URL', () => {
    useViewerStore.setState({ currentContext: { viewerType: ViewType.EDITOR } as never });
    mockDock(null);
    renderHook(() => useActiveViewer(null));
    expect(useViewerStore.getState().currentContext).toBeNull();
  });

  it('syncs the dock pointer into currentContext on a dock URL', () => {
    mockDock({ viewType: ViewType.EDITOR, pointer: '/repo/file.ts' });
    renderHook(() => useActiveViewer(null));
    const ctx = useViewerStore.getState().currentContext;
    expect(ctx?.viewerType).toBe(ViewType.EDITOR);
    expect(ctx?.codeRef?.path).toBe('/repo/file.ts');
  });
});

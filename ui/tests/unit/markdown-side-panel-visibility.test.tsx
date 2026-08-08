import { cleanup, render, screen, within } from '@testing-library/react';
import { History, Layers, Play } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorWithSidePanel, type ExtraSideTab } from '@src/components/milkdown-editor/EditorWithSidePanel';

const view = vi.hoisted(() => ({ advanced: false }));

vi.mock('@src/components/view-mode', () => ({
  useIsAdvanced: () => view.advanced,
}));

const sideWindows = vi.hoisted(() => ({
  windows: [] as string[],
  active: null as string | null,
  open: vi.fn(),
  close: vi.fn(),
  closeAll: vi.fn(),
  select: vi.fn(),
}));

vi.mock('@src/navigation/useSideWindows', () => ({
  useSideWindows: () => sideWindows,
}));

const EXTRA_TABS: ExtraSideTab[] = [
  {
    id: 'context',
    label: 'Context',
    icon: Layers,
    panel: <div>context</div>,
  },
  {
    id: 'revisions',
    label: 'Revisions',
    icon: History,
    panel: <div>revisions</div>,
  },
  {
    id: 'runs',
    label: 'Runs',
    icon: Play,
    panel: <div>runs</div>,
  },
];

function Subject() {
  return (
    <EditorWithSidePanel target={null} extraTabs={EXTRA_TABS}>
      <div>editor</div>
    </EditorWithSidePanel>
  );
}

describe('markdown side-panel visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    view.advanced = false;
    sideWindows.windows = [];
    sideWindows.active = null;
  });

  afterEach(cleanup);

  it('shows only Context and Revisions outside Advanced, then restores every option in Advanced', () => {
    const { rerender } = render(<Subject />);

    const nonAdvancedRail = screen.getByTestId('md-side-window-collapsed');
    expect(within(nonAdvancedRail).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByTestId('md-side-tab-collapsed-context')).toBeTruthy();
    expect(screen.getByTestId('md-side-tab-collapsed-revisions')).toBeTruthy();
    expect(screen.queryByTestId('md-side-tab-collapsed-backlinks')).toBeNull();
    expect(screen.queryByTestId('md-side-tab-collapsed-runs')).toBeNull();
    expect(screen.queryByTestId('md-side-window-expand')).toBeNull();

    sideWindows.windows = [];
    sideWindows.active = null;
    view.advanced = true;
    rerender(<Subject />);

    expect(screen.getByTestId('md-side-tab-collapsed-backlinks')).toBeTruthy();
    expect(screen.getByTestId('md-side-tab-collapsed-context')).toBeTruthy();
    expect(screen.getByTestId('md-side-tab-collapsed-revisions')).toBeTruthy();
    expect(screen.getByTestId('md-side-tab-collapsed-runs')).toBeTruthy();
    expect(screen.getByTestId('md-side-window-expand')).toBeTruthy();

    // Dropping to Standard with a shared Advanced URL keeps its allowed tab
    // visible and simply IGNORES the unavailable one — rendering filters it,
    // and the URL is left alone so returning to Advanced restores it.
    sideWindows.windows = ['revisions', 'runs'];
    sideWindows.active = 'runs';
    view.advanced = false;
    rerender(<Subject />);
    expect(screen.getByText('revisions')).toBeTruthy();
    expect(screen.queryByText('runs')).toBeNull();
    expect(sideWindows.close).not.toHaveBeenCalled();
    expect(sideWindows.closeAll).not.toHaveBeenCalled();
  });

  it('never writes the URL for a window it cannot render', () => {
    // The regression: the tab set GROWS as async data lands (a Duplicates tab
    // exists only once `duplicate_count` loads). A surface that pruned the URL
    // against its current registry read "not declared yet" as "not allowed",
    // deleted a live window, and — because every dock write is a history push —
    // navigated the user off the entry Back had just restored.
    const lateTab: ExtraSideTab = {
      id: 'asset-duplicates:markdown-1',
      label: 'Duplicates 1',
      icon: Layers,
      panel: <div>duplicate paths</div>,
      availableInNonAdvanced: true,
    };
    sideWindows.windows = [lateTab.id];
    sideWindows.active = lateTab.id;

    // Render 1: entity still loading, so the surface declares NO extra tabs.
    const { rerender } = render(
      <EditorWithSidePanel target={null} extraTabs={[]}>
        <div>editor</div>
      </EditorWithSidePanel>,
    );
    expect(screen.queryByText('duplicate paths')).toBeNull();
    expect(sideWindows.close).not.toHaveBeenCalled();
    expect(sideWindows.closeAll).not.toHaveBeenCalled();
    expect(sideWindows.open).not.toHaveBeenCalled();

    // Render 2: the entity arrives and the tab is declared — the URL still
    // carries the window, so it opens rather than having been thrown away.
    rerender(
      <EditorWithSidePanel target={null} extraTabs={[lateTab]}>
        <div>editor</div>
      </EditorWithSidePanel>,
    );
    expect(screen.getByText('duplicate paths')).toBeTruthy();
  });

  it('omits the non-Advanced rail when the surface has no Context or Revisions', () => {
    render(
      <EditorWithSidePanel target={null} extraTabs={[EXTRA_TABS[2]]}>
        <div>editor</div>
      </EditorWithSidePanel>,
    );

    expect(screen.queryByTestId('md-side-window-collapsed')).toBeNull();
  });

  it('preserves a URL-open tab that explicitly opts into non-Advanced modes', () => {
    const collisionTab: ExtraSideTab = {
      id: 'asset-duplicates:skill-1',
      label: 'Duplicates 1',
      icon: Layers,
      panel: <div>duplicate paths</div>,
      availableInNonAdvanced: true,
    };
    sideWindows.windows = [collisionTab.id];
    sideWindows.active = collisionTab.id;

    render(
      <EditorWithSidePanel target={null} extraTabs={[collisionTab]}>
        <div>editor</div>
      </EditorWithSidePanel>,
    );

    expect(screen.getByText('duplicate paths')).toBeTruthy();
    expect(sideWindows.close).not.toHaveBeenCalled();
    expect(sideWindows.closeAll).not.toHaveBeenCalled();
  });
});

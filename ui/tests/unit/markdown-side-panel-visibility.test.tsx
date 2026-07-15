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

    // A shared Advanced URL may still name a hidden tab as active. The visible
    // allowed tab wins until the non-Advanced collapse effect cleans the URL.
    sideWindows.windows = ['revisions', 'runs'];
    sideWindows.active = 'runs';
    rerender(<Subject />);
    expect(screen.getByText('revisions')).toBeTruthy();
    expect(screen.queryByText('runs')).toBeNull();

    sideWindows.windows = [];
    sideWindows.active = null;
    view.advanced = true;
    rerender(<Subject />);

    expect(screen.getByTestId('md-side-tab-collapsed-backlinks')).toBeTruthy();
    expect(screen.getByTestId('md-side-tab-collapsed-context')).toBeTruthy();
    expect(screen.getByTestId('md-side-tab-collapsed-revisions')).toBeTruthy();
    expect(screen.getByTestId('md-side-tab-collapsed-runs')).toBeTruthy();
    expect(screen.getByTestId('md-side-window-expand')).toBeTruthy();
  });

  it('omits the non-Advanced rail when the surface has no Context or Revisions', () => {
    render(
      <EditorWithSidePanel target={null} extraTabs={[EXTRA_TABS[2]]}>
        <div>editor</div>
      </EditorWithSidePanel>,
    );

    expect(screen.queryByTestId('md-side-window-collapsed')).toBeNull();
  });
});

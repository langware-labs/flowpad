/**
 * The Files view's hidden-files toggle: ExplorerView derives the HIDDEN filter
 * from the FILES_SHOW_HIDDEN instance preference, and SimpleFileManager's
 * toolbar toggle flips it through `onEnabledFiltersChange` — so the choice
 * survives a remount. A host that cannot switch the filter gets no toggle.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fsStore, instancePreferences, PrefKey, TypeId } from '@sdk';

const TYPE_ID = new TypeId('compute_node', '@local');
const ITEMS = [
  { name: '.git', relativePath: '.git', is_dir: true, size: 0, last_modified: 0 },
  { name: 'src', relativePath: 'src', is_dir: true, size: 0, last_modified: 0 },
];

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/hooks/flow-hooks/useViewerStore', () => ({
  useViewerStore: () => ({ currentContext: null }),
}));
vi.mock('@src/components/explorer-view/useExplorerComputeNode', () => ({
  useExplorerComputeNode: () => ({ typeId: TYPE_ID, anchorForScope: () => '', projectRootPath: null }),
}));
vi.mock('@src/hooks/useFS', () => ({
  useFS: () => ({ browse: () => ({ items: ITEMS }) }),
}));

import { ExplorerView } from '@src/components/explorer-view/explorer-view';
import { SimpleFileManager } from '@src/components/simple-file-manager/SimpleFileManager';
import { FilterName, getAllFilterDefinitions } from '@src/components/simple-file-manager/filters';

const toggle = () => screen.getByTestId('file-manager-toggle-hidden-button');

beforeEach(() => {
  vi.spyOn(fsStore.getState(), 'listDirectory').mockResolvedValue({ items: ITEMS } as never);
  vi.spyOn(instancePreferences as never, '_scheduleFlush').mockImplementation(() => undefined);
  instancePreferences.set(PrefKey.FILES_SHOW_HIDDEN, false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Files hidden-files toggle', () => {
  it('hides dotfiles by default', () => {
    render(<ExplorerView onFileSelect={vi.fn()} />);
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.queryByText('.git')).not.toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows dotfiles when toggled and remembers it across a remount', () => {
    const { unmount } = render(<ExplorerView onFileSelect={vi.fn()} />);
    fireEvent.click(toggle());
    expect(screen.getByText('.git')).toBeInTheDocument();
    expect(instancePreferences.get(PrefKey.FILES_SHOW_HIDDEN)).toBe(true);

    unmount();
    render(<ExplorerView onFileSelect={vi.fn()} />);
    expect(screen.getByText('.git')).toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(toggle());
    expect(screen.queryByText('.git')).not.toBeInTheDocument();
    expect(instancePreferences.get(PrefKey.FILES_SHOW_HIDDEN)).toBe(false);
  });

  it('offers no toggle where the host cannot switch the filter', () => {
    render(
      <SimpleFileManager
        typeId={TYPE_ID}
        filterDefinitions={getAllFilterDefinitions()}
        enabledFilters={[FilterName.HIDDEN]}
      />,
    );
    expect(screen.queryByText('.git')).not.toBeInTheDocument();
    expect(screen.queryByTestId('file-manager-toggle-hidden-button')).not.toBeInTheDocument();
  });
});

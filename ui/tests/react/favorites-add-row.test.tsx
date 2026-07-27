import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';

const ACTIVE = 'c82a1115-2f20-52e0-aa2a-4658898b5873';

const h = vi.hoisted(() => ({
  createFolder: vi.fn(() => Promise.resolve({})),
  addFavorite: vi.fn(() => Promise.resolve({})),
  activeEntity: null as { displayName: string } | null,
  activeEntityTypeId: null as { type: string; id: string } | null,
  currentDock: null as { tabHash: string | null; toJSON: () => string | null } | null,
  allTabs: [] as { getKey: () => string; name: string }[],
  onPick: null as ((d: unknown) => void) | null,
}));

vi.mock('@src/hooks/use-favorites', () => ({
  useFavorites: () => ({ createFolder: h.createFolder, addFavorite: h.addFavorite }),
}));
vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ activeEntity: h.activeEntity, activeEntityTypeId: h.activeEntityTypeId }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => h.currentDock,
}));
vi.mock('@src/tabs/all-tabs-store', () => ({ getAllTabsSnapshot: () => h.allTabs }));
// Capture the picker's onPick; render its trigger so we can find the row.
vi.mock('@src/components/asset-manager/AssetPickerPopover', () => ({
  AssetPickerPopover: (p: { onPick: (d: unknown) => void }) => {
    h.onPick = p.onPick;
    return null;
  },
}));
vi.mock('@src/components/asset-manager/asset-row-helpers', () => ({
  parseTypeid: (typeid: string) => {
    const dash = typeid.indexOf('-');
    return { type: typeid.slice(0, dash), id: typeid.slice(dash + 1) };
  },
  displayLabelForTypeid: (typeid: string) => `label:${typeid}`,
}));

const { FavoritesAddRow } = await import('@src/components/favorites/FavoritesAddRow');

const render = (ui: React.ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.onPick = null;
  h.activeEntity = null;
  h.activeEntityTypeId = null;
  h.currentDock = null;
  h.allTabs = [];
});

describe('FavoritesAddRow — build into the level it sits under', () => {
  it('creates a folder into parentId — inline, not a modal', () => {
    render(<FavoritesAddRow parentId="folder-42" />);
    // Click reveals an INLINE input (no modal), typed and confirmed with Enter.
    fireEvent.click(screen.getByLabelText('New folder'));
    const input = screen.getByLabelText('New folder name');
    fireEvent.change(input, { target: { value: 'Reports' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(h.createFolder).toHaveBeenCalledWith('Reports', 'folder-42');
  });

  it('cancels folder creation on Escape without creating', () => {
    render(<FavoritesAddRow parentId="" />);
    fireEvent.click(screen.getByLabelText('New folder'));
    const input = screen.getByLabelText('New folder name');
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(h.createFolder).not.toHaveBeenCalled();
    // back to the button row
    expect(screen.getByLabelText('New folder')).toBeInTheDocument();
  });

  it('files a picked asset into parentId, mapping the descriptor', () => {
    render(<FavoritesAddRow parentId="folder-42" />);
    // onPick was captured on render.
    h.onPick?.({ typeid: 'skill-abc', posix_path: '/x/y.md' });
    expect(h.addFavorite).toHaveBeenCalledWith(
      { entityType: 'skill', entityId: 'abc', title: 'label:skill-abc', nav: { asset_ref: '/x/y.md' } },
      'folder-42',
    );
  });

  it('bookmarks the current entity into parentId when one is open', () => {
    h.activeEntity = { displayName: 'Welcome' };
    h.activeEntityTypeId = { type: 'markdown', id: ACTIVE };
    render(<FavoritesAddRow parentId="" />);

    fireEvent.click(screen.getByLabelText(/what's open/i));

    expect(h.addFavorite).toHaveBeenCalledWith(
      { entityType: 'markdown', entityId: ACTIVE, title: 'Welcome' },
      '',
    );
  });

  it('bookmarks the current DOCK when no entity is open (any view)', () => {
    h.activeEntity = null;
    h.activeEntityTypeId = null;
    h.currentDock = { tabHash: 'web_app|4098', toJSON: () => '{"viewType":"web_app","pointer":"4098"}' };
    h.allTabs = [{ getKey: () => 'web_app|4098', name: 'localhost:4098' }];
    render(<FavoritesAddRow parentId="folder-9" />);

    fireEvent.click(screen.getByLabelText(/what's open/i));

    expect(h.addFavorite).toHaveBeenCalledWith(
      {
        entityType: 'dock',
        entityId: 'web_app|4098',
        title: 'localhost:4098',
        nav: { pointer: '{"viewType":"web_app","pointer":"4098"}' },
      },
      'folder-9',
    );
  });

  it('disables the current action only when nothing is open (Home)', () => {
    h.activeEntity = null;
    h.activeEntityTypeId = null;
    h.currentDock = null; // full-bleed Home, no tab
    render(<FavoritesAddRow parentId="" />);

    const current = screen.getByLabelText(/nothing open to bookmark/i);
    expect(current).toBeDisabled();
    fireEvent.click(current);
    expect(h.addFavorite).not.toHaveBeenCalled();
  });
});

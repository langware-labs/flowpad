import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';

const ACTIVE = 'c82a1115-2f20-52e0-aa2a-4658898b5873';

const h = vi.hoisted(() => ({
  createFolder: vi.fn(() => Promise.resolve({})),
  addFavorite: vi.fn(() => Promise.resolve({})),
  onConfirm: null as ((v: string) => void) | null,
  activeEntity: null as { displayName: string } | null,
  activeEntityTypeId: null as { type: string; id: string } | null,
  onPick: null as ((d: unknown) => void) | null,
}));

vi.mock('@src/hooks/use-favorites', () => ({
  useFavorites: () => ({ createFolder: h.createFolder, addFavorite: h.addFavorite }),
}));
vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ activeEntity: h.activeEntity, activeEntityTypeId: h.activeEntityTypeId }),
}));
// Capture the prompt's onConfirm instead of rendering a modal.
vi.mock('@src/components/ui/input-prompt-modal', () => ({
  showInputPrompt: (req: { onConfirm: (v: string) => void }) => {
    h.onConfirm = req.onConfirm;
  },
}));
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
  h.onConfirm = null;
  h.onPick = null;
  h.activeEntity = null;
  h.activeEntityTypeId = null;
});

describe('FavoritesAddRow — build into the level it sits under', () => {
  it('creates a folder into parentId', () => {
    render(<FavoritesAddRow parentId="folder-42" />);
    fireEvent.click(screen.getByLabelText('New folder'));
    h.onConfirm?.('Reports');
    expect(h.createFolder).toHaveBeenCalledWith('Reports', 'folder-42');
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

  it('hides the current action when nothing is open', () => {
    h.activeEntity = null;
    h.activeEntityTypeId = null;
    render(<FavoritesAddRow parentId="" />);

    expect(screen.queryByLabelText(/what's open/i)).toBeNull();
    // folder + asset still there
    expect(screen.getByLabelText('New folder')).toBeInTheDocument();
    expect(screen.getByLabelText('Bookmark an asset')).toBeInTheDocument();
  });
});

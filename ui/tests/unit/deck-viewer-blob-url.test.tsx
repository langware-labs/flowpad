/**
 * DeckViewer — the object URL behind "Open in a new browser tab".
 *
 * The pop-out tab is opened `noopener`, so the viewer never gets a handle on it
 * and cannot hear its load or unload. The URL is therefore owned by the viewer:
 * one per loaded deck HTML, reused by every click, revoked when the HTML is
 * replaced or the viewer unmounts. Revoking only stops NEW fetches of the URL —
 * a tab that already loaded the deck keeps showing it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() } }),
}));
vi.mock('@src/components/assets/editor/AssetCollisionUI', () => ({ AssetCollisionBadge: () => null }));

import type { FSRef } from '@sdk';
import { DeckViewer } from '@src/components/assets/editor/deck/DeckViewer';

const DECK_HTML = `<html><body>${'x'.repeat(400_000)}</body></html>`;

/** A deck folder holding one HTML file and no deck.json. */
function deckFolder(html: string): FSRef {
  return {
    child: (name: string) => ({
      read: () => (name === 'deck.html' ? Promise.resolve(html) : Promise.reject(new Error('missing'))),
    }),
  } as unknown as FSRef;
}

const deck = { name: 'Roadmap', html_file: 'deck.html' } as never;

describe('DeckViewer open-in-new-tab object URL', () => {
  const live = new Map<string, Blob>();
  let created = 0;
  let opened: string[] = [];

  beforeEach(() => {
    live.clear();
    created = 0;
    opened = [];
    URL.createObjectURL = (blob: Blob) => {
      const url = `blob:deck/${++created}`;
      live.set(url, blob);
      return url;
    };
    URL.revokeObjectURL = (url: string) => void live.delete(url);
    vi.spyOn(window, 'open').mockImplementation((url) => {
      opened.push(String(url));
      return null;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const liveBytes = () => [...live.values()].reduce((sum, blob) => sum + blob.size, 0);

  async function popOut(times: number) {
    await screen.findByTestId('deck-frame');
    const button = screen.getByTitle('Open in a new browser tab');
    for (let i = 0; i < times; i++) fireEvent.click(button);
  }

  it('reuses one URL across clicks and revokes it on unmount', async () => {
    const { unmount } = render(<DeckViewer fsRef={deckFolder(DECK_HTML)} deck={deck} />);
    await popOut(10);

    expect(opened).toHaveLength(10);
    expect(new Set(opened).size).toBe(1);
    expect(live.size).toBe(1);
    expect(liveBytes()).toBe(DECK_HTML.length);

    unmount();
    expect(live.size).toBe(0);
  });

  it('allocates nothing until the deck is popped out', async () => {
    const { unmount } = render(<DeckViewer fsRef={deckFolder(DECK_HTML)} deck={deck} />);
    await screen.findByTestId('deck-frame');
    unmount();
    expect(created).toBe(0);
  });

  it('replaces the URL when the deck HTML is rebuilt', async () => {
    const { rerender } = render(<DeckViewer fsRef={deckFolder(DECK_HTML)} deck={deck} />);
    await popOut(1);

    const rebuilt = DECK_HTML.replace('<body>', '<body>v2');
    rerender(<DeckViewer fsRef={deckFolder(rebuilt)} deck={deck} />);
    await vi.waitFor(() => expect(screen.getByTestId('deck-frame').getAttribute('srcdoc')).toBe(rebuilt));
    expect(live.size).toBe(0);

    await popOut(2);
    expect(live.size).toBe(1);
    expect(liveBytes()).toBe(rebuilt.length);
    expect(opened[2]).not.toBe(opened[0]);
  });
});

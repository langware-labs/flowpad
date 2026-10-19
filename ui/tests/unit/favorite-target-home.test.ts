/**
 * The app root is bookmarkable.
 *
 * Home is full-bleed, so it is deliberately not a tab — `tabHash` and `toJSON()`
 * are both null there, and `favoriteTargetForDock` fell through that gate and
 * returned null, which is why the navigation bar drew no star on `/`. Favorite
 * identity is now its own question (`favoriteKey` / `toFavoriteJSON`), so what
 * is pinned here is the pair: the root gets a star, and what that star stores
 * restores back to the root.
 */
import { describe, expect, it, vi } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { favoriteTargetForDock } from '@src/components/favorites/favorite-target';
import { ViewType } from '@src/types/ViewType';

// The label comes from the bootstrap-loaded type registry, which a unit context
// has no copy of.
vi.mock('@src/components/graph-view/icons/iconRegistry', () => ({
  labelForType: (type: string) => (type === 'home' ? 'Home' : ''),
}));

describe('DockPointer — favorite identity is not tab identity', () => {
  it('gives the root a favorite key and pointer, though it has no tab', () => {
    const root = DockPointer.root();
    // The precondition: full-bleed ⇒ not a tab, and that null stays null.
    expect(root.tabHash).toBeNull();
    expect(root.toJSON()).toBeNull();

    expect(root.favoriteKey).toBe(`${ViewType.HOME}|`);
    expect(DockPointer.fromJSON(root.toFavoriteJSON() as string)?.isRoot).toBe(true);
  });

  it('leaves a tabbed dock on its tab identity', () => {
    const dock = new DockPointer(ViewType.EXPLORER);
    expect(dock.favoriteKey).toBe(dock.tabHash);
    expect(dock.toFavoriteJSON()).toBe(dock.toJSON());
  });

  it('refuses a dock that is neither the root nor a tab', () => {
    // A bare shell is the terminal HOST; its sessions are the tabs.
    const bare = new DockPointer(ViewType.SHELL);
    expect(bare.tabHash).toBeNull();
    expect(bare.favoriteKey).toBeNull();
    expect(bare.toFavoriteJSON()).toBeNull();
  });
});

describe('favoriteTargetForDock — the app root', () => {
  it('bookmarks the root, named from the type registry', () => {
    const ref = favoriteTargetForDock(DockPointer.root(), null, 'Bookmarked view');
    expect(ref?.entityType).toBe('dock');
    expect(ref?.entityId).toBe(`${ViewType.HOME}|`);
    // NOT the caller's fallback: the star and the menu row hand in different
    // ones, and a favorite must be named the same from both.
    expect(ref?.title).toBe('Home');
  });

  it('stores a pointer that restores to the root', () => {
    const ref = favoriteTargetForDock(DockPointer.root(), null, 'Bookmarked view');
    const restored = DockPointer.fromJSON(ref?.nav?.pointer as string);
    expect(restored?.isRoot).toBe(true);
    expect(restored?.toUrl()).toBe('/');
  });

  it('still refuses a dock that is neither the root nor a tab', () => {
    expect(favoriteTargetForDock(new DockPointer(ViewType.SHELL), null, 'Bookmarked view')).toBeNull();
  });
});

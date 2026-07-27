import { describe, expect, it, vi } from 'vitest';
import { Artifact, Bookmark, BookmarkType, dataManager } from '@sdk';
import {
  canNavigateFavorite,
  navigateToFavorite,
  pointerForFavorite,
} from '@src/navigation/favorite-nav';
import { openArtifact } from '@src/components/artifacts/open-artifact';

vi.mock('@src/components/artifacts/open-artifact', () => ({ openArtifact: vi.fn() }));

/**
 * G3 regression: a favorite pointing at a vibe ARTIFACT must be navigable. Before
 * the artifact nav arm, `RECORD_TYPE_NAV` had no `artifact` entry, so
 * `isResultNavigable` returned false and the favorite rendered disabled — clicking
 * did nothing. The arm is imperative (loads the Artifact + calls `openArtifact` →
 * git wizard → Vibe launch), so it exposes a `primaryAction`, not a pure
 * `dockPointer`.
 */
describe('favorite-nav: artifact', () => {
  const artifactFavorite = () =>
    new Bookmark({
      bookmark_type: BookmarkType.FAVORITE,
      title: 'hello world app',
      data: {
        entity_type: 'artifact',
        entity_id: '11111111-1111-4111-8111-111111111111',
        nav: { asset_ref: '' },
      },
    });

  it('is navigable', () => {
    expect(canNavigateFavorite(artifactFavorite())).toBe(true);
  });

  it('has no pure dock pointer (imperative primaryAction arm)', () => {
    // The dialog/desktop falls back to the imperative navigateToFavorite path.
    expect(pointerForFavorite(artifactFavorite())).toBeNull();
  });

  it('a favorite with no entity ref is not navigable', () => {
    const b = new Bookmark({ bookmark_type: BookmarkType.FAVORITE, title: 'x', data: {} });
    expect(canNavigateFavorite(b)).toBe(false);
  });

  it('clicking the favorite routes through openArtifact (not a plain editor dock)', async () => {
    vi.clearAllMocks();
    const artifactId = '11111111-1111-4111-8111-111111111111';
    const fakeArtifact = { id: artifactId } as Artifact;
    const getSpy = vi
      .spyOn(dataManager, 'getByTypeId')
      .mockResolvedValue(fakeArtifact as never);
    const navigation = {} as never;

    await navigateToFavorite(artifactFavorite(), navigation);

    expect(getSpy).toHaveBeenCalled();
    expect(openArtifact).toHaveBeenCalledWith(
      fakeArtifact,
      expect.objectContaining({ navigation }),
    );
    getSpy.mockRestore();
  });
});

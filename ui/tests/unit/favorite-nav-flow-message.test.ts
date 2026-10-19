import { describe, expect, it } from 'vitest';
import { Bookmark, BookmarkType } from '@sdk';
import { canNavigateFavorite, pointerForFavorite } from '@src/navigation/favorite-nav';
import { DockPointer } from '@src/navigation/DockPointer';
import { messageFavoriteRef } from '@src/components/favorites/favorite-target';

const CONV = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';

/** Saved the way `useFavorites.addFavorite` saves a ref. */
function bookmarkOf(nav: Record<string, unknown> | undefined): Bookmark {
  return new Bookmark({
    bookmark_type: BookmarkType.FAVORITE,
    title: 'please add the founding number',
    data: { entity_type: 'flow_message', entity_id: MSG, nav },
  });
}

/** A message favorite opens its conversation at the message: `/dock/conversation/<conv>/message/<msg>`. */
describe('favorite-nav: flow_message', () => {
  it('opens the standard message pointer inside its conversation', () => {
    const fav = bookmarkOf(messageFavoriteRef(MSG, CONV, 'please add the founding number').nav);
    expect(canNavigateFavorite(fav)).toBe(true);
    expect(DockPointer.parseConversationPointer(pointerForFavorite(fav)?.pointer)).toEqual({
      conversationId: CONV,
      messageId: MSG,
    });
  });

  it('a message favorite saved without its conversation is not navigable', () => {
    expect(canNavigateFavorite(bookmarkOf(undefined))).toBe(false);
  });
});

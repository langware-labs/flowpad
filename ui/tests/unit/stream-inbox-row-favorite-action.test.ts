/** A conversation row's star: offered only when the list hands the row a toggle, drawn filled when
 *  the conversation is a favorite, and never on an invitation row. */
import { describe, expect, it, vi } from 'vitest';
import { actionsFor, type ConversationFacets } from '@src/components/conversation/conversation-category';

const facets: ConversationFacets = { kind: 'direct', isInvitation: false, isArchived: false, isUnread: false };
const noop = () => {};
const ctx = { deleteLabel: 'Delete', onAccept: noop, onDecline: noop, onToggleRead: noop, onArchive: noop, onUnarchive: noop, onDelete: noop };

describe('actionsFor — favorite', () => {
  it('leads the strip, filled when starred, and toggles', () => {
    const onToggleFavorite = vi.fn();
    const [star] = actionsFor(facets, { ...ctx, isFavorited: true, onToggleFavorite });
    expect(star.key).toBe('favorite');
    expect(star.active).toBe(true);
    star.onClick();
    expect(onToggleFavorite).toHaveBeenCalledOnce();
    expect(actionsFor(facets, { ...ctx, isFavorited: false, onToggleFavorite })[0].active).toBe(false);
  });

  it('is absent with no toggle, and on an invitation row', () => {
    const keys = (f: ConversationFacets, c: object) => actionsFor(f, { ...ctx, ...c }).map((s) => s.key);
    expect(keys(facets, {})).not.toContain('favorite');
    expect(keys({ ...facets, isInvitation: true }, { onToggleFavorite: noop })).not.toContain('favorite');
  });
});

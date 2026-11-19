/**
 * The Stream Inbox's tag filter button: the tag tree with a tick per tag; the ticked tags and the open
 * tree both live in the URL (`tags=a,b`, `tag_filter=open`), so every click is one navigation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { openDock, dock } = vi.hoisted(() => {
  const dock = {
    options: {} as Record<string, string>,
    withOption: vi.fn((key: string, value: string | null) => ({ key, value })),
    withStreamInboxTags: vi.fn((tags: string[]) => ({ tags })),
  };
  return { openDock: vi.fn(), dock };
});
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openDock }, currentDock: dock }) }));
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntitiesQuery: () => ({
    data: [{ name: 'stream_inbox.support' }, { name: 'stream_inbox.support.billing' }, { name: 'stream_inbox.urgent' }],
  }),
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: undefined }) }));

import { TagFilterButton } from '@src/components/stream-inbox-view/TagFilterButton';

const BILLING = 'stream_inbox.support.billing';
const show = (options: Record<string, string>) => {
  dock.options = options;
  render(<TagFilterButton tags={(options.tags ?? '').split(',').filter(Boolean)} matches={3} />);
  return screen.getByTestId('stream-inbox-tag-filter-button');
};

describe('TagFilterButton', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('opens the tree through the URL', () => {
    const button = show({});
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('stream-inbox-tag-filter-tree')).toBeNull();
    fireEvent.click(button);
    expect(openDock).toHaveBeenCalledWith({ key: 'tag_filter', value: 'open' });
  });

  it('ticks a tag by navigating to that tag, and adds a second one', () => {
    show({ tag_filter: 'open' });
    expect(screen.queryByTestId('tag-filter-clear')).toBeNull();
    fireEvent.click(screen.getByTestId(`tag-filter-option-${BILLING}`));
    expect(openDock).toHaveBeenLastCalledWith({ tags: [BILLING] });
    cleanup();
    show({ tag_filter: 'open', tags: BILLING });
    fireEvent.click(screen.getByTestId('tag-filter-option-stream_inbox.urgent'));
    expect(openDock).toHaveBeenLastCalledWith({ tags: [BILLING, 'stream_inbox.urgent'] });
  });

  it('is lit and names its tags while a filter is on; Clear drops the filter', () => {
    const button = show({ tag_filter: 'open', tags: BILLING });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('title')).toBe('Tags: billing');
    expect((screen.getByTestId(`tag-filter-option-${BILLING}`) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('stream-inbox-tag-filter-tree').textContent).toContain('3 conversations');
    fireEvent.click(screen.getByTestId('tag-filter-clear'));
    expect(openDock).toHaveBeenLastCalledWith({ tags: [] });
  });
});

/**
 * A Stream Inbox row's tag cell: no tags → the crossed tag alone, one → its chip, more → the first + count;
 * every form opens the same quick menu through the URL (`message_tags=<id>:picker`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { openDock, dock } = vi.hoisted(() => {
  const dock = { options: {} as Record<string, string>, withOption: vi.fn((key: string, value: string) => ({ key, value })) };
  return { openDock: vi.fn(), dock };
});
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openDock }, currentDock: dock }) }));
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntitiesQuery: () => ({ data: [{ name: 'stream_inbox.support.billing', color: '#8b5cf6' }] }),
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: undefined }) }));

import { MessageTags, treeRows } from '@src/components/tags/MessageTags';
import type { FlowMessage } from '@sdk';

const cell = (tags: string[]) => {
  render(<MessageTags message={{ id: 'm1', tags } as unknown as FlowMessage} compact />);
  return screen.getByTestId('message-tags-menu');
};

describe('MessageTags compact cell', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the crossed tag alone when there are no tags', () => {
    const button = cell([]);
    expect(button.textContent).toBe('');
    expect(button.getAttribute('aria-label')).toBe('No tags — add one');
  });

  it('shows one tag by its last segment, in its colour', () => {
    const button = cell(['stream_inbox.support.billing']);
    expect(button.textContent).toBe('billing');
    expect(button.getAttribute('style')).toContain('#8b5cf6');
  });

  it('shows the first tag and a count, and opens the quick menu through the URL', () => {
    const button = cell(['stream_inbox.support.billing', 'stream_inbox.urgent', 'stream_inbox.customer.vip']);
    expect(button.textContent).toBe('billing+2');
    fireEvent.click(button);
    expect(dock.withOption).toHaveBeenCalledWith('message_tags', 'm1:picker');
    expect(openDock).toHaveBeenCalled();
  });

  it('says a failed automation on the row, only when one failed', () => {
    cell(['stream_inbox.support.bug']);
    expect(screen.queryByTestId('stream-inbox-row-failed')).toBeNull();
    cleanup();
    const queue = [{ id: 'e1', trigger_id: 't1', automation_name: 'Bug → open a ticket', tag: 'stream_inbox.support.bug', status: 'failed' }];
    const message = { id: 'm1', conversation_id: 'c1', tags: ['stream_inbox.support.bug'], message_processing: { queue } };
    render(<MessageTags message={message as unknown as FlowMessage} compact />);
    expect(screen.getByTestId('stream-inbox-row-failed').getAttribute('title')).toBe('Bug → open a ticket failed');
  });
});

describe('treeRows', () => {
  it('walks the root subtree depth-first, intermediates included', () => {
    expect(treeRows(['stream_inbox.support.billing', 'stream_inbox.sales', 'other.x'], 'stream_inbox')).toEqual([
      { name: 'stream_inbox.sales', depth: 0 },
      { name: 'stream_inbox.support', depth: 0 },
      { name: 'stream_inbox.support.billing', depth: 1 },
    ]);
  });
});
